import type { Vec3 } from '../domain/types';

export const TAU = Math.PI * 2;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const dist2 = (a: Vec3, b: Vec3) => {
  const dx = a[0] - b[0], dy = a[1] - b[1], dz = (a[2] ?? 0) - (b[2] ?? 0);
  return dx * dx + dy * dy + dz * dz;
};
export const dist = (a: Vec3, b: Vec3) => Math.sqrt(dist2(a, b));
export const distXY = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const uid = (prefix = 'id'): string =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

export function fmt(n: number, digits = 2): string {
  if (!isFinite(n)) return '—';
  return n.toFixed(digits);
}

/** 点到线段距离（三维） */
export function pointSegmentDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], (b[2] ?? 0) - (a[2] ?? 0)];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], (p[2] ?? 0) - (a[2] ?? 0)];
  const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = len2 === 0 ? 0 : clamp((ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / len2, 0, 1);
  const q: Vec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, (a[2] ?? 0) + ab[2] * t];
  return dist(p, q);
}

/** 点在多边形内（二维射线法） */
export function pointInPolygon(p: Vec3, poly: Vec3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const intersect = yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function polygonCentroid(poly: Vec3[]): Vec3 {
  let e = 0, n = 0, h = 0, a2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const cross = p[0] * q[1] - q[0] * p[1];
    e += (p[0] + q[0]) * cross;
    n += (p[1] + q[1]) * cross;
    h += (p[2] ?? 0) * Math.abs(cross);
    a2 += cross;
  }
  const area = Math.abs(a2) / 2 || 1e-9;
  return [e / (6 * area), n / (6 * area), h / (2 * area)];
}

export function bufferPolygon(poly: Vec3[], radius: number, seg = 24): Vec3[] {
  // 简易外缓冲：取质心外扩顶点 + 圆弧采样（报批图示意级精度）
  const c = polygonCentroid(poly);
  const out: Vec3[] = [];
  for (const v of poly) {
    const ang = Math.atan2(v[1] - c[1], v[0] - c[0]);
    for (let k = 0; k < seg / poly.length; k++) {
      const a = ang + (k / (seg / poly.length)) * (TAU / poly.length);
      const d = distXY(v, c) + radius;
      out.push([c[0] + Math.cos(a) * d, c[1] + Math.sin(a) * d, v[2] ?? c[2]]);
    }
  }
  return out;
}

/** 高斯-勒让德 4 点积分（烟羽浓度体积累积备用） */
export function gaussLegendre4(fn: (x: number) => number, a: number, b: number): number {
  const xs = [-0.861136, -0.339981, 0.339981, 0.861136];
  const ws = [0.347855, 0.652145, 0.652145, 0.347855];
  const m = (b - a) / 2, s = (a + b) / 2;
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += ws[i] * fn(m * xs[i] + s);
  return m * sum;
}

/** 经纬度→本地工程平面（局部等距圆柱投影，以参考点为原点，单位 m） */
export function lonLatToLocal(lon: number, lat: number, refLon: number, refLat: number): Vec3 {
  const mPerDeg = 111320;
  return [
    (lon - refLon) * mPerDeg * Math.cos(refLat * D2R),
    (lat - refLat) * mPerDeg,
    0,
  ];
}

export function localToLonLat(e: number, n: number, refLon: number, refLat: number): [number, number] {
  const mPerDeg = 111320;
  return [refLon + e / (mPerDeg * Math.cos(refLat * D2R)), refLat + n / mPerDeg];
}

/** 反距离加权地形插值 */
export function idwElevation(pts: Vec3[], e: number, n: number, power = 2): number | null {
  if (!pts.length) return null;
  let wsum = 0, vsum = 0;
  for (const p of pts) {
    const d = Math.hypot(p[0] - e, p[1] - n);
    if (d < 0.5) return p[2];
    const w = 1 / Math.pow(d, power);
    wsum += w; vsum += w * p[2];
  }
  return vsum / wsum;
}

/** 确定性伪随机（蒙特卡洛可复现） */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 标准正态抽样（Box-Muller，确定性 rng） */
export function randn(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
}
