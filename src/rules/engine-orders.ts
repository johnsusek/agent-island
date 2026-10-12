import type { Stock } from "@agent-island/core/kernel";
import type { ActionInput } from "./engine-actions.js";
import {
  normalizeOrderInput,
  orderSummary,
  type OrderCondition,
  type OrderState,
  type OrderView,
  type StockOrderCondition,
} from "./orders.js";

interface OrderEvent {
  type: string;
  agentId?: string;
  text?: string;
  wake?: "routine" | "decision";
}

export interface EngineOrderContext {
  orders: Map<string, OrderState>;
  tick(): number;
  nextSeq(): number;
  livingIds(): string[];
  requireAgent(agentId: string): void;
  isAlive(agentId: string): boolean;
  agentHasAction(agentId: string): boolean;
  displayName(agentId: string): string;
  stocksOf(agentId: string): Record<string, Stock>;
  worldStocks(): Record<string, Stock>;
  locationOf(agentId: string): string | undefined;
  commitPrimitiveIntent(
    agentId: string,
    action: ActionInput,
    wake: "routine",
  ): { approaching?: boolean };
  visibleEventsSince(agentId: string, cursor: number): { type: string }[];
  actionCanStart(agentId: string, action: ActionInput | undefined): boolean;
  push(event: OrderEvent): void;
}

export function setEngineOrder(
  context: EngineOrderContext,
  agentId: string,
  input: unknown,
) {
  context.requireAgent(agentId);
  if (!context.isAlive(agentId))
    throw new Error(`${agentId} is no longer active.`);
  let order = normalizeOrderInput(input);
  cancelRunningOrder(context, agentId, "replaced");
  let state: OrderState = {
    id: `${agentId}-${context.tick()}-${context.nextSeq()}`,
    input: order,
    status: "running",
    startedTick: context.tick(),
    updatedTick: context.tick(),
    cursor: context.nextSeq(),
    stepIndex: 0,
    repeats: 0,
  };
  context.orders.set(agentId, state);
  context.push({
    type: "order_started",
    agentId,
    text: `${context.displayName(agentId)} takes order: ${orderSummary(order)}.`,
    // Self-caused bookkeeping, not a wake-worthy event - the caller just
    // issued this order and already knows. Without this, it would preempt
    // the routine-progress sleep-through that set_order/wait_for_change
    // rely on, waking the actor before the order does anything.
    wake: "routine",
  });
  state.cursor = context.nextSeq();
  advanceOrder(context, agentId, state);
  return { accepted: true, order: orderView(context, agentId) };
}

export function cancelEngineOrder(
  context: EngineOrderContext,
  agentId: string,
) {
  context.requireAgent(agentId);
  cancelRunningOrder(context, agentId, "cancelled");
  return { accepted: true, order: orderView(context, agentId) };
}

export function getEngineOrder(context: EngineOrderContext, agentId: string) {
  context.requireAgent(agentId);
  return { order: orderView(context, agentId) };
}

export function cancelRunningOrder(
  context: EngineOrderContext,
  agentId: string,
  reason: string,
) {
  let state = context.orders.get(agentId);
  if (!state || state.status !== "running") return;
  finishOrder(context, agentId, state, "cancelled", reason);
}

// An external alarm (a rule emit marked `interrupt`) ends a running order the
// same way a matched interrupt condition would - same status, same wake.
export function interruptRunningOrder(
  context: EngineOrderContext,
  agentId: string,
  reason: string,
) {
  let state = context.orders.get(agentId);
  if (!state || state.status !== "running") return;
  finishOrder(context, agentId, state, "interrupted", reason);
}

export function advanceEngineOrders(context: EngineOrderContext) {
  for (let agentId of context.livingIds()) {
    let state = context.orders.get(agentId);
    if (state?.status === "running") advanceOrder(context, agentId, state);
  }
}

export function orderView(
  context: EngineOrderContext,
  agentId: string,
): OrderView | null {
  let state = context.orders.get(agentId);
  if (!state) return null;
  let view: OrderView = {
    id: state.id,
    kind: state.input.kind,
    status: state.status,
    summary: orderSummary(state.input),
    startedTick: state.startedTick,
    updatedTick: state.updatedTick,
    reason: state.reason,
  };
  if (state.input.kind === "repeat") view.repeats = state.repeats;
  else {
    view.stepIndex = state.stepIndex;
    // The cursor alone can't be read back to a player - "step 2" of a one-step
    // order is nonsense. The total is what makes it a position.
    view.steps = state.input.steps.length;
  }
  return structuredClone(view);
}

