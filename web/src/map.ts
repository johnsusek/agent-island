import {
  Application,
  Container,
  Graphics,
  RenderTexture,
  Sprite,
} from "pixi.js";
import {
  SPRITE_GRID,
  missing as missingSpriteTexture,
  resolveSprite,
} from "./sprites";
import { nameTint } from "./glyphs";
import { createAgentActorSystem } from "./mapActors";
import type {
  AgentView,
  EntityView,
  FogView,
  GraphicsConfig,
  MapView,
  Position,
  PositionedToken,
  SpriteSpec,
  Stock,
  VisualSpec,
} from "./types";

// ---- Hover tooltip -----------------------------------------------------
// Everything the HTML tooltip needs to describe the tile under the cursor,
// assembled by the controller (which already holds the live map/agents/
// entities) and handed up to the Vue layer, which owns the rendering.

// A stock's glyph is resolved centrally from its own StockSpec (the engine
// folds StockSpec.icon/color into kindVisuals), the same lookup the character
// card uses — so "health" carries one icon everywhere, defined in one place.
// A stock without a central icon simply shows its name, no glyph.
export interface TooltipStock {
  name: string;
  value: number;
}

export interface TooltipAgent {
  id: string;
  name: string;
  color: string;
}

export interface TooltipEntity {
  id: string;
  label: string;
  text?: string;
  stocks: TooltipStock[];
}

export interface TileTooltip {
  terrain: string;
  fogged: boolean;
  token: {
    label: string;
    text?: string;
    stocks: TooltipStock[];
  } | null;
  agents: TooltipAgent[];
  entities: TooltipEntity[];
}

export type HoverHandler = (
  info: TileTooltip | null,
  clientX: number,
  clientY: number,
) => void;

// ---- Tile info -----------------------------------------------------------
// Building a TileTooltip is pure data work over the live world snapshot, so it
// lives at module scope: the controller assembles it for the hover card
// straight from the shared world store without going through Pixi.

export interface TileInfoContext {
  map: MapView;
  tokens: PositionedToken[];
  fog: FogView | null;
  agents: Record<string, AgentView>;
  entities: Record<string, EntityView>;
  kindVisuals: Record<string, VisualSpec>;
  selectedAgentId: string | null;
}

export function stockLines(stocks: Record<string, Stock>): TooltipStock[] {
  return Object.entries(stocks)
    .map(([name, stock]) => {
      return {
        name,
        value: Math.round(stock.value),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function buildTileTooltip(
  ctx: TileInfoContext,
  tileX: number,
  tileY: number,
): TileTooltip {
  let tile = ctx.map.tiles.find(
    (candidate) => candidate.x === tileX && candidate.y === tileY,
  );
  let terrain = tile?.terrain ?? "unknown";
  // "Unexplored" is relative to the selected character's own fog; with none
  // selected the map is fully revealed, so nothing reads as fogged.
  let fogged =
    ctx.selectedAgentId != null &&
    !(ctx.fog?.knownByAgent?.[ctx.selectedAgentId] ?? []).some(
      (known) => known.x === tileX && known.y === tileY,
    );

  let here = Object.values(ctx.agents)
    .filter(
      (agent) =>
        agent.alive &&
        agent.position?.x === tileX &&
        agent.position?.y === tileY,
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      color: nameTint(agent.name),
    }));

  let entitiesHere = Object.values(ctx.entities).filter(
    (entity) =>
      entity.id !== "world" &&
      !entity.tags.includes("agent") &&
      entity.pos?.x === tileX &&
      entity.pos?.y === tileY,
  );

  // A grid token is backed by an entity of the same id carrying its live
  // reserves (see engine seeding), so it shows up in both streams. Fold the
  // reserves into the single token row and drop the backing entity from the
  // entity list so the tile card doesn't list the same object twice.
  let token = null;
  let tokenHere = ctx.tokens.find(
    (candidate) => candidate.x === tileX && candidate.y === tileY,
  );
  if (tokenHere) {
    let backing = ctx.entities[tokenHere.token.name];
    let kind = tokenHere.token.kind;
    token = {
      label:
        (kind && ctx.kindVisuals[kind]?.label) ?? kind ?? tokenHere.token.name,
      text: backing?.text,
      stocks: backing ? stockLines(backing.stocks) : [],
    };
  }

  let things = entitiesHere
    .filter((entity) => entity.id !== tokenHere?.token.name)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entity) => {
      let kind = entity.kind;
      return {
        id: entity.id,
        label: (kind && ctx.kindVisuals[kind]?.label) ?? kind ?? entity.id,
        text: entity.text,
        stocks: stockLines(entity.stocks),
      };
    });

  return {
    terrain,
    fogged,
    token,
    agents: here,
    entities: things,
  };
}

