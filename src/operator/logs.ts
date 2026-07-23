import fs from "node:fs";
import path from "node:path";

import { jsonlTailOffset, readJsonlAppend } from "./log-reader.js";
import type { LogEntry, LogFile, LogView, Usage } from "./types.js";

type EventRecord = Record<string, any>;
type LogSummary = LogFile & {
  completed: boolean;
  effort: string | null;
  model: string | null;
  name: string | null;
  role: string | null;
  startedAt: number;
  usage: Usage;
};

interface LogStoreOptions {
  latestMaxViewBytes?: number;
  maxViewBytes?: number | null;
}

interface UsageCacheState {
  claudeMessages: Usage;
  claudeResult: Usage | null;
  completed: boolean;
  mtime: number;
  offset: number;
  size: number;
  summary: LogSummary;
  usage: Usage;
}

interface ViewCacheState {
  entries: LogEntry[];
  mtime: number;
  offset: number;
  pending: Map<string, { label: string; since: number | null }>;
  size: number;
  startOffset: number;
  view: LogView;
}

export function zeroUsage(): Usage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    durationMs: 0,
    completedRuns: 0,
  };
}

export function addUsage(target: Usage, source: Partial<Usage> | null): Usage {
  for (let key of Object.keys(target) as (keyof Usage)[])
    target[key] += number(source?.[key]);
  return target;
}

export function createLogStore(options: LogStoreOptions = {}) {
  let usageCache = new Map<string, UsageCacheState>();
  let latestViewCache = new Map<string, ViewCacheState>();
  let historyViewCache = new Map<string, ViewCacheState>();
  let historyBySeat = new Map<
    string,
    { signature: string; view: LogView | null }
  >();
  let maxViewBytes = options.maxViewBytes ?? null;
  let latestMaxViewBytes = options.latestMaxViewBytes ?? 2_000_000;

  function inspectSeat(seatDir: string, since = 0) {
    let logs = discoverLogs(path.join(seatDir, "logs"));
    let totalUsage = zeroUsage();
    let runUsage = zeroUsage();
    let runs: LogSummary[] = [];

    for (let log of logs) {
      let summary = usageSummary(log, usageCache);
      addUsage(totalUsage, summary.usage);
      if (summary.startedAt >= since) addUsage(runUsage, summary.usage);
      runs.push(summary);
    }

    let latestLog = logs[0] ?? null;
    let latest = latestLog
      ? logView(latestLog, latestViewCache, latestMaxViewBytes)
      : null;
    return { logs, latest, runs, totalUsage, runUsage };
  }

  function inspectView(seatDir: string): LogView | null {
    let logs = discoverLogs(path.join(seatDir, "logs"));
    let signature = logs
      .map((log) => `${log.file}:${log.size}:${log.mtime}`)
      .join("\n");
    let existing = historyBySeat.get(seatDir);
    if (signature === existing?.signature) return existing.view;
    let views = logs.map((log) => logView(log, historyViewCache, maxViewBytes));
    let view = combinedLogView(views);
    historyBySeat.set(seatDir, { signature, view });
    return view;
  }

  return { inspectSeat, inspectView };
}

export function discoverLogs(logsDir: string): LogFile[] {
  let logs: LogFile[] = [];
  for (let engineEntry of safeDirectories(logsDir)) {
    let engineDir = path.join(logsDir, engineEntry.name);
    for (let fileEntry of safeFiles(engineDir)) {
      if (
        !fileEntry.name.startsWith("play-") ||
        !fileEntry.name.endsWith(".jsonl")
      )
        continue;
      let file = path.join(engineDir, fileEntry.name);
      let stat = statOr(file);
      if (!stat) continue;
      logs.push({
        file,
        engine: engineEntry.name,
        size: stat.size,
        mtime: stat.mtimeMs,
      });
    }
  }
  return logs.sort((left, right) => right.mtime - left.mtime);
}

function usageSummary(
  log: LogFile,
  cache: Map<string, UsageCacheState>,
): LogSummary {
  let state = cache.get(log.file);
  if (
    !state ||
    log.size < state.size ||
    (log.size === state.size && log.mtime !== state.mtime)
  )
    state = newUsageState(log);
  let appended = readJsonlAppend(log.file, state.offset, log.size);
  for (let record of appended.records)
    applyUsageEvent(state, log.engine, record.event);
  state.offset = appended.offset;
  state.size = log.size;
  state.mtime = log.mtime;
  let usage =
    log.engine === "claude"
      ? (state.claudeResult ?? state.claudeMessages)
      : state.usage;
  let metadata = readMetadata(log.file);
  state.summary = {
    ...log,
    usage: { ...usage },
    completed: state.completed,
    name: metadata.name ?? null,
    role: metadata.role ?? null,
    model: metadata.model ?? null,
    effort: metadata.effort ?? null,
    startedAt: dateValue(metadata.startedAt) ?? log.mtime,
  };
  cache.set(log.file, state);
  return state.summary;
}