function advanceOrder(
  context: EngineOrderContext,
  agentId: string,
  state: OrderState,
) {
  if (!context.isAlive(agentId)) {
    finishOrder(
      context,
      agentId,
      state,
      "blocked",
      "agent is no longer active",
    );
    return;
  }
  if (context.agentHasAction(agentId)) return;

  let interrupt = matchedCondition(
    context,
    agentId,
    state,
    state.input.interrupts ?? [],
  );
  if (interrupt) {
    finishOrder(context, agentId, state, "interrupted", interrupt);
    return;
  }

  if (state.input.kind === "repeat")
    advanceRepeatOrder(context, agentId, state);
  else advanceSequenceOrder(context, agentId, state);

  state.cursor = context.nextSeq();
}

function advanceRepeatOrder(
  context: EngineOrderContext,
  agentId: string,
  state: OrderState,
) {
  let input = state.input;
  if (input.kind !== "repeat") return;

  let done = matchedCondition(context, agentId, state, input.until ?? []);
  if (done) {
    finishOrder(context, agentId, state, "completed", done);
    return;
  }
  if (input.maxRepeats !== undefined && state.repeats >= input.maxRepeats) {
    finishOrder(context, agentId, state, "completed", "max repeats reached");
    return;
  }

  try {
    let outcome = context.commitPrimitiveIntent(
      agentId,
      input.action,
      "routine",
    );
    // An implicit approach committed a travel toward the target, not the action
    // itself; hold the repeat count so the action retries once the actor arrives.
    if (!outcome.approaching) state.repeats += 1;
    state.updatedTick = context.tick();
  } catch (error) {
    finishOrder(context, agentId, state, "blocked", (error as Error).message);
  }
}

function advanceSequenceOrder(
  context: EngineOrderContext,
  agentId: string,
  state: OrderState,
) {
  let input = state.input;
  if (input.kind !== "sequence") return;

  if (state.stepIndex >= input.steps.length) {
    finishOrder(context, agentId, state, "completed", "all steps completed");
    return;
  }

  let action = input.steps[state.stepIndex];
  try {
    let outcome = context.commitPrimitiveIntent(agentId, action, "routine");
    // While an implicit approach walks the actor to this step's target, keep the
    // step index put so the real action runs on arrival instead of being skipped.
    if (!outcome.approaching) state.stepIndex += 1;
    state.updatedTick = context.tick();
  } catch (error) {
    finishOrder(context, agentId, state, "blocked", (error as Error).message);
  }
}

function finishOrder(
  context: EngineOrderContext,
  agentId: string,
  state: OrderState,
  status: Exclude<OrderState["status"], "running">,
  reason: string,
) {
  state.status = status;
  state.reason = reason;
  state.updatedTick = context.tick();
  context.push({
    type: `order_${status}`,
    agentId,
    text: `${context.displayName(agentId)}'s order ${status}: ${reason}.`,
  });
}

function matchedCondition(
  context: EngineOrderContext,
  agentId: string,
  state: OrderState,
  conditions: OrderCondition[],
): string | null {
  for (let condition of conditions)
    if (conditionMatches(context, agentId, state, condition))
      return conditionSummary(condition);
  return null;
}

function conditionMatches(
  context: EngineOrderContext,
  agentId: string,
  state: OrderState,
  condition: OrderCondition,
): boolean {
  if (isStockCondition(condition)) {
    let stocks = condition.kind.startsWith("agent_")
      ? context.stocksOf(agentId)
      : context.worldStocks();
    let value = stockValue(stocks, condition.stock);
    return condition.kind.endsWith("at_least")
      ? value >= condition.value
      : value <= condition.value;
  }
  if (condition.kind === "at_location")
    return context.locationOf(agentId) === condition.location;
  if (condition.kind === "elapsed_ticks_at_least")
    return context.tick() - state.startedTick >= condition.ticks;
  if (condition.kind === "action_unavailable")
    return !context.actionCanStart(
      agentId,
      condition.action ?? nextOrderAction(state),
    );
  if (condition.kind === "visible_event")
    return context
      .visibleEventsSince(agentId, state.cursor)
      .some((event) => event.type === condition.type);
  return false;
}

function stockValue(stocks: Record<string, Stock>, stockName: string) {
  return stocks[stockName]?.value ?? Number.NaN;
}

function isStockCondition(
  condition: OrderCondition,
): condition is StockOrderCondition {
  return (
    condition.kind === "agent_stock_at_least" ||
    condition.kind === "agent_stock_at_most" ||
    condition.kind === "world_stock_at_least" ||
    condition.kind === "world_stock_at_most"
  );
}

function nextOrderAction(state: OrderState): ActionInput | undefined {
  if (state.input.kind === "repeat") return state.input.action;
  return state.input.steps[state.stepIndex];
}

function conditionSummary(condition: OrderCondition) {
  if (isStockCondition(condition))
    return `${condition.kind} ${condition.stock} ${condition.value}`;
  if (condition.kind === "at_location")
    return `at location ${condition.location}`;
  if (condition.kind === "elapsed_ticks_at_least")
    return `elapsed ${condition.ticks} ticks`;
  if (condition.kind === "action_unavailable") return "action unavailable";
  if (condition.kind === "visible_event") return `saw ${condition.type}`;
  return "condition matched";
}
