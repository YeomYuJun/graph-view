// ─────────────────────────────────────────────────────────────────────────────
// Entity type → color
//
// Strategy: stable per-type ordering + golden-angle hue distribution.
//   1. The first time a type is seen we append it to TYPE_ORDER and persist.
//   2. That index drives the hue: `hue = i * 137.5077° (mod 360)`.
//      The golden angle is the rotation that minimizes hue bunching for ANY N
//      — adding a 13th, 50th, 100th type still produces a hue that is as far
//      as possible from every existing one.
//   3. Convert OKLCH(L, C, hue) → sRGB hex. OKLCH is used (not HSL) because it
//      is perceptually uniform — two hues that are 30° apart in OKLCH look
//      equally far apart to the eye, which HSL gets wrong (esp. yellows).
//
// Trade-off: index → hue is stable across page reloads (localStorage) and
// monotonic when new types appear. Removing a type does NOT compact the order
// — if it ever comes back, it keeps the same color.
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "graph-view:type-order";

let TYPE_ORDER: string[] = [];
try {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) TYPE_ORDER = parsed.filter((x) => typeof x === "string");
  }
} catch {
  /* ignore — fall back to fresh order */
}

function persistOrder(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(TYPE_ORDER));
  } catch {
    /* localStorage full / blocked — just keep in-memory order */
  }
}

function indexOfType(type: string): number {
  let idx = TYPE_ORDER.indexOf(type);
  if (idx === -1) {
    idx = TYPE_ORDER.length;
    TYPE_ORDER.push(type);
    persistOrder();
  }
  return idx;
}

// Minimal semantic anchors — keep this list intentionally small. Anything not
// in here goes through the algorithm. Add an entry only if there is a strong
// convention (e.g. "Person == cool blue").
const PRESET: Record<string, string> = {
  person: "#a3b7d4", Person: "#a3b7d4",
};

// Lightness / chroma constants — tuned to the Claude-tone dark redesign. Same
// L/C across all hues so the set reads as cohesive; C is bumped a touch above
// the prior fixed palette to give more vivid variation between adjacent types.
const L_BASE = 0.74;
const C_BASE = 0.11;
const GOLDEN_ANGLE = 137.50776405003785;

export function colorForType(type: string): string {
  if (PRESET[type]) return PRESET[type];
  const i = indexOfType(type);
  const hue = (i * GOLDEN_ANGLE) % 360;
  return oklchToHex(L_BASE, C_BASE, hue);
}

// Convert OKLCH → sRGB hex. Reference: https://bottosson.github.io/posts/oklab/
// Out-of-gamut colors clip linearly (causes small hue shift at the edges,
// acceptable for the L/C we use).
function oklchToHex(L: number, C: number, H: number): string {
  const hRad = (H * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);

  // OKLab → LMS
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l3 = l_ * l_ * l_;
  const m3 = m_ * m_ * m_;
  const s3 = s_ * s_ * s_;

  // LMS → linear sRGB
  let r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  let g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  let bb = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3;

  // Linear → sRGB (gamma encode)
  const enc = (x: number): number =>
    x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  r = enc(r);
  g = enc(g);
  bb = enc(bb);

  const to8 = (v: number): string => {
    const n = Math.round(Math.max(0, Math.min(1, v)) * 255);
    return n.toString(16).padStart(2, "0");
  };
  return "#" + to8(r) + to8(g) + to8(bb);
}
