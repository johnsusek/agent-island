import type { Occupancy } from "@agent-island/core/kernel";
import type { WorldEngine } from "@agent-island/engine/engine";
import type { SpriteSpec } from "@agent-island/engine/sprite";
import type { StockSpec } from "@agent-island/engine/scenario";
import {
  buildInspection,
  type InspectQuery,
  type InspectionContext,
} from "./coordinator-inspection.js";

export interface GmSession {
  agentId: string | null;
  isGm: boolean;
}

export interface GmCommandContext {
  engine: WorldEngine;
  requireSession(sessionId: string): GmSession;
  requireGm(sessionId: string): GmSession;
  inspectionContext(): InspectionContext;
  note(message: string): void;
  scheduleSave(): void;
  scheduleRulesSave(): void;
  maybeAdvance(): void;
  wakeVisibleWaiters(): void;
  flushLog(): void;
  armBackstop(): void;
  journalCommand<T>(actor: string | null, verb: string, run: () => T): T;
}

export function createGmCommands(context: GmCommandContext) {
  function joinAsGm(sessionId: string) {
    let session = context.requireSession(sessionId);
    if (session.agentId && context.engine.isAlive(session.agentId))
      throw new Error(
        `This session controls ${session.agentId}; leave_game before directing.`,
      );
    session.isGm = true;
    context.note(`* session ${sessionId.slice(0, 8)} joined as GM`);
    context.engine.recordGm("gm_joined", "a director took the GM seat");
    return {
      status: "gm",
      ...buildInspection(context.inspectionContext()),
    };
  }

  function gmInspect(sessionId: string, query?: InspectQuery) {
    context.requireGm(sessionId);
    return buildInspection(context.inspectionContext(), query);
  }

  function gmRules(sessionId: string) {
    context.requireGm(sessionId);
    return { rules: context.engine.getRules() };
  }

  function tryDryRun(id: string) {
    try {
      return context.engine.dryRunRule(id);
    } catch {
      return undefined;
    }
  }

  function dryRunSuffix(report?: { warnings: string[] }) {
    let count = report?.warnings.length ?? 0;
    if (count === 0) return "";
    return ` (dry-run: ${count} warning${count === 1 ? "" : "s"})`;
  }

  // Common epilogue for every GM mutation: log it to the GM feed, persist,
  // let the clock catch up if everyone's now parked, and hand back the
  // result. rulesChanged (default true) gates the separate rules-file save -
  // false for edits (a bare stock poke, a tile paint) that don't touch
  // anything rules.json persists.
  function finishGmEdit<T>(
    message: string,
    result: T,
    opts: { rulesChanged?: boolean } = {},
  ): T {
    context.note(message);
    context.scheduleSave();
    if (opts.rulesChanged ?? true) context.scheduleRulesSave();
    // A GM edit is a wake-worthy happening in its own right: another GM
    // session parked in wait_for_world on the audit stream (the resident
    // director watching an operator's console edits, or vice versa) must see
    // it now, not at its next tick or timeout.
    context.wakeVisibleWaiters();
    context.maybeAdvance();
    return result;
  }

  function gmAddRule(sessionId: string, rule: any) {
    context.requireGm(sessionId);
    let result = context.engine.addRule(rule);
    let dryRun = tryDryRun(result.id);
    return finishGmEdit(`* GM added rule ${result.id}${dryRunSuffix(dryRun)}`, {
      ok: true,
      ...result,
      ...(dryRun ? { dryRun } : {}),
    });
  }

  // Preview a rule without adding it: the same validation add_rule runs, then
  // a dry run of the live rules with this one added (or swapped in for the
  // live rule with its id). Read-only, so it skips the GM-edit epilogue - no
  // feed line, no save, no wake.
  function gmDryRunRule(sessionId: string, rule: any, ticks?: number) {
    context.requireGm(sessionId);
    let dryRun = context.engine.dryRunCandidateRule(rule, ticks);
    return { ok: true, id: rule.id as string, dryRun };
  }

  function gmRemoveRule(sessionId: string, id: string) {
    context.requireGm(sessionId);
    let result = context.engine.removeRule(id);
    return finishGmEdit(`* GM removed rule ${result.id}`, {
      ok: true,
      ...result,
    });
  }

  function gmPatchRule(sessionId: string, id: string, fields: any) {
    context.requireGm(sessionId);
    let rule = context.engine.patchRule(id, fields);
    let dryRun = tryDryRun(id);
    return finishGmEdit(`* GM patched rule ${id}${dryRunSuffix(dryRun)}`, {
      ok: true,
      rule,
      ...(dryRun ? { dryRun } : {}),
    });
  }

  function gmSetStock(
    sessionId: string,
    entityId: string,
    stock: string,
    value: number,
    bounds?: { min?: number; max?: number },
    visual?: { icon?: string; color?: string },
  ) {
    context.requireGm(sessionId);
    let result = context.engine.setStock(
      entityId,
      stock,
      value,
      bounds,
      visual,
    );
    return finishGmEdit(
      `* GM set ${entityId}.${stock} = ${result.value}`,
      { ok: true, entityId, stock, value: result },
      { rulesChanged: false },
    );
  }

  function gmSetStockDefault(
    sessionId: string,
    stock: string,
    spec: StockSpec,
  ) {
    context.requireGm(sessionId);
    let result = context.engine.setStockDefault(stock, spec);
    return finishGmEdit(
      `* GM set default ${stock} for all characters (seeded ${result.seeded.length})`,
      { ok: true, ...result },
    );
  }

  function gmAnnounce(sessionId: string, text: string, audience?: string[]) {
    context.requireGm(sessionId);
    let result = context.journalCommand(null, "announce", () =>
      context.engine.announce(text, audience),
    );
    context.note(`* GM announced: ${text}`);
    context.wakeVisibleWaiters();
    context.flushLog();
    context.armBackstop();
    context.scheduleSave();
    return result;
  }

  function gmSpawnEntity(
    sessionId: string,
    spec: {
      id: string;
      kind?: string;
      tags?: string[];
      stocks?: Record<
        string,
        {
          value: number;
          min?: number;
          max?: number;
          icon?: string;
          color?: string;
        }
      >;
      pos?: { x: number; y: number };
      occupancy?: Occupancy;
      reveal?: boolean;
      icon?: string;
      color?: string;
      text?: string;
      allowImpassable?: boolean;
    },
  ) {
    context.requireGm(sessionId);
    let { entity, onMap, revealedTo } = context.engine.spawnEntity(spec);
    return finishGmEdit(
      `* GM spawned entity ${spec.id}${entity.occupancy ? (onMap ? " (on map)" : " (tile occupied - off map)") : ""}`,
      { ok: true, entity, onMap, revealedTo },
    );
  }

  function gmEditEntity(
    sessionId: string,
    id: string,
    edit: { text?: string; addTags?: string[]; removeTags?: string[] },
  ) {
    context.requireGm(sessionId);
    let entity = context.engine.editEntity(id, edit);
    return finishGmEdit(
      `* GM edited entity ${id}`,
      { ok: true, entity },
      { rulesChanged: false },
    );
  }

  function gmRegisterTerrain(
    sessionId: string,
    name: string,
    spec: {
      passable?: boolean;
      moveCost?: number;
      visual?: { sprite?: SpriteSpec; color?: string; icon?: string };
    },
  ) {
    context.requireGm(sessionId);
    let result = context.engine.registerTerrain(name, spec);
    return finishGmEdit(`* GM registered terrain ${name}`, {
      ok: true,
      ...result,
    });
  }

  function gmRegisterKindVisual(
    sessionId: string,
    kind: string,
    visual: {
      sprite?: SpriteSpec;
      icon?: string;
      color?: string;
      label?: string;
    },
  ) {
    context.requireGm(sessionId);
    let result = context.engine.registerKindVisual(kind, visual);
    return finishGmEdit(`* GM registered visual for ${result.kind}`, {
      ok: true,
      ...result,
    });
  }

  function gmSetTerrain(
    sessionId: string,
    at: { x: number; y: number }[],
    to: string,
  ) {
    context.requireGm(sessionId);
    let result = context.engine.setTerrainTiles(at, to);
    return finishGmEdit(
      `* GM painted ${result.changed} tile(s) to ${to}`,
      { ok: true, ...result },
      { rulesChanged: false },
    );
  }

  return {
    joinAsGm,
    gmInspect,
    gmRules,
    gmAddRule,
    gmDryRunRule,
    gmRemoveRule,
    gmPatchRule,
    gmSetStock,
    gmSetStockDefault,
    gmSpawnEntity,
    gmEditEntity,
    gmRegisterTerrain,
    gmRegisterKindVisual,
    gmSetTerrain,
    gmAnnounce,
  };
}
