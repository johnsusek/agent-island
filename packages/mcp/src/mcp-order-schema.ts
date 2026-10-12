import * as schema from "zod/v4";

let actionArgumentSchema = schema.union([schema.string(), schema.number()]);

let orderActionSchema = schema
  .object({
    type: schema
      .string()
      .trim()
      .min(1)
      .describe("An action name from availableActions."),
  })
  .catchall(actionArgumentSchema)
  .describe(
    'A plain action object, for example {"type":"travel","location":"town-2"}. Do not wrap it in an action field.',
  );

let agentStockAtLeastSchema = schema.object({
  kind: schema.literal("agent_stock_at_least"),
  stock: schema.string().trim().min(1),
  value: schema.number().finite(),
});

let agentStockAtMostSchema = schema.object({
  kind: schema.literal("agent_stock_at_most"),
  stock: schema.string().trim().min(1),
  value: schema.number().finite(),
});

let worldStockAtLeastSchema = schema.object({
  kind: schema.literal("world_stock_at_least"),
  stock: schema.string().trim().min(1),
  value: schema.number().finite(),
});

let worldStockAtMostSchema = schema.object({
  kind: schema.literal("world_stock_at_most"),
  stock: schema.string().trim().min(1),
  value: schema.number().finite(),
});

let atLocationSchema = schema.object({
  kind: schema.literal("at_location"),
  location: schema.string().trim().min(1),
});

let elapsedTicksSchema = schema.object({
  kind: schema.literal("elapsed_ticks_at_least"),
  ticks: schema.number().int().nonnegative(),
});

let actionUnavailableSchema = schema.object({
  kind: schema.literal("action_unavailable"),
  action: orderActionSchema.optional(),
});

let visibleEventSchema = schema.object({
  kind: schema.literal("visible_event"),
  type: schema.string().trim().min(1),
});

let orderConditionSchema = schema
  .discriminatedUnion("kind", [
    agentStockAtLeastSchema,
    agentStockAtMostSchema,
    worldStockAtLeastSchema,
    worldStockAtMostSchema,
    atLocationSchema,
    elapsedTicksSchema,
    actionUnavailableSchema,
    visibleEventSchema,
  ])
  .describe(
    "A deterministic stop or interrupt condition. Stock conditions use value, not amount.",
  );

let repeatOrderSchema = schema.object({
  kind: schema.literal("repeat"),
  action: orderActionSchema,
  until: schema.array(orderConditionSchema).optional(),
  interrupts: schema.array(orderConditionSchema).optional(),
  maxRepeats: schema.number().int().positive().optional(),
  label: schema.string().trim().min(1).optional(),
});

let sequenceOrderSchema = schema.object({
  kind: schema.literal("sequence"),
  steps: schema.array(orderActionSchema).min(1),
  interrupts: schema.array(orderConditionSchema).optional(),
  label: schema.string().trim().min(1).optional(),
});

export let orderInputSchema = schema
  .discriminatedUnion("kind", [repeatOrderSchema, sequenceOrderSchema])
  .describe(
    "A repeat order or a sequence of one or more plain availableActions objects.",
  );
