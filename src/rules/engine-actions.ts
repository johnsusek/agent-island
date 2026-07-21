import {
  checkAction,
  hasTag,
  type ActionCheck,
  type ActionParam,
  type Args,
  type Entity,
  type EntityTargetMatch,
  type KernelWorld,
  type Rule,
} from "./kernel.js";
import {
  chebyshev,
  compass,
  knownTokens,
  knows,
  movementApplicable,
  tokenNameAt,
  type MovementActionName,
  type Space,
} from "./space.js";

// An action intent: the action name plus its arguments. Arguments are open so a
// rule-defined action can carry whatever params it declares.
export interface ActionInput {
  type: string;
  [arg: string]: unknown;
}

export interface ActionDescriptor {
  name: string;
  kind: "movement" | "stock" | "give";
  description: string;
  params: ActionParam[];
  // Extra names that resolve to this same action; see ActionRule.aliases.
  aliases?: string[];
}

export interface AvailableAction {
  name: string;
  applicable: boolean;
  unavailableReason?: string;
  addedTick?: number;
  isNew?: boolean;
  description?: string;
  params?: ActionParam[];
  options?: ActionOption[];
  argOptions?: Args[];
  paramOptions?: ActionOptionsByParam;
}

export interface EntityTargetOption {
  id: string;
  label: string;
  tags: string[];
  distance?: number;
  direction?: string;
}

export type ActionOption = string | EntityTargetOption;
export type ActionOptionsByParam = Record<string, ActionOption[]>;

type EnumActionParam = Extract<ActionParam, { type: "enum" }>;
type EntityActionParam = Extract<ActionParam, { type: "entity" }>;
type ActionChoiceValue = string | number;

interface ActionChoice {
  value: ActionChoiceValue;
  option: ActionOption;
}

interface ActionChoiceSet {
  name: string;
  required: boolean;
  choices: ActionChoice[];
}

interface ActionAvailability {
  applicable: boolean;
  options?: ActionOption[];
  argOptions?: Args[];
  paramOptions?: ActionOptionsByParam;
  unavailableReason?: string;
}

export interface EngineActionContext {
  world: KernelWorld;
  space: Space;
  rules: Rule[];
  actionIntroTick: Map<string, number>;
  actionRegistry(): ActionDescriptor[];
  entity(id: string): Entity;
  displayName(id: string): string;
  stockpilableStockNames(): string[];
  terrainAt(x: number, y: number): string | undefined;
}

export function intentArgs(action: ActionInput): Args {
  let out: Args = {};
  for (let [key, value] of Object.entries(action))
    if (
      key !== "type" &&
      (typeof value === "string" || typeof value === "number")
    )
      out[key] = value;
  return out;
}

export function isMovementActionName(name: string): name is MovementActionName {
  return name === "travel" || name === "explore" || name === "scan";
}

export function actionCanStart(
  context: EngineActionContext,
  actorId: string,
  action: ActionInput | undefined,
) {
  if (!action) return false;
  let spec = findAction(context, action.type);
  if (!spec) return false;
  let args = intentArgs(action);
  try {
    validateActionArgs(context, actorId, spec, action);
    if (spec.kind === "movement")
      return movementCanStart(context, actorId, action.type, args);
    if (spec.kind === "give") return giveCanStart(context, actorId, args);
    return stockActionCheck(context, actorId, spec.name, args).applicable;
  } catch {
    return false;
  }
}

export function validateActionArgs(
  context: EngineActionContext,
  actorId: string,
  spec: ActionDescriptor,
  action: Record<string, unknown>,
) {
  for (let param of spec.params) {
    let value = action[param.name];
    if (value === undefined || value === "") {
      if (param.required) throw new Error(`${spec.name} needs ${param.name}.`);
      continue;
    }

    if (param.type === "string") {
      if (typeof value !== "string")
        throw new Error(`${spec.name} ${param.name} must be text.`);
      continue;
    }

    if (param.type === "enum") {
      if (typeof value !== "string")
        throw new Error(`${spec.name} ${param.name} must be text.`);
      let allowed =
        param.from === "stockpilable"
          ? context.stockpilableStockNames()
          : (param.values ?? []);
      if (!allowed.includes(value))
        throw new Error(
          `${value} is not a valid ${param.name} for ${spec.name}.`,
        );
      continue;
    }

    if (typeof value !== "string")
      throw new Error(`${spec.name} ${param.name} must be an entity id.`);
    let valid = entityTargetOptions(context, actorId, param).some(
      (option) => option.id === value,
    );
    if (!valid)
      throw new Error(
        `${value} is not a valid ${param.name} for ${spec.name}.`,
      );
  }
}

