import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { SPRITE_GRID } from "./sprites";
import type { ActionView, AgentView, Position } from "./types";

export type Facing = "north" | "east" | "south" | "west";

interface ActorVisual {
  container: Container;
  sprite: Sprite;
  selection: Graphics;
  warning: Graphics;
  name: Text;
  activity: Text;
  current: Position;
  start: Position;
  target: Position;
  movedAt: number;
  moving: boolean;
  facing: Facing;
  action: string | null;
}

export interface AgentActorSystem {
  update(
    agents: Record<string, AgentView>,
    selectedAgentId: string | null,
    textureFor: (facing: Facing) => Texture | undefined,
  ): void;
  tick(now: number): boolean;
  position(agentId: string): Position | null;
  // Re-rasterize the nameplate text at the given resolution so glyphs stay crisp
  // as the camera zooms (see setTextResolution's usage in map.ts).
  setTextResolution(resolution: number): void;
  destroy(): void;
}

let MOVE_DURATION = 720;

// Every screen-space metric below was authored against a 16px tile; `unit`
// rescales them all so CELL stays the single knob. At CELL=16 unit is 1 and the
// actors render byte-identically to before the re-anchor.
export function createAgentActorSystem(
  layer: Container,
  cell: number,
): AgentActorSystem {
  let actors = new Map<string, ActorVisual>();
  let unit = cell / SPRITE_GRID;
  // The device-pixel density the nameplate glyphs are rasterized at. The text
  // lives inside the zoomed camera, so a fixed rasterization would be bitmap-
  // scaled up and blur; map.ts drives this to (camera scale x dpr) so the glyph
  // texture always has ~one texel per screen pixel.
  let textResolution = 2;
  function applyTextResolution(actor: ActorVisual) {
    actor.name.resolution = textResolution;
    actor.activity.resolution = textResolution;
  }

  function update(
    agents: Record<string, AgentView>,
    selectedAgentId: string | null,
    textureFor: (facing: Facing) => Texture | undefined,
  ) {
    let liveIds = new Set<string>();
    let slots = actorSlots(agents, cell);
    let now = performance.now();
    for (let agent of Object.values(agents)) {
      if (!agent.alive || !agent.position) continue;
      liveIds.add(agent.id);
      let target = slots.get(agent.id)!;
      let actor = actors.get(agent.id);
      if (!actor) {
        actor = createActor(target, unit);
        applyTextResolution(actor);
        actors.set(agent.id, actor);
        layer.addChild(actor.container);
      }

      let deltaX = target.x - actor.target.x;
      let deltaY = target.y - actor.target.y;
      if (deltaX || deltaY) {
        actor.start = { ...actor.current };
        actor.target = target;
        actor.movedAt = now;
        actor.moving = true;
        actor.facing = facingForDelta(deltaX, deltaY, actor.facing);
      } else if (!actor.moving) {
        actor.facing = facingForDirection(
          agent.action?.direction,
          actor.facing,
        );
      }

      actor.action = agent.action?.type ?? null;
      actor.name.text = agent.name;
      actor.activity.text = activityLabel(agent.action);
      actor.activity.visible = actor.activity.text.length > 0;
      actor.selection.visible = agent.id === selectedAgentId;
      actor.warning.visible = agent.order?.status === "blocked";
      let texture = textureFor(actor.facing);
      if (texture && actor.sprite.texture !== texture) {
        actor.sprite.texture = texture;
      }
      if (texture) layoutNameplate(actor, texture.height, unit);
      faceSprite(actor);
    }

    for (let [agentId, actor] of actors) {
      if (liveIds.has(agentId)) continue;
      actor.container.destroy({ children: true });
      actors.delete(agentId);
    }
  }

  function tick(now: number): boolean {
    let changed = false;
    for (let actor of actors.values()) {
      let progress = Math.min(1, (now - actor.movedAt) / MOVE_DURATION);
      if (actor.moving) {
        let amount = progress * progress * (3 - 2 * progress);
        actor.current.x =
          actor.start.x + (actor.target.x - actor.start.x) * amount;
        actor.current.y =
          actor.start.y + (actor.target.y - actor.start.y) * amount;
        actor.moving = progress < 1;
        changed = true;
      }
      let bob =
        (actor.moving
          ? Math.sin(progress * Math.PI * 4) * 0.7
          : actor.action
            ? Math.sin(now / 150) * 0.35
            : 0) * unit;
      actor.container.position.set(actor.current.x, actor.current.y + bob);
      actor.container.zIndex = actor.current.y;
    }
    return changed;
  }

  return {
    update,
    tick,
    position(agentId) {
      let actor = actors.get(agentId);
      return actor ? { ...actor.current } : null;
    },
    setTextResolution(resolution) {
      let next = Math.max(1, resolution);
      if (next === textResolution) return;
      textResolution = next;
      for (let actor of actors.values()) applyTextResolution(actor);
    },
    destroy() {
      for (let actor of actors.values())
        actor.container.destroy({ children: true });
      actors.clear();
    },
  };
}

