// A zod mirror of the Rule DSL in kernel.ts, for validating scenario JSON that
// never passes through the TypeScript compiler. Each schema constant is
// annotated with the kernel.ts type it mirrors (z.ZodType<T>), so if a schema
// stops matching its type, tsc catches the drift here instead of it silently
// accepting a shape the kernel would reject (or misinterpret) at tick time.
//
// The one gotcha this exists to catch: EntitySel's `colocated` field accepts
// the bare-tag shorthand (`{colocated: "food"}`), but Cond's `colocated` field
// does not - inside requires/when/fizzleWhen it must be the object form
// (`{colocated: {tag: "food"}}`). That asymmetry is real (see kernel.ts:66-75
// vs 189-208), not a schema oversight.
import * as z from "zod/v4";

import type {
  Rule,
  Cond,
  Cmp,
  Expr,
  Effect,
  EntitySel,
  ColocatedSel,
  ColocatedPick,
  NameRef,
  TagRef,
  NoiseKey,
  Aggregate,
  SpawnSpec,
  ActionParam,
  EntityTargetMatch,
  Selector,
  SetConflict,
  DerivedRule,
  FlowRule,
  ThresholdRule,
  WatchRule,
  MapEdge,
  TransitionRule,
  EventRule,
  ActionRule,
  Modifier,
} from "./kernel.js";

const NameRefSchema: z.ZodType<NameRef> = z.union([
  z.string(),
  z.object({ arg: z.string() }),
]);

// TagRef adds the runtime form NameRef lacks: `{nameOf: <EntitySel>}` resolves
// an entity's id into the tag string at evaluation time (the ownership
// primitive). Lazy because it reaches EntitySelSchema, declared further down.
const TagRefSchema: z.ZodType<TagRef> = z.lazy(() =>
  z.union([
    z.string(),
    z.object({ arg: z.string() }),
    z.object({ nameOf: EntitySelSchema }),
  ]),
);

const NoiseKeySchema: z.ZodType<NoiseKey> = z.union([z.string(), z.number()]);

const CmpSchema: z.ZodType<Cmp> = z.union([
  z.literal("gte"),
  z.literal("gt"),
  z.literal("lte"),
  z.literal("lt"),
  z.literal("eq"),
]);

const MapEdgeSchema: z.ZodType<MapEdge> = z.enum([
  "north",
  "east",
  "south",
  "west",
]);

const ColocatedPickSchema: z.ZodType<ColocatedPick> = z.union([
  z.literal("nearest"),
  z.object({ lowest: NameRefSchema }),
  z.object({ highest: NameRefSchema }),
  z.object({ random: z.array(NoiseKeySchema) }),
]);

// Cond, EntitySel, ColocatedSel, Aggregate, and Expr all reach each other
// (Cond.colocated -> ColocatedSel.where -> Cond; Expr.if -> Cond; etc.), so
// they're declared with z.lazy() and can reference one another regardless of
// declaration order - the callbacks only run once every const below exists.
const CondSchema: z.ZodType<Cond> = z.lazy(() =>
  z.union([
    z.object({ cmp: CmpSchema, left: ExprSchema, right: ExprSchema }),
    // Strict so `{tag, kind}` errors loudly instead of one key being silently
    // stripped by whichever arm matches first - a cond tests exactly one of
    // the two (combine with `all` to test both).
    z.strictObject({ tag: TagRefSchema, of: EntitySelSchema.optional() }),
    z.strictObject({ kind: TagRefSchema, of: EntitySelSchema.optional() }),
    // Object form ONLY - this is the asymmetry with EntitySelSchema below.
    z.object({ colocated: ColocatedSelSchema }),
    z.object({
      nearTerrain: z.object({
        type: z.union([z.string(), z.array(z.string())]),
        range: z.number().optional(),
      }),
    }),
    z.object({ atMapEdge: z.object({ edge: MapEdgeSchema }) }),
    z.object({ stockpilable: NameRefSchema }),
    z.object({
      stockpileAccepts: NameRefSchema,
      of: EntitySelSchema.optional(),
    }),
    z.object({ all: z.array(CondSchema) }),
    z.object({ any: z.array(CondSchema) }),
    z.object({ not: CondSchema }),
  ]),
);