export function listAvailableActions(
  context: EngineActionContext,
  actorId: string,
  sinceTick: number,
  includeActionDetails = true,
): AvailableAction[] {
  return context.actionRegistry().map((spec): AvailableAction => {
    let applicable: boolean;
    let options: ActionOption[] | undefined;
    let argOptions: Args[] | undefined;
    let paramOptions: ActionOptionsByParam | undefined;
    let unavailableReason: string | undefined;
    if (spec.kind === "movement") {
      let availability = movementActionAvailability(context, actorId, spec);
      applicable = availability.applicable;
      options = availability.options;
      argOptions = availability.argOptions;
      paramOptions = availability.paramOptions;
    } else if (spec.kind === "give") {
      let availability = giveActionAvailability(context, actorId, spec);
      applicable = availability.applicable;
      options = availability.options;
      argOptions = availability.argOptions;
      paramOptions = availability.paramOptions;
      unavailableReason = availability.unavailableReason;
    } else {
      let availability = stockActionAvailability(context, actorId, spec);
      applicable = availability.applicable;
      options = availability.options;
      argOptions = availability.argOptions;
      paramOptions = availability.paramOptions;
      unavailableReason = availability.unavailableReason;
    }
    let addedTick = context.actionIntroTick.get(spec.name);
    let isNew = addedTick !== undefined && addedTick >= sinceTick;
    let condensed: AvailableAction = {
      name: spec.name,
      applicable,
      unavailableReason,
      ...(addedTick !== undefined ? { addedTick, isNew } : {}),
    };
    if (!applicable && !isNew) {
      // A blocked action still earns its description inside the teaching
      // window (the first observation), so a character learns what a verb it
      // cannot use yet actually does - not just why it is blocked. Later
      // slimmed wakes drop it like every other detail.
      if (includeActionDetails) condensed.description = spec.description;
      return condensed;
    }
    let action: AvailableAction = {
      ...condensed,
      options,
      argOptions,
      paramOptions,
    };
    if (includeActionDetails || isNew) {
      action.description = spec.description;
      action.params = spec.params;
    }
    return action;
  });
}

function findAction(
  context: EngineActionContext,
  name: string,
): ActionDescriptor | undefined {
  return context.actionRegistry().find((action) => action.name === name);
}

function movementCanStart(
  context: EngineActionContext,
  actorId: string,
  type: string,
  args: Args,
) {
  if (!isMovementActionName(type)) return false;
  try {
    return movementApplicable(context.space, context.world, actorId, type, {
      location: typeof args.location === "string" ? args.location : undefined,
      direction:
        typeof args.direction === "string" ? args.direction : undefined,
      terrain: typeof args.terrain === "string" ? args.terrain : undefined,
    });
  } catch {
    return false;
  }
}

function movementActionAvailability(
  context: EngineActionContext,
  actorId: string,
  spec: ActionDescriptor,
): ActionAvailability {
  if (!isMovementActionName(spec.name)) return { applicable: false };
  if (spec.name === "travel") {
    let options = knownTokens(
      context.space,
      actorId,
      context.entity(actorId).pos!,
      context.world.tick,
    )
      .map((token) => token.name)
      .filter((location) =>
        movementCanStart(context, actorId, spec.name, { location }),
      );
    return {
      applicable: options.length > 0,
      options,
      paramOptions: { location: options },
    };
  }

  let directionParam = spec.params.find(isDirectionParam);
  let options = [...(directionParam?.values ?? [])].filter((direction) =>
    movementCanStart(context, actorId, spec.name, { direction }),
  );
  return {
    applicable: options.length > 0,
    options,
    paramOptions: { direction: options },
  };
}

function isEntityActionParam(param: ActionParam): param is EntityActionParam {
  return param.type === "entity";
}