// Where a character's token sits on screen right now, so the Vue layer can float
// a speech bubble just above it. x/y are viewport coords (the point just over
// the token's crown); recomputed every poll and camera move so bubbles trail
// their character.
export interface AgentAnchor {
  id: string;
  name: string;
  x: number;
  y: number;
  scale: number;
}

export type AnchorHandler = (anchors: AgentAnchor[]) => void;
export type ZoomHandler = (zoom: number) => void;

// The neutral fill for a terrain the server published no color for. The palette
// itself is data now (scenario.terrainVisuals), resolved per tile below.
const FALLBACK_HEX = "#41492e";
const STAGE_BG = 0x15140f;

// The world is drawn at a fixed scale — CELL world-pixels per tile — inside a
// camera container; zooming and panning move the camera, never the geometry.
export const CELL = 16;
// Every map sprite scales by this factor so one source pixel is CELL/SPRITE_GRID
// world-pixels regardless of the art's own grid — uniform pixel density, with
// grid dimensions deciding footprint. (mapActors' `unit` is the same value.)
const worldScale = CELL / SPRITE_GRID;
// Wheel and slider both snap to this zoom ladder. The 1× floor keeps map details
// readable while fractional steps make zooming gentler.
export const ZOOM_STEPS = [
  1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8,
];
const FOG_FILL = 0x070707;

// A thing on the map, as far as appearance goes: its declared kind (identity)
// plus its behavior tags. Mirrors the server's Entity/TokenRef split.
interface Appearance {
  kind?: string;
  tags: string[];
}

// Tag membership with kind counted as a tag - the web mirror of the kernel's
// hasTag, so zone/creature/agent checks don't care which slot a name lives in.
function hasName(thing: Appearance, name: string): boolean {
  return thing.kind === name || thing.tags.includes(name);
}

// The sprite for a thing: its kind's authored art. Scanning the tags (last
// authored wins) is the legacy fallback, kept so pre-kind content and
// behavior-tag art (a corpse's "dead") still draw; kind always wins when set.
function spriteFor(
  thing: Appearance,
  kindVisuals: Record<string, VisualSpec>,
): SpriteSpec | undefined {
  let authored = thing.kind ? kindVisuals?.[thing.kind]?.sprite : undefined;
  if (authored) return authored;
  for (let index = thing.tags.length - 1; index >= 0; index -= 1) {
    let fallback = kindVisuals?.[thing.tags[index]]?.sprite;
    if (fallback) return fallback;
  }
  return undefined;
}

function isZone(thing: Appearance): boolean {
  return hasName(thing, "stockpile") || hasName(thing, "storage");
}

// Nearest rung on the zoom ladder — the single place a raw zoom (wheel delta or
// slider value) becomes a legal scale.
function snapZoom(value: number): number {
  return ZOOM_STEPS.reduce(
    (best, step) =>
      Math.abs(step - value) < Math.abs(best - value) ? step : best,
    ZOOM_STEPS[0],
  );
}

export function terrainHex(
  terrain: string,
  terrainVisuals: Record<string, VisualSpec> = {},
): string {
  return terrainVisuals[terrain]?.color ?? FALLBACK_HEX;
}

// The map now arrives as three independently-revisioned streams, so each render
// layer gates on its own signature - the server's revision is the change signal,
// no per-tile serialization needed. Terrain (the expensive bake) only re-runs on
// a terrain-revision bump, resize, graphics swap, or terrain-visual edit; the
// token layer redraws on a token-revision bump, icon edit, or map-origin move;
// fog redraws when its revision, lens, connectivity, or map bounds change. Every
// signature also carries the worldId: a reset mints a new world but restarts the
// per-world revisions at 0, so without it a fresh map could match the old
// signature and skip its rebake.
function terrainSignature(
  worldId: string,
  terrainRevision: number,
  dims: string,
  graphics: GraphicsConfig,
  terrainVisuals: Record<string, VisualSpec>,
): string {
  return `${worldId}:${terrainRevision}:${dims}:${JSON.stringify(graphics)}:${JSON.stringify(terrainVisuals)}`;
}

