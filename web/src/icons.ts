import type { VisualSpec } from "./types";

// Tintable HTML icon masks. The world renderer uses asset-pack sprites; these
// white-on-transparent SVGs remain for roster stats and interface markers.

// Vite inlines the curated URL map at build time.
const ICON_URLS = import.meta.glob("./assets/icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

// Other slugs fall back to the full vendored game-icons.net set.
export function iconUrl(key: string): string {
  return ICON_URLS[`./assets/icons/${key}.svg`] ?? `/icons/${key}.svg`;
}

export function cssMaskUrl(url: string): string {
  if (!url.startsWith("data:image/svg+xml,")) return url;
  return url.replace(/["']/g, (quote) => (quote === '"' ? "%22" : "%27"));
}

export function statIconVisual(
  name: string,
  kindVisuals: Record<string, VisualSpec>,
): { url: string; color: string } | undefined {
  let spec = kindVisuals[name];
  if (!spec?.icon) return undefined;
  return {
    url: cssMaskUrl(iconUrl(spec.icon)),
    color: spec.color ?? "currentColor",
  };
}