const EntitySelSchema: z.ZodType<EntitySel> = z.lazy(() =>
  z.union([
    // "self" | "world" | string collapse to plain string.
    z.string(),
    z.object({ arg: z.string() }),
    // Bare-tag shorthand allowed HERE, unlike CondSchema's colocated.
    z.object({ colocated: z.union([TagRefSchema, ColocatedSelSchema]) }),
  ]),
);

// tag/kind are individually optional on spatial and aggregate matchers, but at
// least one must be present - the kernel throws on an empty matcher at run
// time; the refine catches it at authoring time instead.
const needsTagOrKind = (v: { tag?: unknown; kind?: unknown }) =>
  v.tag !== undefined || v.kind !== undefined;

const ColocatedSelSchema: z.ZodType<ColocatedSel> = z.lazy(() =>
  z
    .object({
      tag: TagRefSchema.optional(),
      kind: TagRefSchema.optional(),
      where: CondSchema.optional(),
      range: z.number().optional(),
      other: z.boolean().optional(),
      pick: ColocatedPickSchema.optional(),
    })
    .refine(needsTagOrKind, { message: 'needs a "tag" or a "kind"' }),
);

const AggregateSchema: z.ZodType<Aggregate> = z.lazy(() =>
  z
    .object({
      tag: TagRefSchema.optional(),
      kind: TagRefSchema.optional(),
      stock: NameRefSchema.optional(),
      where: CondSchema.optional(),
      near: z.number().optional(),
      other: z.boolean().optional(),
    })
    .refine(needsTagOrKind, { message: 'needs a "tag" or a "kind"' }),
);

const ExprSchema: z.ZodType<Expr> = z.lazy(() =>
  z.union([
    z.number(),
    z.object({ stock: NameRefSchema, of: EntitySelSchema.optional() }),
    z.object({ headroom: NameRefSchema, of: EntitySelSchema.optional() }),
    z.object({ tick: z.literal(true) }),
    z.object({ arg: z.string() }),
    z.object({ posX: EntitySelSchema }),
    z.object({ posY: EntitySelSchema }),
    z.object({
      lookup: z.object({
        on: z.string(),
        table: z.record(z.string(), z.number()),
      }),
    }),
    z.object({ add: z.array(ExprSchema) }),
    z.object({ sub: z.array(ExprSchema) }),
    z.object({ mul: z.array(ExprSchema) }),
    z.object({ min: z.array(ExprSchema) }),
    z.object({ max: z.array(ExprSchema) }),
    z.object({ floor: ExprSchema }),
    z.object({ ceil: ExprSchema }),
    z.object({ round: ExprSchema }),
    z.object({ abs: ExprSchema }),
    z.object({ sqrt: ExprSchema }),
    z.object({ sign: ExprSchema }),
    z.object({ div: z.tuple([ExprSchema, ExprSchema]) }),
    z.object({ mod: z.tuple([ExprSchema, ExprSchema]) }),
    z.object({ pow: z.tuple([ExprSchema, ExprSchema]) }),
    z.object({ clamp: z.tuple([ExprSchema, ExprSchema, ExprSchema]) }),
    z.object({ noise: z.array(NoiseKeySchema) }),
    z.object({ rand: z.tuple([ExprSchema, ExprSchema]).rest(NoiseKeySchema) }),
    z.object({ if: z.tuple([CondSchema, ExprSchema, ExprSchema]) }),
    z.object({ count: AggregateSchema }),
    z.object({ sum: AggregateSchema }),
    z.object({ avg: AggregateSchema }),
    z.object({ max_of: AggregateSchema }),
    z.object({ min_of: AggregateSchema }),
  ]),
);

