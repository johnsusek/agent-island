import type { ActionInput } from "./engine-actions.js";

export type OrderStatus =
  "running" | "completed" | "blocked" | "interrupted" | "cancelled";

export type StockOrderCondition =
  | {
      kind: "agent_stock_at_least" | "agent_stock_at_most";
      stock: string;
      value: number;
    }
  | {
      kind: "world_stock_at_least" | "world_stock_at_most";
      stock: string;
      value: number;
    };

export type OrderCondition =
  | StockOrderCondition
  | { kind: "at_location"; location: string }
  | { kind: "elapsed_ticks_at_least"; ticks: number }
  | { kind: "action_unavailable"; action?: ActionInput }
  | { kind: "visible_event"; type: string };

export type OrderInput =
  | {
      kind: "repeat";
      action: ActionInput;
      until?: OrderCondition[];
      interrupts?: OrderCondition[];
      maxRepeats?: number;
      label?: string;
    }
  | {
      kind: "sequence";
      steps: ActionInput[];
      interrupts?: OrderCondition[];
      label?: string;
    };

export interface OrderState {
  id: string;
  input: OrderInput;
  status: OrderStatus;
  startedTick: number;
  updatedTick: number;
  cursor: number;
  stepIndex: number;
  repeats: number;
  reason?: string;
}

export interface OrderView {
  id: string;
  kind: OrderInput["kind"];
  status: OrderStatus;
  summary: string;
  startedTick: number;
  updatedTick: number;
  stepIndex?: number;
  steps?: number;
  repeats?: number;
  reason?: string;
}

export function normalizeOrderInput(input: unknown): OrderInput {
  let order = objectInput(input, "Order must be one object.");
  let kind = stringField(order, "kind");

  if (kind === "repeat") {
    let action = normalizeAction(order.action);
    let until = conditionList(order.until, "until");
    let interrupts = conditionList(order.interrupts, "interrupts");
    let maxRepeats = optionalPositiveInteger(order.maxRepeats, "maxRepeats");
    let label = optionalText(order.label, "label");
    return { kind, action, until, interrupts, maxRepeats, label };
  }

  if (kind === "sequence") {
    if (!Array.isArray(order.steps) || order.steps.length === 0)
      throw new Error("sequence order needs one or more steps.");
    let steps = order.steps.map((step) => normalizeAction(step));
    let interrupts = conditionList(order.interrupts, "interrupts");
    let label = optionalText(order.label, "label");
    return { kind, steps, interrupts, label };
  }

  throw new Error('Order kind must be "repeat" or "sequence".');
}

export function orderSummary(order: OrderInput): string {
  if (order.label) return order.label;
  if (order.kind === "repeat") return `repeat ${actionSummary(order.action)}`;
  return order.steps.map(actionSummary).join(" -> ");
}

function actionSummary(action: ActionInput): string {
  let args = Object.entries(action)
    .filter(([key]) => key !== "type")
    .map(([key, value]) => `${key}:${String(value)}`)
    .join(", ");
  return args ? `${action.type}(${args})` : action.type;
}

function normalizeAction(input: unknown): ActionInput {
  let action = objectInput(input, "Action must be one object.");
  let type = stringField(action, "type");
  let normalized: ActionInput = { type };
  for (let [key, value] of Object.entries(action)) {
    if (key === "type") continue;
    if (typeof value !== "string" && typeof value !== "number")
      throw new Error(`Action argument "${key}" must be text or a number.`);
    normalized[key] = value;
  }
  return normalized;
}

function conditionList(input: unknown, field: string): OrderCondition[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new Error(`${field} must be a list.`);
  return input.map((condition) => normalizeCondition(condition));
}

function normalizeCondition(input: unknown): OrderCondition {
  let condition = objectInput(input, "Condition must be one object.");
  let kind = stringField(condition, "kind");

  if (
    kind === "agent_stock_at_least" ||
    kind === "agent_stock_at_most" ||
    kind === "world_stock_at_least" ||
    kind === "world_stock_at_most"
  ) {
    return {
      kind,
      stock: stringField(condition, "stock"),
      value: numberField(condition, "value"),
    };
  }

  if (kind === "at_location")
    return { kind, location: stringField(condition, "location") };

  if (kind === "elapsed_ticks_at_least") {
    let ticks = numberField(condition, "ticks");
    if (!Number.isInteger(ticks) || ticks < 0)
      throw new Error(
        "elapsed_ticks_at_least ticks must be a non-negative integer.",
      );
    return { kind, ticks };
  }

  if (kind === "action_unavailable") {
    let action =
      condition.action === undefined
        ? undefined
        : normalizeAction(condition.action);
    return { kind, action };
  }

  if (kind === "visible_event")
    return { kind, type: stringField(condition, "type") };

  throw new Error(`Unknown order condition "${kind}".`);
}

function objectInput(input: unknown, error: string): Record<string, unknown> {
  // LLM clients (smaller models especially) often pass nested objects as a
  // JSON string instead of a real object. Accept and parse that form.
  if (typeof input === "string") {
    let text = input.trim();
    if (!text.startsWith("{")) throw new Error(error);
    try {
      input = JSON.parse(text);
    } catch {
      throw new Error(error);
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error(error);
  return input as Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, field: string): string {
  let value = input[field];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${field} must be text.`);
  return value.trim();
}

function numberField(input: Record<string, unknown>, field: string): number {
  let value = input[field];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a finite number.`);
  return value;
}

function optionalText(input: unknown, field: string): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || !input.trim())
    throw new Error(`${field} must be text.`);
  return input.trim();
}

function optionalPositiveInteger(
  input: unknown,
  field: string,
): number | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "number" || !Number.isInteger(input) || input <= 0)
    throw new Error(`${field} must be a positive integer.`);
  return input;
}
