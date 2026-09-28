export type AgentRole = "character" | "director";
export type DetailView = "activity" | "memory";
export type Engine = "claude" | "codex";
export type Filter = "all" | "running" | "idle" | "dead";

export interface Usage {
  cachedInputTokens: number;
  completedRuns: number;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  uncachedInputTokens: number;
}

export interface LogEntry {
  kind?: string;
  label: string;
  raw?: string;
  text: string;
  timestamp?: number | null;
}

export interface LogFile {
  engine?: string;
  file: string;
  mtime: number;
  name?: string | null;
  size: number;
}

export interface LogView extends LogFile {
  completed?: boolean;
  effort?: string | null;
  entries: LogEntry[];
  logCount?: number;
  model?: string | null;
  pending?: { label: string; since: number | null }[];
  startedAt: number;
  usage?: Usage;
}

export interface Seat {
  action?: string | null;
  alive: boolean | null;
  batchId?: string | null;
  cadenceTicks?: number | null;
  controllerConnected: boolean;
  engine?: Engine | null;
  effort?: string | null;
  id: string;
  log: LogView | null;
  logCount: number;
  live?: Record<string, unknown> | null;
  maxTicks?: number | null;
  memory: string | null;
  model?: string | null;
  name: string;
  nextLaunchTick?: number | null;
  pending?: string | null;
  pid?: number | null;
  persona: string;
  processRunning: boolean;
  role: AgentRole;
  seatDir: string;
  startedAt: number | null;
  startTick?: number | null;
  state: string;
  stopTick?: number | null;
  updatedAt: number | null;
  usage: { run: Usage; total: Usage };
}

export interface WorldSummary {
  activeCount: number;
  alive: number;
  dead: number;
  elapsedMs: number;
  ended: boolean;
  gmConnected: boolean;
  idle: number;
  lastTickAt: number | null;
  lastTickError: string | null;
  mintedRules: number;
  parkedCount: number;
  paused: boolean;
  realTimeMs: number;
  ruleCount: number;
  runStartedAt: number;
  running: boolean;
  scenario: string;
  tick: number;
  tokensPerMinute: number;
  unsavedRules: number;
  usage: Usage;
  worldId: string;
}

export interface RunSummary {
  runId?: string;
  [key: string]: unknown;
}

export interface ScenarioSummary {
  active: string[];
  gm?: Record<string, unknown>;
  scenarios?: {
    active: boolean;
    description: string;
    name: string;
  }[];
  [key: string]: unknown;
}

export interface OperatorSnapshot {
  error: string | null;
  online: boolean;
  raw: Record<string, unknown>;
  refreshedAt: number;
  runs: RunSummary[];
  scenarios: ScenarioSummary;
  seats: Seat[];
  world: WorldSummary;
}

export interface OperatorOptions {
  help: boolean;
  home: string;
  monochrome: boolean;
  refreshMs: number;
  selectedName: string | null;
  snapshot: boolean;
  url: string;
}

export interface OperatorPaths {
  batchesDir: string;
  charactersDir: string;
  directorBatchesDir: string;
  directorPersonasDir: string;
  directorsDir: string;
  runsDir: string;
  scenariosDir: string;
  stateFile: string;
}

export interface OperatorState {
  detailScrollY: number;
  detailView: DetailView;
  filter: Filter;
  follow: boolean;
  notice: { kind: "error"; text: string; until: number } | null;
  query: string;
  selectedId: string | null;
  selectedLog: LogView | null;
  selectedSeat: Seat | null;
  snapshot: OperatorSnapshot | null;
  visibleSeats: Seat[];
}

export interface OperatorRuntime {
  logView(seatDir: string): LogView | null;
  refresh(): Promise<OperatorSnapshot>;
}