function tokenSignature(
  worldId: string,
  tokenRevision: number,
  bounds: string,
  graphics: GraphicsConfig,
  kindVisuals: Record<string, VisualSpec>,
): string {
  return `${worldId}:${tokenRevision}:${bounds}:${JSON.stringify(graphics)}:${JSON.stringify(kindVisuals)}`;
}

function fogSignature(
  worldId: string,
  fogRevision: number,
  selectedAgentId: string | null,
  sharedFog: boolean,
  bounds: string,
): string {
  return `${worldId}:${fogRevision}:${selectedAgentId ?? ""}:${sharedFog}:${bounds}`;
}

export interface WorldViewportUpdate {
  map: MapView;
  worldId: string;
  terrainRevision: number;
  tokens: PositionedToken[];
  tokenRevision: number;
  fog: FogView | null;
  fogRevision: number;
  graphics: GraphicsConfig;
  agents: Record<string, AgentView>;
  entities: Record<string, EntityView>;
  selectedAgentId: string | null;
  terrainVisuals: Record<string, VisualSpec>;
  kindVisuals: Record<string, VisualSpec>;
  sharedFog: boolean;
}

export interface WorldViewportController {
  update(next: WorldViewportUpdate): void;
  setZoom(zoom: number): void;
  destroy(): void;
}

