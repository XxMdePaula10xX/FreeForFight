// Regular octagon centred at the origin, described by its circumradius R
// (centre -> vertex). The arena lives in centred physics coordinates; the
// renderer translates to screen space.
//
// We orient the octagon with flat sides at top/bottom/left/right by placing
// the 8 outward edge-normals at every 45 degrees starting at 0.

import type { Vec2 } from './math';

// Unit outward normals of the 8 edges, angle = 45deg * k.
export const EDGE_NORMALS: readonly Vec2[] = Array.from({ length: 8 }, (_, k) => {
  const a = (Math.PI / 4) * k;
  return { x: Math.cos(a), y: Math.sin(a) };
});

// cos(pi/8): ratio between apothem (centre->edge) and circumradius (centre->vertex).
export const APOTHEM_RATIO = Math.cos(Math.PI / 8);

export const apothem = (circumradius: number): number => circumradius * APOTHEM_RATIO;

// A point is inside iff it sits on the interior side of every edge.
// For a centred regular octagon that reduces to: dot(p, n_k) < apothem for all k.
export function isInside(p: Vec2, circumradius: number): boolean {
  const a = apothem(circumradius);
  for (const n of EDGE_NORMALS) {
    if (p.x * n.x + p.y * n.y >= a) return false;
  }
  return true;
}

// Signed "how far outside" — max over edges of (dot(p,n) - apothem).
// Negative means inside; >= 0 means eliminated.
export function outsideDepth(p: Vec2, circumradius: number): number {
  // A non-finite point (NaN/Infinity) is treated as outside — otherwise a
  // corrupted disc would be un-eliminable and could brick a round.
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return Infinity;
  const a = apothem(circumradius);
  let max = -Infinity;
  for (const n of EDGE_NORMALS) {
    const d = p.x * n.x + p.y * n.y - a;
    if (d > max) max = d;
  }
  return max;
}

// The 8 vertices for drawing (angle = 22.5deg + 45deg*k, at circumradius R).
export function vertices(circumradius: number): Vec2[] {
  return Array.from({ length: 8 }, (_, k) => {
    const a = Math.PI / 8 + (Math.PI / 4) * k;
    return { x: Math.cos(a) * circumradius, y: Math.sin(a) * circumradius };
  });
}

// Distance from centre to the boundary along a ray of unit direction u.
// Used to pin ghosts to the perimeter regardless of the current radius.
export function boundaryDistanceAlong(u: Vec2, circumradius: number): number {
  const a = apothem(circumradius);
  let maxDot = 0;
  for (const n of EDGE_NORMALS) {
    const d = u.x * n.x + u.y * n.y;
    if (d > maxDot) maxDot = d;
  }
  if (maxDot < 1e-9) return circumradius;
  return a / maxDot;
}

// Point on the perimeter at a given angle (radians from centre).
export function perimeterPoint(angle: number, circumradius: number): Vec2 {
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const r = boundaryDistanceAlong(u, circumradius);
  return { x: u.x * r, y: u.y * r };
}