const SpawnSpecSchema: z.ZodType<SpawnSpec> = z.lazy(() =>
  z.object({
    id: NameRefSchema.optional(),
    idPrefix: z.string().optional(),
    kind: TagRefSchema.optional(),
    tags: z.array(TagRefSchema).optional(),
    stocks: z
      .record(
        z.string(),
        z.object({
          value: z.number(),
          min: z.number().optional(),
          max: z.number().optional(),
          icon: z.string().optional(),
          color: z.string().optional(),
        }),
      )
      .optional(),
    at: z
      .union([
        EntitySelSchema,
        z.object({
          x: ExprSchema,
          y: ExprSchema,
          skipOffMap: z.boolean().optional(),
          snapToPassable: z.boolean().optional(),
        }),
      ])
      .optional(),
    text: z.string().optional(),
  }),
);

const EffectSchema: z.ZodType<Effect> = z.lazy(() =>
  z.union([
    z.object({
      adjust: z.object({
        target: NameRefSchema,
        of: EntitySelSchema.optional(),
        by: ExprSchema,
        channel: z.string().optional(),
        as: z.string().optional(),
      }),
    }),
    z.object({
      set: z.object({
        target: NameRefSchema,
        of: EntitySelSchema.optional(),
        to: ExprSchema,
      }),
    }),
    z.object({
      transfer: z.object({
        from: z.object({
          stock: NameRefSchema,
          of: EntitySelSchema.optional(),
          as: z.string().optional(),
        }),
        to: z.object({
          stock: NameRefSchema,
          of: EntitySelSchema.optional(),
          as: z.string().optional(),
          maxIfMissing: z.number().optional(),
        }),
        amount: ExprSchema,
      }),
    }),
    z.object({
      tag: z.object({
        of: EntitySelSchema.optional(),
        add: TagRefSchema.optional(),
        remove: TagRefSchema.optional(),
      }),
    }),
    z.object({
      kind: z.object({
        of: EntitySelSchema.optional(),
        set: TagRefSchema,
      }),
    }),
    z.object({ clearAction: z.object({ of: EntitySelSchema.optional() }) }),
    z.object({ spawn: SpawnSpecSchema }),
    z.object({ destroy: z.object({ of: EntitySelSchema.optional() }) }),
    z.object({
      move: z.object({
        of: EntitySelSchema.optional(),
        dx: ExprSchema,
        dy: ExprSchema,
      }),
    }),
    z.object({
      moveToward: z.object({
        of: EntitySelSchema.optional(),
        target: EntitySelSchema,
        steps: ExprSchema.optional(),
      }),
    }),
    z.object({
      moveTo: z.object({
        of: EntitySelSchema.optional(),
        to: z.union([
          EntitySelSchema,
          z.object({ x: ExprSchema, y: ExprSchema }),
        ]),
      }),
    }),
    z.object({
      regenerate: z.object({
        seed: ExprSchema,
      }),
    }),
    z.object({
      growWorld: z.object({
        by: ExprSchema,
        direction: MapEdgeSchema.optional(),
      }),
    }),
    z.object({
      setTerrain: z.object({
        of: EntitySelSchema.optional(),
        to: NameRefSchema,
      }),
    }),
    z.object({
      reveal: z.object({
        to: EntitySelSchema.optional(),
        around: EntitySelSchema.optional(),
        radius: ExprSchema.optional(),
      }),
    }),
    z.object({
      forEach: z.object({
        colocated: z.union([TagRefSchema, ColocatedSelSchema]),
        do: z.array(EffectSchema),
      }),
    }),
  ]),
);

const SelectorSchema: z.ZodType<Selector> = z
  .object({ tag: z.string().optional(), kind: z.string().optional() })
  .refine(needsTagOrKind, { message: 'needs a "tag" or a "kind"' });

const SetConflictSchema: z.ZodType<SetConflict> = z.union([
  z.literal("override"),
  z.literal("highest"),
  z.literal("lowest"),
]);

const EntityTargetMatchSchema: z.ZodType<EntityTargetMatch> = z.object({
  tag: z.string().optional(),
  tags: z.array(z.string()).optional(),
  kind: z.string().optional(),
  range: z.number().optional(),
  visible: z.boolean().optional(),
  includeSelf: z.boolean().optional(),
});