// A resource the actor is carrying and could spare (above its floor).
function givableStocks(
  context: EngineActionContext,
  actorId: string,
): string[] {
  let stocks = context.entity(actorId).stocks;
  return context.stockpilableStockNames().filter((name) => {
    let stock = stocks[name];
    return stock !== undefined && stock.value - stock.min > 0;
  });
}

// give can start as long as the actor carries the named resource and the named
// recipient is a character - distance is fine, since give walks to them.
function giveCanStart(
  context: EngineActionContext,
  actorId: string,
  args: Args,
): boolean {
  let item = typeof args.item === "string" ? args.item : "";
  if (!givableStocks(context, actorId).includes(item)) return false;
  let target = typeof args.target === "string" ? args.target : "";
  let recipient = context.world.entities[target];
  return Boolean(
    recipient && recipient.id !== actorId && hasTag(recipient, "agent"),
  );
}

function giveActionAvailability(
  context: EngineActionContext,
  actorId: string,
  spec: ActionDescriptor,
): ActionAvailability {
  let carried = givableStocks(context, actorId);
  let targetParam = spec.params.find(isEntityActionParam);
  let targets = targetParam
    ? entityTargetOptions(context, actorId, targetParam)
    : [];
  let applicable = carried.length > 0 && targets.length > 0;
  let unavailableReason = applicable
    ? undefined
    : carried.length === 0
      ? "you are carrying nothing that can be handed over"
      : "there is no other character to give to";
  return {
    applicable,
    paramOptions: { target: targets, item: carried },
    unavailableReason,
  };
}

function isEnumActionParam(param: ActionParam): param is EnumActionParam {
  return param.type === "enum";
}

function isDirectionParam(param: ActionParam): param is EnumActionParam {
  return isEnumActionParam(param) && param.name === "direction";
}

function choiceSetForParam(
  context: EngineActionContext,
  actorId: string,
  param: ActionParam,
): ActionChoiceSet | null {
  if (param.type === "enum") {
    let values =
      param.from === "stockpilable"
        ? context.stockpilableStockNames()
        : (param.values ?? []);
    return {
      name: param.name,
      required: param.required === true,
      choices: values.map((value) => ({
        value,
        option: value,
      })),
    };
  }
  if (isEntityActionParam(param))
    return {
      name: param.name,
      required: param.required === true,
      choices: entityTargetOptions(context, actorId, param).map((option) => ({
        value: option.id,
        option,
      })),
    };
  return null;
}

function choiceSetsForAction(
  context: EngineActionContext,
  actorId: string,
  spec: ActionDescriptor,
): ActionChoiceSet[] {
  let choiceSets: ActionChoiceSet[] = [];
  for (let param of spec.params) {
    let choiceSet = choiceSetForParam(context, actorId, param);
    if (choiceSet) choiceSets.push(choiceSet);
  }
  return choiceSets;
}

function unsupportedRequiredParams(
  spec: ActionDescriptor,
  choiceSets: ActionChoiceSet[],
): ActionParam[] {
  let supportedNames = new Set(choiceSets.map((choiceSet) => choiceSet.name));
  return spec.params.filter(
    (param) => param.required === true && !supportedNames.has(param.name),
  );
}

function actionArgCombinations(choiceSets: ActionChoiceSet[]): Args[] {
  let combinations: Args[] = [{}];
  for (let choiceSet of choiceSets) {
    let nextCombinations: Args[] = choiceSet.required
      ? []
      : combinations.map((args) => ({ ...args }));
    for (let args of combinations)
      for (let choice of choiceSet.choices)
        nextCombinations.push({ ...args, [choiceSet.name]: choice.value });
    combinations = nextCombinations;
  }
  return combinations;
}

function paramOptionsFromArgs(
  choiceSets: ActionChoiceSet[],
  validArgs: Args[],
): ActionOptionsByParam | undefined {
  let optionsByParam: ActionOptionsByParam = {};
  for (let choiceSet of choiceSets) {
    let validValues = new Set(
      validArgs
        .map((args) => args[choiceSet.name])
        .filter((value) => value !== undefined),
    );
    let options = choiceSet.choices
      .filter((choice) => validValues.has(choice.value))
      .map((choice) => choice.option);
    if (options.length || choiceSet.required)
      optionsByParam[choiceSet.name] = options;
  }
  return Object.keys(optionsByParam).length ? optionsByParam : undefined;
}