function logView(
  log: LogFile,
  cache: Map<string, ViewCacheState>,
  maxBytes: number | null,
): LogView {
  let state = cache.get(log.file);
  if (
    !state ||
    log.size < state.size ||
    (log.size === state.size && log.mtime !== state.mtime) ||
    (maxBytes !== null && log.size - state.startOffset > maxBytes * 2)
  )
    state = newViewState(log, maxBytes);
  let appended = readJsonlAppend(log.file, state.offset, log.size);
  for (let record of appended.records) {
    let rendered =
      log.engine === "codex"
        ? renderCodex(record.event, state.pending)
        : renderClaude(record.event, state.pending);
    for (let entry of rendered)
      state.entries.push({ ...entry, raw: record.raw });
  }
  state.offset = appended.offset;
  state.size = log.size;
  state.mtime = log.mtime;
  let metadata = readMetadata(log.file);
  state.view = {
    ...log,
    entries: state.entries,
    pending: [...state.pending.values()],
    model: metadata.model ?? null,
    effort: metadata.effort ?? null,
    startedAt: dateValue(metadata.startedAt) ?? log.mtime,
  };
  cache.set(log.file, state);
  return state.view;
}

function newUsageState(log: LogFile): UsageCacheState {
  let usage = zeroUsage();
  return {
    claudeMessages: zeroUsage(),
    claudeResult: null,
    completed: false,
    mtime: 0,
    offset: 0,
    size: 0,
    summary: {
      ...log,
      completed: false,
      effort: null,
      model: null,
      name: null,
      role: null,
      startedAt: log.mtime,
      usage,
    },
    usage,
  };
}

function applyUsageEvent(
  state: UsageCacheState,
  engine: string | undefined,
  event: EventRecord,
): void {
  if (engine === "codex" && event.type === "turn.completed") {
    addUsage(state.usage, codexUsage(event.usage));
    state.usage.completedRuns += 1;
    state.completed = true;
    return;
  }
  if (engine !== "claude") return;
  if (event.type === "assistant" && event.message?.usage)
    addUsage(state.claudeMessages, claudeUsage(event.message.usage));
  if (event.type !== "result") return;
  state.claudeResult = claudeUsage(event.usage);
  state.claudeResult.costUsd = number(event.total_cost_usd);
  state.claudeResult.durationMs = number(event.duration_ms);
  state.claudeResult.completedRuns = 1;
  state.completed = !event.is_error;
}

function newViewState(log: LogFile, maxBytes: number | null): ViewCacheState {
  let startOffset = jsonlTailOffset(log.file, log.size, maxBytes);
  return {
    entries: [],
    mtime: 0,
    offset: startOffset,
    pending: new Map(),
    size: 0,
    startOffset,
    view: {
      ...log,
      entries: [],
      startedAt: log.mtime,
    },
  };
}

function combinedLogView(views: LogView[]): LogView | null {
  let latest = views[0] ?? null;
  if (!latest) return null;
  let chronological = views
    .slice()
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        left.mtime - right.mtime ||
        left.file.localeCompare(right.file),
    );
  return {
    ...latest,
    entries: chronological.flatMap((view) => view.entries),
    logCount: views.length,
  };
}

export function renderCodex(
  event: EventRecord,
  pending = new Map<string, { label: string; since: number | null }>(),
): LogEntry[] {
  let item = event.item ?? {};
  let timestamp = dateValue(event.timestamp);
  if (event.type === "item.started") {
    let label = itemLabel(item);
    if (!label) return [];
    pending.set(item.id ?? label, { label, since: timestamp });
    return [
      { kind: "tool", label: `→ ${label}`, text: itemInput(item), timestamp },
    ];
  }
  if (event.type === "turn.completed") {
    return [
      {
        kind: "meta",
        label: "usage",
        text: usageText(codexUsage(event.usage)),
        timestamp,
      },
    ];
  }
  if (event.type !== "item.completed") return [];
  pending.delete(item.id ?? itemLabel(item));
  if (item.type === "agent_message")
    return [{ kind: "text", label: "agent", text: item.text ?? "", timestamp }];
  if (item.type === "reasoning")
    return [
      { kind: "think", label: "think", text: item.text ?? "", timestamp },
    ];
  if (item.type === "mcp_tool_call") {
    return [
      {
        kind: item.error ? "error" : "result",
        label: `← ${itemLabel(item)}`,
        text: resultText(item.result ?? item.error),
        timestamp,
      },
    ];
  }
  if (item.type === "command_execution") {
    return [
      {
        kind: item.exit_code ? "error" : "result",
        label: "← shell",
        text: item.aggregated_output ?? "",
        timestamp,
      },
    ];
  }
  if (item.type === "file_change")
    return [
      { kind: "file", label: "file", text: fileChangeText(item), timestamp },
    ];
  if (item.type === "web_search")
    return [
      { kind: "file", label: "search", text: item.query ?? "", timestamp },
    ];
  return [];
}