const ActionParamSchema: z.ZodType<ActionParam> = z.union([
  z.object({
    name: z.string(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    type: z.literal("string"),
  }),
  z.object({
    name: z.string(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    type: z.literal("enum"),
    values: z.array(z.string()).optional(),
    from: z.literal("stockpilable").optional(),
  }),
  z.object({
    name: z.string(),
    required: z.boolean().optional(),
    description: z.string().optional(),
    type: z.literal("entity"),
    match: EntityTargetMatchSchema.optional(),
  }),
]);

// RulePacing isn't exported from kernel.ts, so its fields are inlined on each
// rule schema below rather than composed from a shared constant.
//
// These stay bare `z.number()` (no `.min`/`.max`/`.nonnegative`) on purpose:
// this schema mirrors the DSL's *types*, and the value bounds (chance in
// [0,1], cooldown >= 0) plus the phase-applicability rules (chance/cooldown
// only on flow/threshold/watch/transition/event, never derived) live in one
// place - kernel.ts's `validateRule`, which produces the friendly authoring
// messages `gm-guards.test.ts` pins. Both entry points that accept a rule
// (engine `addRule`/`patchRule` and scenario loading in scenarios.ts) run
// `validateRule` alongside this schema, so those bounds are still enforced.
const rulePacingShape = {
  priority: z.number().optional(),
  chance: z.number().optional(),
  cooldown: z.number().optional(),
};

// These eight are annotated with `satisfies` rather than `:` so each stays a
// concrete ZodObject (preserving the literal `phase`/`kind` field zod's
// discriminatedUnion needs to read below) while still being checked against
// its kernel.ts type.
const DerivedRuleSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  phase: z.literal("derived"),
  each: SelectorSchema.optional(),
  target: NameRefSchema,
  value: ExprSchema,
  priority: z.number().optional(),
}) satisfies z.ZodType<DerivedRule>;

const FlowRuleSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  phase: z.literal("flow"),
  each: SelectorSchema.optional(),
  target: NameRefSchema,
  rate: ExprSchema,
  channel: z.string().optional(),
  when: CondSchema.optional(),
  ...rulePacingShape,
}) satisfies z.ZodType<FlowRule>;

const ThresholdRuleSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  phase: z.literal("threshold"),
  each: SelectorSchema.optional(),
  when: CondSchema.optional(),
  do: z.array(EffectSchema),
  conflict: SetConflictSchema.optional(),
  ...rulePacingShape,
}) satisfies z.ZodType<ThresholdRule>;

const WatchRuleSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  phase: z.literal("watch"),
  each: SelectorSchema.optional(),
  when: CondSchema,
  emit: z.object({
    type: z.string(),
    text: z.string().optional(),
    global: z.boolean().optional(),
    interrupt: z.string().optional(),
  }),
  ...rulePacingShape,
}) satisfies z.ZodType<WatchRule>;

const TransitionRuleSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  phase: z.literal("transition"),
  each: SelectorSchema.optional(),
  when: CondSchema,
  do: z.array(EffectSchema),
  emit: z
    .object({
      type: z.string(),
      text: z.string().optional(),
      global: z.boolean().optional(),
    })
    .optional(),
  ...rulePacingShape,
}) satisfies z.ZodType<TransitionRule>;

const EventRuleSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  phase: z.literal("event"),
  on: z.string(),
  when: CondSchema.optional(),
  do: z.array(EffectSchema),
  ...rulePacingShape,
}) satisfies z.ZodType<EventRule>;

const ActionRuleSchema = z.object({
  id: z.string(),
  kind: z.literal("action"),
  duration: z.number(),
  requires: CondSchema.optional(),
  requireReason: z.string().optional(),
  fizzleWhen: CondSchema.optional(),
  fizzleReason: z.string().optional(),
  do: z.array(EffectSchema),
  emit: z
    .object({ type: z.string(), global: z.boolean().optional() })
    .optional(),
  description: z.string().optional(),
  params: z.array(ActionParamSchema).optional(),
  aliases: z.array(z.string()).optional(),
}) satisfies z.ZodType<ActionRule>;

