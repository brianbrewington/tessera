// Scenes: saved views anchored to node ids (design §4).
//
// The migration this exists for is a ONE-WAY DOOR. localStorage is origin-scoped, so file://…/view.html and
// http://127.0.0.1:PORT are different origins — once `serve` ships, every scene a user saved (including the
// only human-authored prose in the system, the tour narration) is unreachable from the new page. Slice 2
// must therefore land, and be exercised, BEFORE slice 3.
import { createHash } from "node:crypto";

/** What the file:// viewer exports and the CLI imports. */
export interface SceneExport {
  name: string;
  narr?: string | null;
  scale: number;
  showProv: boolean;
  focusNode?: string | null;
  anchors: string[];
  legacyId?: string | null;
  ordinal: number;
}

export interface SceneRecord extends SceneExport {
  id: string;
  contentKey: string;
  version: number;
  createdAt: number;
}

/**
 * Idempotency key for import (design §5). NUL-separated so ("ab","c") and ("a","bc") cannot collide;
 * `scale` at fixed 6 decimals so float formatting can't change the key; anchors sorted so ordering noise
 * doesn't create a "new" scene.
 *
 * focus_node IS part of the key. It is independent of the anchors — anchors govern the camera, focus_node
 * governs the panel — so two scenes differing only in panel selection are genuinely different scenes.
 * Both slice-1 reviewers found its omission independently.
 */
export function contentKey(s: Pick<SceneExport, "name" | "narr" | "scale" | "showProv" | "focusNode" | "anchors">): string {
  const parts = [
    s.name,
    s.narr ?? "",
    [...s.anchors].sort().join(","),
    s.scale.toFixed(6),
    s.showProv ? "1" : "0",
    s.focusNode ?? "",
  ];
  return createHash("sha256").update(parts.join("\x00")).digest("hex");
}

export interface Viewport {
  w: number;
  h: number;
}

/**
 * Anchor selection at save time (design §4.2): nodes whose screen position is inside the viewport, ranked by
 * degree, capped at K. If the viewport frames empty space, fall back to the nearest few to its centre — a
 * scene must always resolve to something, or it becomes unrestorable.
 */
export const ANCHOR_CAP = 12;
export const ANCHOR_FALLBACK = 3;

export function selectAnchors(
  nodes: ReadonlyArray<{ id: string; x: number; y: number; deg: number }>,
  cam: { ox: number; oy: number; scale: number },
  vp: Viewport,
  cap = ANCHOR_CAP,
): string[] {
  const inView = nodes.filter((n) => {
    const sx = n.x * cam.scale + cam.ox;
    const sy = n.y * cam.scale + cam.oy;
    return sx >= 0 && sx <= vp.w && sy >= 0 && sy <= vp.h;
  });
  if (inView.length) {
    return [...inView].sort((a, b) => b.deg - a.deg || (a.id < b.id ? -1 : 1)).slice(0, cap).map((n) => n.id);
  }
  // empty region: the nearest nodes to the viewport centre in WORLD space
  const cx = (vp.w / 2 - cam.ox) / cam.scale;
  const cy = (vp.h / 2 - cam.oy) / cam.scale;
  return [...nodes]
    .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy) || (a.id < b.id ? -1 : 1))
    .slice(0, ANCHOR_FALLBACK)
    .map((n) => n.id);
}

/**
 * Framing at restore (design §4.2), with the actual equations rather than "centre on the bbox" — which has
 * several implementations that an anchor-survives-re-settle test would all accept.
 *
 * The camera is screen = world*scale + o, so centring means o = viewportCentre - worldCentre*scale.
 * scale = min(stored, fit): honour the user's zoom intent, but if the cluster has spread since the scene was
 * saved, zoom out enough that they still see the thing they saved. Pure stored-scale frames the middle of a
 * cluster that no longer fits; pure refit discards a deliberate close-up.
 */
export const FIT_FRACTION = 0.7;
const EPS = 1e-6;

export function frameAnchors(
  pts: ReadonlyArray<{ x: number; y: number }>,
  storedScale: number,
  vp: Viewport,
): { ox: number; oy: number; scale: number } {
  if (!pts.length) throw new Error("frameAnchors: no anchor positions — a scene must resolve to something");
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  // EPS guards the single-anchor case (bw = bh = 0), where fit is huge and storedScale therefore wins —
  // which is what you want: a scene saved from a node panel keeps the zoom the user chose.
  const bw = Math.max(maxX - minX, EPS);
  const bh = Math.max(maxY - minY, EPS);
  const fit = Math.min((vp.w * FIT_FRACTION) / bw, (vp.h * FIT_FRACTION) / bh);
  const scale = Math.min(storedScale, fit);
  return { ox: vp.w / 2 - cx * scale, oy: vp.h / 2 - cy * scale, scale };
}