export function renderClaude(
  event: EventRecord,
  pending = new Map<string, { label: string; since: number | null }>(),
): LogEntry[] {
  let timestamp = dateValue(event.timestamp);
  if (event.type === "result") {
    let status = event.is_error ? "error" : "complete";
    return [
      {
        kind: event.is_error ? "error" : "meta",
        label: status,
        text: claudeResultText(event),
        timestamp,
      },
    ];
  }
  if (event.type !== "assistant" && event.type !== "user") return [];
  let entries: LogEntry[] = [];
  for (let block of event.message?.content ?? []) {
    if (block.type === "thinking")
      entries.push({
        kind: "think",
        label: "think",
        text: block.thinking ?? "",
        timestamp,
      });
    else if (block.type === "text")
      entries.push({
        kind: event.type === "assistant" ? "text" : "result",
        label: event.type === "assistant" ? "agent" : "result",
        text: block.text ?? "",
        timestamp,
      });
    else if (block.type === "tool_use") {
      pending.set(block.id ?? block.name, {
        label: block.name,
        since: timestamp,
      });
      entries.push({
        kind: "tool",
        label: `→ ${block.name}`,
        text: jsonText(block.input),
        timestamp,
      });
    } else if (block.type === "tool_result") {
      pending.delete(block.tool_use_id);
      entries.push({
        kind: block.is_error ? "error" : "result",
        label: "← result",
        text: resultText(block.content),
        timestamp,
      });
    }
  }
  return entries;
}

function itemLabel(item: EventRecord): string | null {
  if (item.type === "mcp_tool_call") return item.tool ?? "MCP";
  if (item.type === "command_execution") return "shell";
  if (item.type === "file_change") return "file";
  if (item.type === "web_search") return "search";
  return null;
}

function itemInput(item: EventRecord): string {
  if (item.type === "mcp_tool_call")
    return jsonText(item.arguments ?? item.input ?? {});
  if (item.type === "command_execution") return item.command ?? "";
  if (item.type === "file_change") return fileChangeText(item);
  return item.query ?? "";
}

function fileChangeText(item: EventRecord): string {
  return (item.changes ?? [])
    .map(
      (change: EventRecord) =>
        `${change.kind ?? "change"} ${change.path ?? ""}`,
    )
    .join(", ");
}

function resultText(result: any): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result))
    return result
      .map((part: unknown) => resultText(part))
      .filter(Boolean)
      .join("\n");
  if (typeof result.text === "string") return result.text;
  let contentText: string = resultText(result.content);
  if (contentText) return contentText;
  if (result.structured_content !== undefined)
    return jsonText(result.structured_content);
  if (result.structuredContent !== undefined)
    return jsonText(result.structuredContent);
  return jsonText(result);
}

function claudeResultText(event: EventRecord): string {
  let details = [usageText(claudeUsage(event.usage))];
  if (number(event.duration_ms))
    details.push(`${Math.round(number(event.duration_ms) / 1000)}s`);
  if (number(event.total_cost_usd))
    details.push(`$${number(event.total_cost_usd).toFixed(3)}`);
  if (event.errors?.length) details.push(event.errors.join("; "));
  return details.filter(Boolean).join(" · ");
}

function codexUsage(usageValue: EventRecord | null | undefined): Usage {
  let inputTokens = number(usageValue?.input_tokens);
  let cachedInputTokens = number(usageValue?.cached_input_tokens);
  return {
    ...zeroUsage(),
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens: number(usageValue?.output_tokens),
    reasoningTokens: number(usageValue?.reasoning_output_tokens),
  };
}

function claudeUsage(usageValue: EventRecord | null | undefined): Usage {
  let fresh = number(usageValue?.input_tokens);
  let cacheWrite = number(usageValue?.cache_creation_input_tokens);
  let cacheRead = number(usageValue?.cache_read_input_tokens);
  return {
    ...zeroUsage(),
    inputTokens: fresh + cacheWrite + cacheRead,
    cachedInputTokens: cacheRead,
    uncachedInputTokens: fresh + cacheWrite,
    outputTokens: number(usageValue?.output_tokens),
  };
}

function usageText(usage: Usage): string {
  return `in ${compact(usage.inputTokens)} (${compact(usage.uncachedInputTokens)} fresh) · out ${compact(usage.outputTokens)}`;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function readMetadata(file: string): EventRecord {
  try {
    return JSON.parse(fs.readFileSync(`${file}.meta`, "utf8"));
  } catch {
    return {};
  }
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? "");
  }
}

function safeDirectories(directory: string): fs.Dirent[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
}

function safeFiles(directory: string): fs.Dirent[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile());
  } catch {
    return [];
  }
}

function statOr(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dateValue(value: unknown): number | null {
  if (!value) return null;
  let parsed = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}