const ModifierSchema = z.object({
  id: z.string(),
  description: z.string().optional(),
  kind: z.literal("modifier"),
  channel: z.string(),
  op: z.union([z.literal("scale"), z.literal("add")]),
  value: ExprSchema,
  when: CondSchema.optional(),
  priority: z.number().optional(),
}) satisfies z.ZodType<Modifier>;

// Two discriminated unions, not one - Rule dispatches on either "phase" (six
// values) or "kind" ("action" | "modifier"), and z.discriminatedUnion needs a
// single shared key per group. This still gives per-branch error messages
// instead of the generic "no union member matched" a plain z.union produces.
const PhaseRuleSchema = z.discriminatedUnion("phase", [
  DerivedRuleSchema,
  FlowRuleSchema,
  ThresholdRuleSchema,
  WatchRuleSchema,
  TransitionRuleSchema,
  EventRuleSchema,
]);

const KindRuleSchema = z.discriminatedUnion("kind", [
  ActionRuleSchema,
  ModifierSchema,
]);

export const RuleSchema: z.ZodType<Rule> = z.union([
  PhaseRuleSchema,
  KindRuleSchema,
]);

// A failed parse against a schema this deeply nested in unions reports one
// sub-issue per union branch tried, recursively - for a single bad field that
// can be hundreds of issues, nearly all of them noise ("this branch didn't
// match either, because ITS unrelated fields are undefined"). This walks that
// tree, rebuilding each issue's full path (zod's per-branch `path` is relative
// to that branch, not the root), and keeps only the issues that point at a
// value that was actually present but the wrong shape - which is what every
// real authoring mistake (like the colocated shorthand gotcha) looks like.
interface PathedIssue {
  path: string;
  message: string;
}

function collectIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: PropertyKey[],
  out: PathedIssue[],
): void {
  for (let issue of issues) {
    let path = [...prefix, ...issue.path];
    let branches = (issue as { errors?: z.core.$ZodIssue[][] }).errors;
    // An empty `errors` array (a discriminated union's "no matching
    // discriminator", not "tried N branches") is still a leaf, not something
    // to recurse into - `if (branches)` alone is wrong since [] is truthy.
    if (branches && branches.length > 0)
      for (let branch of branches) collectIssues(branch, path, out);
    else out.push({ path: path.join("."), message: issue.message });
  }
}

// Walks `root` by a path reconstructed from zod issues, to tell "this union
// branch failed because the field it needed simply isn't part of the input"
// (noise - every non-matching branch says this about its own fields) apart
// from "this field IS present, just the wrong shape" (the actual defect).
function valueAtPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  if (path === "") return cur;
  for (let key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function formatRuleError(
  error: z.core.$ZodError,
  root: unknown,
): string {
  let all: PathedIssue[] = [];
  collectIssues(error.issues, [], all);
  let seen = new Set<string>();
  let specific = all.filter((issue) => {
    if (valueAtPath(root, issue.path) === undefined) return false;
    let key = `${issue.path}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let picked = specific.length > 0 ? specific : all.slice(0, 5);
  return picked
    .map((issue) => `  - ${issue.path || "(root)"}: ${issue.message}`)
    .join("\n");
}

// Throws a readable error (see formatRuleError) rather than the raw ZodError
// a bare RuleSchema.parse() would produce.
export function assertValidRule(rule: unknown): asserts rule is Rule {
  let result = RuleSchema.safeParse(rule);
  if (result.success) return;
  let id =
    rule &&
    typeof rule === "object" &&
    typeof (rule as { id?: unknown }).id === "string"
      ? (rule as { id: string }).id
      : "<unknown>";
  throw new Error(
    `rule "${id}" does not match the Rule schema:\n${formatRuleError(result.error, rule)}`,
  );
}