// Renders the game world at its native 16px grid under an integer-scale camera.
export async function createWorldViewportController(
  host: HTMLElement,
  onHover: HoverHandler = () => {},
  onAnchors: AnchorHandler = () => {},
  onZoom: ZoomHandler = () => {},
): Promise<WorldViewportController> {
  let app = new Application();
  // resolution + autoDensity render the canvas at the device pixel ratio (retina)
  // while keeping the CSS size unchanged — Pixi's built-in HiDPI support.
  await app.init({
    background: STAGE_BG,
    antialias: false,
    resizeTo: host,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  host.appendChild(app.canvas);

  // Everything world-positioned lives under `camera`; its transform is the view.
  let camera = new Container();
  let terrainLayer = new Container();
  let zoneLayer = new Container();
  let objectLayer = new Container();
  objectLayer.sortableChildren = true;
  let fogLayer = new Container();
  camera.addChild(terrainLayer, zoneLayer, objectLayer, fogLayer);
  app.stage.addChild(camera);
  let actorSystem = createAgentActorSystem(objectLayer, CELL);

  let map: MapView | null = null;
  let graphics: GraphicsConfig = {
    scale: 3,
  };
  let graphicsSignature = "";
  let agents: Record<string, AgentView> = {};
  let entities: Record<string, EntityView> = {};
  let tokens: PositionedToken[] = [];
  let fogView: FogView | null = null;
  let selectedAgentId: string | null = null;
  let sharedFog = false;
  let terrainVisuals: Record<string, VisualSpec> = {};
  let kindVisuals: Record<string, VisualSpec> = {};
  let terrainSig = "";
  let tokenSig = "";
  let fogSig = "";
  let dims = "";
  let tokenNodes: Container[] = [];
  let entityNodes: Container[] = [];
  // The whole ground layer is baked to one texture per terrain change: at 128x128
  // that is one display object instead of 16k per-tile sprites. Props and tokens
  // stay live sprites above it (hundreds, fine); only the flat ground bakes.
  let terrainTexture: RenderTexture | null = null;

  // ---- Camera ----------------------------------------------------------

  let following = false;
  let cameraTarget = { x: 0, y: 0 };

  function clampCamera() {
    if (!map || following) return;
    let scale = camera.scale.x;
    let mapWidth = map.width * CELL * scale;
    let mapHeight = map.height * CELL * scale;
    let viewportWidth = app.screen.width;
    let viewportHeight = app.screen.height;
    camera.x =
      mapWidth <= viewportWidth
        ? (viewportWidth - mapWidth) / 2
        : Math.min(0, Math.max(viewportWidth - mapWidth, camera.x));
    camera.y =
      mapHeight <= viewportHeight
        ? (viewportHeight - mapHeight) / 2
        : Math.min(0, Math.max(viewportHeight - mapHeight, camera.y));
  }

  function setCameraTarget(centerX: number, centerY: number) {
    let scale = camera.scale.x;
    cameraTarget = {
      x: app.screen.width / 2 - centerX * scale,
      y: app.screen.height / 2 - centerY * scale,
    };
  }

  function centerCamera(center: Position, immediate = false) {
    setCameraTarget(center.x, center.y);
    if (!immediate) return;
    camera.position.set(cameraTarget.x, cameraTarget.y);
    clampCamera();
    emitAnchors();
  }

  function selectedActorPosition(): Position | null {
    if (!selectedAgentId) return null;
    let actor = actorSystem.position(selectedAgentId);
    if (actor) return actor;
    let position = agents[selectedAgentId]?.position;
    if (!position) return null;
    let center = tileCenter(position.x, position.y);
    return { x: center.cx, y: center.cy };
  }

  function followSelected(immediate = false) {
    let position = selectedActorPosition();
    if (!position) {
      following = false;
      return;
    }
    centerCamera(position, immediate);
  }

  // Keep the nameplate glyph textures dense enough for the current zoom: the
  // text is scaled with the camera, so rasterize it at ceil(scale) x dpr texels
  // per logical pixel and it stays crisp instead of bitmap-blurring on zoom-in.
  function syncTextResolution(scale: number) {
    let dpr = window.devicePixelRatio || 1;
    actorSystem.setTextResolution(Math.ceil(scale) * dpr);
  }

  function initialView() {
    if (!map) return;
    camera.scale.set(graphics.scale);
    syncTextResolution(graphics.scale);
    onZoom(graphics.scale);
    following = Boolean(selectedAgentId);
    let selected = selectedActorPosition();
    let spawnCenter = tileCenter(map.spawn.x, map.spawn.y);
    let spawn = { x: spawnCenter.cx, y: spawnCenter.cy };
    centerCamera(selected ?? spawn, true);
  }

  function setZoomAt(mouseX: number, mouseY: number, zoom: number) {
    if (!map) return;
    let next = snapZoom(zoom);
    if (next === camera.scale.x) return;
    let ratio = next / camera.scale.x;
    // Keep the world point under the cursor stationary while scaling.
    camera.x = mouseX - (mouseX - camera.x) * ratio;
    camera.y = mouseY - (mouseY - camera.y) * ratio;
    camera.scale.set(next);
    syncTextResolution(next);
    if (following) followSelected(true);
    clampCamera();
    emitAnchors();
    onZoom(next);
  }

  let wheelDistance = 0;

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    let distance =
      event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1);
    if (wheelDistance && Math.sign(distance) !== Math.sign(wheelDistance))
      wheelDistance = 0;
    wheelDistance += distance;
    if (Math.abs(wheelDistance) < 80) return;

    let rect = app.canvas.getBoundingClientRect();
    // Step one rung along the ladder rather than by a fixed +/-1, so a scroll
    // crosses the fractional zoom-out rungs the same as the integer ones.
    let index = ZOOM_STEPS.indexOf(snapZoom(camera.scale.x));
    let nextIndex = Math.min(
      Math.max(index + (wheelDistance < 0 ? 1 : -1), 0),
      ZOOM_STEPS.length - 1,
    );
    wheelDistance = 0;
    setZoomAt(
      event.clientX - rect.left,
      event.clientY - rect.top,
      ZOOM_STEPS[nextIndex],
    );
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  function onPointerDown(event: PointerEvent) {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    app.canvas.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (dragging) {
      camera.x += event.clientX - lastX;
      camera.y += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      following = false;
      clampCamera();
      // Bubbles track the pan even though hover is dropped.
      emitAnchors();
      // A drag is a pan, not an inspect — drop any tooltip while the map slides.
      clearHover();
      return;
    }
    hoverClient = { x: event.clientX, y: event.clientY };
    emitHover();
  }

  function onPointerUp(event: PointerEvent) {
    dragging = false;
    if (app.canvas.hasPointerCapture(event.pointerId))
      app.canvas.releasePointerCapture(event.pointerId);
  }

  function onDoubleClick() {
    if (selectedAgentId) {
      following = true;
      followSelected();
      return;
    }
    if (!map) return;
    let spawn = tileCenter(map.spawn.x, map.spawn.y);
    centerCamera({ x: spawn.cx, y: spawn.cy });
  }

  // ---- Hover tooltip ---------------------------------------------------

  // The cursor's last screen position while hovering (null when off-canvas or
  // mid-drag), kept so the tooltip can be recomputed against fresh world data
  // even when the pointer holds still between polls.
  let hoverClient: { x: number; y: number } | null = null;

  function clearHover() {
    if (!hoverClient) return;
    hoverClient = null;
    onHover(null, 0, 0);
  }

  function tileAtClient(clientX: number, clientY: number): Position | null {
    if (!map) return null;
    let rect = app.canvas.getBoundingClientRect();
    let worldX = (clientX - rect.left - camera.x) / camera.scale.x;
    let worldY = (clientY - rect.top - camera.y) / camera.scale.y;
    let columnIndex = Math.floor(worldX / CELL);
    let rowIndex = Math.floor(worldY / CELL);
    if (
      columnIndex < 0 ||
      rowIndex < 0 ||
      columnIndex >= map.width ||
      rowIndex >= map.height
    )
      return null;
    return {
      x: map.origin.x + columnIndex,
      y: map.origin.y + rowIndex,
    };
  }

  function buildTileInfo(tileX: number, tileY: number): TileTooltip {
    return buildTileTooltip(
      {
        map: map!,
        tokens,
        fog: fogView,
        agents,
        entities,
        kindVisuals,
        selectedAgentId,
      },
      tileX,
      tileY,
    );
  }

  function emitHover() {
    if (!hoverClient || !map) return;
    let tile = tileAtClient(hoverClient.x, hoverClient.y);
    if (!tile) {
      onHover(null, 0, 0);
      return;
    }
    onHover(buildTileInfo(tile.x, tile.y), hoverClient.x, hoverClient.y);
  }

  // Every living character's on-screen anchor, so the Vue layer can hang a speech
  // bubble over whoever just spoke. Emitted alongside the pin on every poll and
  // camera move; the anchor rides just above the token's crown so the bubble's
  // tail points down at them, and the world-space offset keeps that gap constant
  // across zoom levels.
  function emitAnchors() {
    if (!map) {
      onAnchors([]);
      return;
    }
    let rect = app.canvas.getBoundingClientRect();
    let out: AgentAnchor[] = [];
    for (let agent of Object.values(agents)) {
      if (!agent.alive || !agent.position) continue;
      let position = actorSystem.position(agent.id) ?? {
        x: tileCenter(agent.position.x, agent.position.y).cx,
        y: tileCenter(agent.position.x, agent.position.y).cy,
      };
      let localX = camera.x + position.x * camera.scale.x;
      let localY = camera.y + position.y * camera.scale.y;
      // Drop characters panned off the canvas so their bubbles don't drift over
      // the rest of the page while zoomed in.
      if (
        localX < 0 ||
        localY < 0 ||
        localX > rect.width ||
        localY > rect.height
      )
        continue;
      out.push({
        id: agent.id,
        name: agent.name,
        x: localX,
        y: localY - CELL * 1.34 * camera.scale.y,
        scale: camera.scale.x / graphics.scale,
      });
    }
    onAnchors(out);
  }

  app.canvas.addEventListener("wheel", onWheel, { passive: false });
  app.canvas.addEventListener("pointerdown", onPointerDown);
  app.canvas.addEventListener("pointermove", onPointerMove);
  app.canvas.addEventListener("pointerup", onPointerUp);
  app.canvas.addEventListener("pointercancel", onPointerUp);
  app.canvas.addEventListener("pointerleave", clearHover);
  app.canvas.addEventListener("dblclick", onDoubleClick);
  app.canvas.style.touchAction = "none";
  app.canvas.style.cursor = "grab";

  // ---- Drawing ---------------------------------------------------------

  function tileCenter(
    tileX: number,
    tileY: number,
  ): { cx: number; cy: number } {
    let origin = map?.origin ?? { x: 0, y: 0 };
    return {
      cx: (tileX - origin.x + 0.5) * CELL,
      cy: (tileY - origin.y + 0.5) * CELL,
    };
  }

  function localTile(tileX: number, tileY: number): Position {
    let origin = map?.origin ?? { x: 0, y: 0 };
    return { x: tileX - origin.x, y: tileY - origin.y };
  }

  function spriteNode(spec: SpriteSpec | undefined): Sprite {
    let resolved = resolveSprite(spec);
    let sprite = new Sprite(resolved.texture);
    sprite.anchor.set(resolved.anchor.x, resolved.anchor.y);
    sprite.scale.set(worldScale);
    return sprite;
  }

  function drawTerrain() {
    terrainLayer.removeChildren();
    if (terrainTexture) {
      terrainTexture.destroy(true);
      terrainTexture = null;
    }
    if (!map) return;
    // Paint every ground tile into a scratch container, bake it once, and keep a
    // single sprite of that texture. Nearest sampling preserves crisp pixels when
    // the camera scales up; fractional zoom-out downsamples the bake cleanly.
    let scratch = new Container();
    for (let tile of map.tiles) {
      let spec = terrainVisuals[tile.terrain]?.sprite;
      let node = new Sprite(
        spec ? resolveSprite(spec).texture : missingSpriteTexture(),
      );
      let local = localTile(tile.x, tile.y);
      node.position.set(local.x * CELL, local.y * CELL);
      node.scale.set(worldScale);
      scratch.addChild(node);
    }
    terrainTexture = RenderTexture.create({
      width: map.width * CELL,
      height: map.height * CELL,
    });
    terrainTexture.source.scaleMode = "nearest";
    app.renderer.render({ container: scratch, target: terrainTexture });
    // The scratch sprites share atlas textures, so drop the sprites only.
    scratch.destroy({ children: true });
    terrainLayer.addChild(new Sprite(terrainTexture));
  }

  // Graphics is pure presentation config now (the default zoom scale); a change
  // recenters the camera at the new scale. Sprites arrive inline in the visuals,
  // so there is nothing to load - the terrain/token signatures (which stringify
  // graphics) drive the rebakes.
  function updateGraphics(next: GraphicsConfig) {
    let nextSignature = JSON.stringify(next);
    if (nextSignature === graphicsSignature) return;
    let hadGraphics = graphicsSignature !== "";
    graphics = next;
    graphicsSignature = nextSignature;
    if (hadGraphics && map) initialView();
  }

  function drawTokens() {
    clearObjectNodes(tokenNodes);
    tokenNodes = [];
    for (let { x, y, token } of tokens) {
      let { cx, cy } = tileCenter(x, y);
      let baseline = cy + CELL * 0.1;
      let object = new Container();
      object.position.set(cx, baseline);
      object.zIndex = baseline;
      object.addChild(spriteNode(spriteFor(token, kindVisuals)));
      objectLayer.addChild(object);
      tokenNodes.push(object);
    }
  }

  function clearObjectNodes(nodes: Container[]) {
    for (let node of nodes) {
      objectLayer.removeChild(node);
      node.destroy({ children: true });
    }
  }

  // Corner brackets instead of a full border: reads as a designated zone in the
  // HUD's idiom without adding a heavy outline. (Pixi has no dashed stroke.)
  function zoneBrackets(tileX: number, tileY: number, color: number): Graphics {
    let graphic = new Graphics();
    let inset = 4;
    let len = 14;
    let local = localTile(tileX, tileY);
    let x0 = local.x * CELL + inset;
    let y0 = local.y * CELL + inset;
    let x1 = (local.x + 1) * CELL - inset;
    let y1 = (local.y + 1) * CELL - inset;
    graphic
      .moveTo(x0, y0 + len)
      .lineTo(x0, y0)
      .lineTo(x0 + len, y0);
    graphic
      .moveTo(x1 - len, y0)
      .lineTo(x1, y0)
      .lineTo(x1, y0 + len);
    graphic
      .moveTo(x1, y1 - len)
      .lineTo(x1, y1)
      .lineTo(x1 - len, y1);
    graphic
      .moveTo(x0 + len, y1)
      .lineTo(x0, y1)
      .lineTo(x0, y1 - len);
    graphic.stroke({ color, alpha: 0.7, width: 2 });
    return graphic;
  }

  // Zones stay on the floor, creatures take the far side of the tile, and loose
  // things collect in a small tray along the bottom edge.
  function drawEntities() {
    clearObjectNodes(entityNodes);
    entityNodes = [];
    zoneLayer.removeChildren();
    if (!map) return;
    let byTile = new Map<string, EntityView[]>();
    for (let entity of Object.values(entities)) {
      if (!entity.pos || entity.id === "world") continue;
      if (hasName(entity, "agent") || entity.occupancy) continue;
      let key = `${entity.pos.x},${entity.pos.y}`;
      let group = byTile.get(key);
      if (!group) byTile.set(key, (group = []));
      group.push(entity);
    }
    for (let [key, group] of byTile) {
      let [tileX, tileY] = key.split(",").map(Number);
      let { cx, cy } = tileCenter(tileX, tileY);
      group.sort((left, right) => left.id.localeCompare(right.id));

      for (let entity of group) {
        if (!isZone(entity)) continue;
        let local = localTile(tileX, tileY);
        let floor = new Graphics()
          .rect(local.x * CELL + 2, local.y * CELL + 2, CELL - 4, CELL - 4)
          .fill({ color: 0xc8a45a, alpha: 0.14 });
        zoneLayer.addChild(floor);
        zoneLayer.addChild(zoneBrackets(tileX, tileY, 0xc8a45a));
      }

      let occupants = group.filter((entity) => !isZone(entity));
      let creatures = occupants.filter((entity) => isCreature(entity));
      let looseItems = occupants.filter((entity) => !isCreature(entity));
      for (let index = 0; index < creatures.length; index += 1) {
        let entity = creatures[index];
        let object = entityObject(entity);
        object.position.set(
          cx + CELL * 0.28,
          cy + (index - (creatures.length - 1) / 2) * CELL * 0.2,
        );
        object.zIndex = object.y;
        objectLayer.addChild(object);
        entityNodes.push(object);
      }

      for (let index = 0; index < looseItems.length; index += 1) {
        let entity = looseItems[index];
        let object = entityObject(entity);
        object.position.set(
          cx + (index - (looseItems.length - 1) / 2) * CELL * 0.2,
          cy + CELL * 0.32,
        );
        object.zIndex = object.y;
        objectLayer.addChild(object);
        entityNodes.push(object);
      }
    }
    // Live reserves (a token's wood, a stockpile's holdings) used to be badged
    // as on-map text here; that's now read from the tile tooltip instead, so the
    // map stays free of in-world numbers.
  }

  function entityObject(entity: EntityView): Container {
    let object = new Container();
    object.addChild(spriteNode(spriteFor(entity, kindVisuals)));
    return object;
  }

  function isCreature(thing: Appearance) {
    return ["animal", "beast", "creature", "monster", "predator"].some((name) =>
      hasName(thing, name),
    );
  }

  function updateAgents() {
    let textureFor = () => resolveSprite(kindVisuals.agent?.sprite).texture;
    let displayAgents: Record<string, AgentView> = {};
    for (let [id, agent] of Object.entries(agents)) {
      let local = localTile(agent.position.x, agent.position.y);
      displayAgents[id] = { ...agent, position: local };
    }
    actorSystem.update(displayAgents, selectedAgentId, textureFor);
    emitAnchors();
  }

  // Fog is a per-character lens, not a baked-in colony reveal. A selected character
  // takes precedence: the map masks to the tiles that character has personally
  // seen, so the spectator reads the world through one character's eyes. With no
  // character selected, a live controller masks to the union of every character's
  // seen tiles (the colony's collective knowledge); with none, the island shows.
  function drawFog() {
    fogLayer.removeChildren();
    if (!map) return;
    let seen: Set<string>;
    if (selectedAgentId) {
      let tiles = fogView?.knownByAgent?.[selectedAgentId] ?? [];
      seen = new Set(tiles.map((tile) => `${tile.x},${tile.y}`));
    } else if (sharedFog && fogView?.knownByAgent) {
      seen = new Set();
      for (let tiles of Object.values(fogView.knownByAgent))
        for (let tile of tiles) seen.add(`${tile.x},${tile.y}`);
    } else {
      return;
    }
    let fog = new Graphics();
    for (let tile of map.tiles) {
      if (seen.has(`${tile.x},${tile.y}`)) continue;
      let local = localTile(tile.x, tile.y);
      fog
        .rect(local.x * CELL, local.y * CELL, CELL, CELL)
        .fill({ color: FOG_FILL, alpha: 0.78 });
    }
    fogLayer.addChild(fog);
  }

  let resizeObserver = new ResizeObserver(() => {
    if (following) followSelected(true);
    else {
      clampCamera();
      emitAnchors();
    }
  });
  resizeObserver.observe(host);

  function animate() {
    let actorMoved = actorSystem.tick(performance.now());
    if (following) followSelected();
    let amount = 1 - Math.exp(-app.ticker.deltaMS / 140);
    let nextX = camera.x + (cameraTarget.x - camera.x) * amount;
    let nextY = camera.y + (cameraTarget.y - camera.y) * amount;
    let cameraMoved =
      following &&
      (Math.abs(nextX - camera.x) > 0.01 || Math.abs(nextY - camera.y) > 0.01);
    if (cameraMoved) {
      camera.position.set(nextX, nextY);
      clampCamera();
    }
    if (actorMoved || cameraMoved) emitAnchors();
  }
  app.ticker.add(animate);

  return {
    update(next) {
      updateGraphics(next.graphics);
      let selectionChanged = selectedAgentId !== next.selectedAgentId;
      agents = next.agents;
      entities = next.entities;
      tokens = next.tokens;
      fogView = next.fog;
      selectedAgentId = next.selectedAgentId;
      if (selectionChanged) following = Boolean(next.selectedAgentId);
      sharedFog = next.sharedFog;
      terrainVisuals = next.terrainVisuals;
      kindVisuals = next.kindVisuals;
      let nextDims = `${next.map.origin.x},${next.map.origin.y}:${next.map.width}x${next.map.height}`;
      let firstMap = !map;
      map = next.map;
      // Each layer redraws on its own signal, so a token hop or a reveal never
      // triggers the expensive terrain rebake.
      let nextTerrainSig = terrainSignature(
        next.worldId,
        next.terrainRevision,
        nextDims,
        next.graphics,
        next.terrainVisuals,
      );
      let nextTokenSig = tokenSignature(
        next.worldId,
        next.tokenRevision,
        nextDims,
        next.graphics,
        next.kindVisuals,
      );
      let nextFogSig = fogSignature(
        next.worldId,
        next.fogRevision,
        selectedAgentId,
        sharedFog,
        nextDims,
      );
      // A different-sized world is a new world: reset the camera. A same-size
      // change keeps the player's view where it is.
      if (firstMap || nextDims !== dims) {
        dims = nextDims;
        initialView();
      }
      if (firstMap || nextTerrainSig !== terrainSig) {
        terrainSig = nextTerrainSig;
        drawTerrain();
      }
      if (firstMap || nextTokenSig !== tokenSig) {
        tokenSig = nextTokenSig;
        drawTokens();
      }
      // The movers - characters and spawned entities - repaint every poll.
      drawEntities();
      updateAgents();
      if (firstMap || nextFogSig !== fogSig) {
        fogSig = nextFogSig;
        drawFog();
      }
      if (selectionChanged && following) followSelected();
      // A tooltip held over a tile should reflect the poll that just landed.
      emitHover();
    },
    setZoom(zoom) {
      setZoomAt(app.screen.width / 2, app.screen.height / 2, zoom);
    },
    destroy() {
      resizeObserver.disconnect();
      app.ticker.remove(animate);
      actorSystem.destroy();
      terrainTexture?.destroy(true);
      terrainTexture = null;
      app.canvas.removeEventListener("wheel", onWheel);
      app.canvas.removeEventListener("pointerdown", onPointerDown);
      app.canvas.removeEventListener("pointermove", onPointerMove);
      app.canvas.removeEventListener("pointerup", onPointerUp);
      app.canvas.removeEventListener("pointercancel", onPointerUp);
      app.canvas.removeEventListener("pointerleave", clearHover);
      app.canvas.removeEventListener("dblclick", onDoubleClick);
      app.destroy(true, { children: true });
    },
  };
}