function stockActionAvailability(
  context: EngineActionContext,
  actorId: string,
  spec: ActionDescriptor,
): ActionAvailability {
  let choiceSets = choiceSetsForAction(context, actorId, spec);
  let unsupported = unsupportedRequiredParams(spec, choiceSets);
  if (unsupported.length)
    return {
      applicable: false,
      unavailableReason: `${spec.name} needs ${unsupported
        .map((param) => param.name)
        .join(", ")}.`,
    };

  if (choiceSets.length === 0) {
    let availability = stockActionCheck(context, actorId, spec.name, {});
    return {
      applicable: availability.applicable,
      unavailableReason: availability.unavailableReason,
    };
  }

  let validArgs: Args[] = [];
  let sampleReason: string | undefined;
  for (let args of actionArgCombinations(choiceSets)) {
    let check = stockActionCheck(context, actorId, spec.name, args);
    if (check.applicable) validArgs.push(args);
    else sampleReason ??= check.unavailableReason;
  }
  let paramOptions = paramOptionsFromArgs(choiceSets, validArgs);
  let options =
    choiceSets.length === 1 ? paramOptions?.[choiceSets[0].name] : undefined;
  let argOptions = choiceSets.length > 1 ? validArgs : undefined;

  return {
    applicable: validArgs.length > 0,
    unavailableReason: validArgs.length > 0 ? undefined : sampleReason,
    options,
    argOptions,
    paramOptions,
  };
}

function targetTags(match?: EntityTargetMatch): string[] {
  let tags: string[] = [];
  if (match?.tag) tags.push(match.tag);
  if (match?.tags) tags.push(...match.tags);
  return tags;
}

function matchesTargetQuery(
  context: EngineActionContext,
  actorId: string,
  target: Entity,
  match: EntityTargetMatch = {},
): boolean {
  if (!match.includeSelf && target.id === actorId) return false;

  let requiredTags = targetTags(match);
  if (requiredTags.some((tag) => !hasTag(target, tag))) return false;
  if (match.kind !== undefined && target.kind !== match.kind) return false;

  let actorPos = context.entity(actorId).pos;
  if (match.range !== undefined) {
    if (!actorPos || !target.pos) return false;
    let distance = chebyshev(
      actorPos.x,
      actorPos.y,
      target.pos.x,
      target.pos.y,
    );
    if (distance > match.range) return false;
  }

  if (match.visible !== false) {
    if (!target.pos) return false;
    if (!knows(context.space, actorId, target.pos.x, target.pos.y))
      return false;
  }

  return true;
}

function entityTargetOptions(
  context: EngineActionContext,
  actorId: string,
  param: EntityActionParam,
): EntityTargetOption[] {
  let actorPos = context.entity(actorId).pos;
  return Object.values(context.world.entities)
    .filter((target) =>
      matchesTargetQuery(context, actorId, target, param.match),
    )
    .map((target) => {
      let option: EntityTargetOption = {
        id: target.id,
        label: context.displayName(target.id),
        tags: [...target.tags],
      };
      if (actorPos && target.pos) {
        option.distance = chebyshev(
          actorPos.x,
          actorPos.y,
          target.pos.x,
          target.pos.y,
        );
        option.direction = compass(
          target.pos.x - actorPos.x,
          target.pos.y - actorPos.y,
        );
      }
      return option;
    })
    .sort(
      (left, right) =>
        (left.distance ?? Number.MAX_SAFE_INTEGER) -
          (right.distance ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id),
    );
}

function stockActionCheck(
  context: EngineActionContext,
  actorId: string,
  actionName: string,
  args: Args,
): ActionCheck {
  try {
    return checkAction(
      context.world,
      context.rules,
      actorId,
      actionName,
      args,
      context.terrainAt,
      (x, y) => {
        let name = tokenNameAt(context.space.grid, { x, y });
        return name ? context.world.entities[name] : undefined;
      },
    );
  } catch (error) {
    return { applicable: false, unavailableReason: (error as Error).message };
  }
}
