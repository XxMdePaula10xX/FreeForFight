// Character rendering — the discs are drawn as top-down sumô fighters, not
// flat circles. A chunky body in the player's colour, a mawashi belt, two
// stubby arms that thrust when pushing, and a head that points where you face.
// Kept legible at 60fps in a brawl: bold shapes, thick outlines, one glance.

export interface FighterStyle {
  color: string;
  facing: number; // radians, where the fighter looks
  moving: number; // 0..1 speed factor -> walk bob & dust
  walkPhase: number; // animation clock (radians)
  pushing: number; // 0..1 arm thrust
  squash: number; // 0..1 impact squash
}

// Lighten/darken a #rrggbb hex by amt in [-1,1].
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  if (amt >= 0) {
    r += (255 - r) * amt;
    g += (255 - g) * amt;
    b += (255 - b) * amt;
  } else {
    r *= 1 + amt;
    g *= 1 + amt;
    b *= 1 + amt;
  }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

const VOID = '#0d0b0f';

// Gradient cache. A CanvasGradient's coordinates are interpreted in the CTM in
// effect when it's painted, so a gradient built once in local space (centred on
// the origin) can be reused every frame by translating the context to the
// fighter before filling — no per-disc allocation. Keyed by radius (px), which
// only changes on viewport resize; the body gradient additionally by colour.
const bodyGradCache = new Map<string, { R: number; grad: CanvasGradient }>();
let headGradCache: { R: number; grad: CanvasGradient } | null = null;

function bodyGradient(ctx: CanvasRenderingContext2D, color: string, R: number): CanvasGradient {
  const hit = bodyGradCache.get(color);
  if (hit && hit.R === R) return hit.grad;
  const grad = ctx.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.15, 0, 0, R * 1.15);
  grad.addColorStop(0, shade(color, 0.42));
  grad.addColorStop(0.55, color);
  grad.addColorStop(1, shade(color, -0.28));
  bodyGradCache.set(color, { R, grad });
  return grad;
}

function headGradient(ctx: CanvasRenderingContext2D, hR: number): CanvasGradient {
  if (headGradCache && headGradCache.R === hR) return headGradCache.grad;
  const grad = ctx.createRadialGradient(-hR * 0.3, -hR * 0.4, hR * 0.2, 0, 0, hR);
  grad.addColorStop(0, '#f2d9b8');
  grad.addColorStop(1, '#d9a877');
  headGradCache = { R: hR, grad };
  return grad;
}

export function drawFighter(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  R: number,
  s: FighterStyle,
): void {
  const f = s.facing;
  const fx = Math.cos(f);
  const fy = Math.sin(f);
  // perpendicular (for arm placement)
  const px = -fy;
  const py = fx;

  const bob = Math.sin(s.walkPhase) * s.moving * R * 0.08;
  const sq = s.squash; // 0..1
  const bodyRx = R * (1 + sq * 0.28);
  const bodyRy = R * (1 - sq * 0.22);

  ctx.save();

  // ---- ground shadow ------------------------------------------------------
  ctx.beginPath();
  ctx.ellipse(x, y + R * 0.62, R * 0.98, R * 0.42, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.38)';
  ctx.fill();

  const cy = y + bob;

  // ---- arms (behind body) -------------------------------------------------
  const thrust = s.pushing * R * 0.5;
  const swing = Math.sin(s.walkPhase) * s.moving * R * 0.12;
  const armR = R * 0.34;
  const armDark = shade(s.color, -0.34);
  for (const side of [-1, 1]) {
    const ax = x + px * side * R * 0.72 + fx * (thrust + (side > 0 ? swing : -swing));
    const ay = cy + py * side * R * 0.72 + fy * (thrust + (side > 0 ? swing : -swing));
    ctx.beginPath();
    ctx.ellipse(ax, ay, armR, armR * 0.85, f, 0, Math.PI * 2);
    ctx.fillStyle = armDark;
    ctx.fill();
    ctx.lineWidth = R * 0.12;
    ctx.strokeStyle = VOID;
    ctx.stroke();
  }

  // ---- body ---------------------------------------------------------------
  // Cached gradient (built at the origin) + translate, so no per-frame alloc.
  ctx.save();
  ctx.translate(x, cy);
  ctx.beginPath();
  ctx.ellipse(0, 0, bodyRx, bodyRy, 0, 0, Math.PI * 2);
  ctx.fillStyle = bodyGradient(ctx, s.color, R);
  ctx.fill();
  ctx.lineWidth = R * 0.16;
  ctx.strokeStyle = VOID;
  ctx.stroke();
  ctx.restore();

  // belly highlight
  ctx.beginPath();
  ctx.ellipse(x - R * 0.28, cy - R * 0.3, R * 0.32, R * 0.22, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.22)';
  ctx.fill();

  // ---- mawashi belt (across the lower belly, perpendicular to facing) -----
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(x, cy, bodyRx, bodyRy, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(x, cy);
  ctx.rotate(f + Math.PI / 2);
  ctx.beginPath();
  ctx.rect(-R * 1.2, R * 0.12, R * 2.4, R * 0.42);
  ctx.fillStyle = shade(s.color, -0.5);
  ctx.fill();
  ctx.restore();

  // ---- head (pokes toward facing) ----------------------------------------
  const hx = x + fx * R * 0.5;
  const hy = cy + fy * R * 0.5 - R * 0.12;
  const hR = R * 0.44;
  // topknot behind
  ctx.beginPath();
  ctx.arc(hx - fx * hR * 0.5, hy - fy * hR * 0.5 - R * 0.08, hR * 0.45, 0, Math.PI * 2);
  ctx.fillStyle = '#241f2b';
  ctx.fill();
  // head (cached gradient via translate; same skin tone for everyone)
  ctx.save();
  ctx.translate(hx, hy);
  ctx.beginPath();
  ctx.arc(0, 0, hR, 0, Math.PI * 2);
  ctx.fillStyle = headGradient(ctx, hR);
  ctx.fill();
  ctx.lineWidth = R * 0.12;
  ctx.strokeStyle = VOID;
  ctx.stroke();
  ctx.restore();
  // eyes
  const ex = hx + fx * hR * 0.35;
  const ey = hy + fy * hR * 0.35;
  ctx.fillStyle = VOID;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(ex + px * side * hR * 0.4, ey + py * side * hR * 0.4, hR * 0.16, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// The eliminated stay as translucent, drifting spirits stuck to the rim.
export function drawGhostFighter(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  R: number,
  color: string,
  phase: number,
): void {
  const wob = Math.sin(phase * 2) * R * 0.08;
  ctx.save();
  ctx.globalAlpha = 0.5;
  // wispy tail
  ctx.beginPath();
  ctx.moveTo(x - R * 0.7, y + wob);
  ctx.quadraticCurveTo(x, y + R * 0.9 + wob, x + R * 0.7, y + wob);
  ctx.quadraticCurveTo(x, y + R * 0.3, x - R * 0.7, y + wob);
  ctx.fillStyle = color;
  ctx.fill();
  // head
  ctx.beginPath();
  ctx.arc(x, y - R * 0.15 + wob, R * 0.7, Math.PI, Math.PI * 2);
  ctx.fill();
  // eyes
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = '#0d0b0f';
  ctx.beginPath();
  ctx.arc(x - R * 0.25, y - R * 0.2 + wob, R * 0.12, 0, Math.PI * 2);
  ctx.arc(x + R * 0.25, y - R * 0.2 + wob, R * 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