function createActor(position: Position, unit: number): ActorVisual {
  let container = new Container();
  container.position.set(position.x, position.y);
  container.zIndex = position.y;

  let sprite = new Sprite(Texture.EMPTY);
  sprite.anchor.set(0.5, 1);
  sprite.position.y = 2 * unit;
  container.addChild(sprite);

  let selection = new Graphics()
    .ellipse(0, 0, 7 * unit, 4 * unit)
    .stroke({ color: 0xf4c879, width: unit });
  selection.position.y = 1 * unit;
  container.addChild(selection);
  let warning = new Graphics()
    .poly([0, -17 * unit, -3 * unit, -12 * unit, 3 * unit, -12 * unit])
    .fill(0xf0a34a)
    .circle(0, -13.5 * unit, 0.7 * unit)
    .fill(0x23180d);
  warning.visible = false;
  container.addChild(warning);
  let name = new Text({
    style: {
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: 4.5 * unit,
      fontWeight: "bold",
      fill: 0xf6f3ec,
      stroke: { color: 0x0b0b0c, width: unit },
    },
  });
  name.anchor.set(0.5, 1);
  // Placeholder — layoutNameplate re-seats this above the sprite's head on the
  // first update, using the sprite's actual pixel height (a 2-tile character is
  // 32 source px tall, a 1-tile one 16).
  name.position.y = -19 * unit;
  container.addChild(name);
  // The character's current action, in a smaller yellow voice directly under the
  // name (hidden entirely when idle - see activityLabel).
  let activity = new Text({
    style: {
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: 4 * unit,
      fill: 0xf4c879,
      stroke: { color: 0x0b0b0c, width: unit },
    },
  });
  activity.anchor.set(0.5, 0);
  activity.position.y = -18.5 * unit;
  activity.visible = false;
  container.addChild(activity);
  return {
    container,
    sprite,
    selection,
    warning,
    name,
    activity,
    current: { ...position },
    start: { ...position },
    target: { ...position },
    movedAt: performance.now(),
    moving: false,
    facing: "south",
    action: null,
  };
}

function actorSlots(
  agents: Record<string, AgentView>,
  cell: number,
): Map<string, Position> {
  let byTile = new Map<string, AgentView[]>();
  for (let agent of Object.values(agents)) {
    if (!agent.alive || !agent.position) continue;
    let key = `${agent.position.x},${agent.position.y}`;
    let group = byTile.get(key) ?? [];
    group.push(agent);
    byTile.set(key, group);
  }

  let slots = new Map<string, Position>();
  for (let group of byTile.values()) {
    group.sort((left, right) => left.id.localeCompare(right.id));
    let center = group[0].position;
    for (let index = 0; index < group.length; index += 1) {
      let offset = slotOffset(index, group.length, cell / SPRITE_GRID);
      slots.set(group[index].id, {
        x: (center.x + 0.5) * cell + offset.x,
        y: (center.y + 0.5) * cell + offset.y,
      });
    }
  }
  return slots;
}

function slotOffset(index: number, count: number, unit: number): Position {
  if (count === 1) return { x: 0, y: 3 * unit };
  let shown = Math.min(count, 7);
  let slot = index % shown;
  let angle = Math.PI * (0.12 + (0.76 * slot) / (shown - 1));
  let radius = (count > 4 ? 6 : 5) * unit;
  return {
    x: Math.cos(angle) * radius,
    y: 4 * unit - Math.sin(angle) * radius * 0.55,
  };
}

// The nameplate's second line: the action type plus a short detail (goal,
// direction, or arg), matching the roster's inline activity. Idle or absent
// actions return "" so the caller can hide the line entirely.
function activityLabel(action: ActionView | null | undefined): string {
  let type = action?.type;
  if (!type || type === "idle") return "";
  let argDetail = action?.args ? Object.values(action.args).join(" ") : "";
  let detail = action?.goal ?? action?.direction ?? argDetail ?? "";
  return [type, detail].filter(Boolean).join(" ");
}

function facingForDelta(
  deltaX: number,
  deltaY: number,
  fallback: Facing,
): Facing {
  if (Math.abs(deltaX) > Math.abs(deltaY)) return deltaX > 0 ? "east" : "west";
  if (deltaY) return deltaY > 0 ? "south" : "north";
  return fallback;
}

function facingForDirection(
  direction: string | undefined,
  fallback: Facing,
): Facing {
  if (!direction) return fallback;
  if (direction.includes("east")) return "east";
  if (direction.includes("west")) return "west";
  if (direction.includes("north")) return "north";
  if (direction.includes("south")) return "south";
  return fallback;
}

function faceSprite(actor: ActorVisual) {
  let scale = Math.abs(actor.sprite.scale.x);
  actor.sprite.scale.x = actor.facing === "west" ? -scale : scale;
}

// Seat the two-line name/activity block just above the sprite's head. The
// sprite is bottom-anchored at 2*unit, so its top sits that many pixels above
// origin minus its own pixel height; taller characters (2-tile = 32px) push the
// nameplate correspondingly higher without any hardcoded offset per art size.
function layoutNameplate(
  actor: ActorVisual,
  spriteHeight: number,
  unit: number,
) {
  let spriteTop = 2 * unit - spriteHeight;
  actor.activity.position.y = spriteTop - 4.5 * unit;
  actor.name.position.y = actor.activity.position.y - 0.5 * unit;
}
