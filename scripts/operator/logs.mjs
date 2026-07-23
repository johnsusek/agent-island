import fs from "node:fs";
import path from "node:path";

export function zeroUsage() {
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

export function addUsage(target, source) {
  for (let key of Object.keys(target)) target[key] += number(source?.[key]);
  return target;
}

export function createLogStore(options = {}) {
  let usageCache = new Map();
  let viewCache = new Map();
  let maxViewBytes = options.maxViewBytes ?? 2_000_000;

  function inspectSeat(seatDir, since = 0) {
    let logs = discoverLogs(path.join(seatDir, "logs"));
    let totalUsage = zeroUsage();
    let runUsage = zeroUsage();
    let runs = [];

    for (let log of logs) {
      let summary = usageSummary(log, usageCache);
      addUsage(totalUsage, summary.usage);
      if (summary.startedAt >= since) addUsage(runUsage, summary.usage);
      runs.push(summary);
    }

    let latestLog = logs[0] ?? null;
    let latest = latestLog ? logView(latestLog, viewCache, maxViewBytes) : null;
    return { logs, latest, runs, totalUsage, runUsage };
  }

  return { inspectSeat };
}

export function discoverLogs(logsDir) {
  let logs = [];
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

function usageSummary(log, cache) {
  let existing = cache.get(log.file);
  if (existing?.size === log.size && existing?.mtime === log.mtime)
    return existing;

  let usage = zeroUsage();
  let claudeMessages = zeroUsage();
  let claudeResult = null;
  let completed = false;
  let raw = safeRead(log.file);
  for (let line of raw.split("\n")) {
    let event = parseLine(line);
    if (!event) continue;
    if (log.engine === "codex" && event.type === "turn.completed") {
      addUsage(usage, codexUsage(event.usage));
      usage.completedRuns += 1;
      completed = true;
      continue;
    }
    if (log.engine !== "claude") continue;
    if (event.type === "assistant" && event.message?.usage)
      addUsage(claudeMessages, claudeUsage(event.message.usage));
    if (event.type !== "result") continue;
    claudeResult = claudeUsage(event.usage);
    claudeResult.costUsd = number(event.total_cost_usd);
    claudeResult.durationMs = number(event.duration_ms);
    claudeResult.completedRuns = 1;
    completed = !event.is_error;
  }
  if (log.engine === "claude") usage = claudeResult ?? claudeMessages;

  let metadata = readMetadata(log.file);
  let summary = {
    ...log,
    usage,
    completed,
    name: metadata.name ?? null,
    role: metadata.role ?? null,
    model: metadata.model ?? null,
    effort: metadata.effort ?? null,
    startedAt: dateValue(metadata.startedAt) ?? log.mtime,
  };
  cache.set(log.file, summary);
  return summary;
}

function logView(log, cache, maxBytes) {
  let existing = cache.get(log.file);
  if (existing?.size === log.size && existing?.mtime === log.mtime)
    return existing;

  let raw = readTail(log.file, maxBytes);
  let entries = [];
  let pending = new Map();
  for (let line of raw.split("\n")) {
    let event = parseLine(line);
    if (!event) continue;
    let rendered =
      log.engine === "codex"
        ? renderCodex(event, pending)
        : renderClaude(event, pending);
    for (let entry of rendered) entries.push({ ...entry, raw: line });
  }
  if (entries.length > 1200) entries = entries.slice(-1200);

  let metadata = readMetadata(log.file);
  let view = {
    ...log,
    entries,
    pending: [...pending.values()],
    model: metadata.model ?? null,
    effort: metadata.effort ?? null,
    startedAt: dateValue(metadata.startedAt) ?? log.mtime,
  };
  cache.set(log.file, view);
  return view;
}

export function renderCodex(event, pending = new Map()) {
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

export function renderClaude(event, pending = new Map()) {
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
  let entries = [];
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

function itemLabel(item) {
  if (item.type === "mcp_tool_call") return item.tool ?? "MCP";
  if (item.type === "command_execution") return "shell";
  if (item.type === "file_change") return "file";
  if (item.type === "web_search") return "search";
  return null;
}

function itemInput(item) {
  if (item.type === "mcp_tool_call")
    return jsonText(item.arguments ?? item.input ?? {});
  if (item.type === "command_execution") return item.command ?? "";
  if (item.type === "file_change") return fileChangeText(item);
  return item.query ?? "";
}

function fileChangeText(item) {
  return (item.changes ?? [])
    .map((change) => `${change.kind ?? "change"} ${change.path ?? ""}`)
    .join(", ");
}

function resultText(result) {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result))
    return result
      .map((part) => resultText(part))
      .filter(Boolean)
      .join("\n");
  if (typeof result.text === "string") return result.text;
  let contentText = resultText(result.content);
  if (contentText) return contentText;
  if (result.structured_content !== undefined)
    return jsonText(result.structured_content);
  if (result.structuredContent !== undefined)
    return jsonText(result.structuredContent);
  return jsonText(result);
}

function claudeResultText(event) {
  let details = [usageText(claudeUsage(event.usage))];
  if (number(event.duration_ms))
    details.push(`${Math.round(number(event.duration_ms) / 1000)}s`);
  if (number(event.total_cost_usd))
    details.push(`$${number(event.total_cost_usd).toFixed(3)}`);
  if (event.errors?.length) details.push(event.errors.join("; "));
  return details.filter(Boolean).join(" · ");
}

function codexUsage(usageValue) {
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

function claudeUsage(usageValue) {
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

function usageText(usage) {
  return `in ${compact(usage.inputTokens)} (${compact(usage.uncachedInputTokens)} fresh) · out ${compact(usage.outputTokens)}`;
}

function compact(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

function readMetadata(file) {
  try {
    return JSON.parse(fs.readFileSync(`${file}.meta`, "utf8"));
  } catch {
    return {};
  }
}

function readTail(file, maxBytes) {
  let stat = statOr(file);
  if (!stat?.size) return "";
  let start = Math.max(0, stat.size - maxBytes);
  let length = stat.size - start;
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
    let buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseLine(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function jsonText(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value ?? "");
  }
}

function safeRead(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function safeDirectories(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }
}

function safeFiles(directory) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile());
  } catch {
    return [];
  }
}

function statOr(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dateValue(value) {
  if (!value) return null;
  let parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
