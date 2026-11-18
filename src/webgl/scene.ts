// 领域对象 → GL 网格构建器
import type {
  AirObstacle, AudienceArea, Building, FireworkType, LaunchPoint, SiteModel, SensitiveTarget, Vec3,
} from '../domain/types';
import { GLEngine } from './engine';
import { bufferPolygon, polygonCentroid } from '../lib/math';

export const COLORANT_RGB: Record<FireworkType['colorant'], Vec3> = {
  '锶盐(红)': [1.0, 0.18, 0.16],
  '钡盐(绿)': [0.25, 0.95, 0.35],
  '钠盐(黄)': [1.0, 0.82, 0.2],
  '铜盐(蓝)': [0.25, 0.5, 1.0],
  '钾盐(紫)': [0.72, 0.35, 1.0],
  '铝钛(银白)': [0.95, 0.95, 0.9],
  '混合': [1.0, 0.6, 0.4],
};

export function buildScene(
  gl: GLEngine,
  site: SiteModel,
  opts: { showBuffers?: boolean; showDuds?: Vec3[][]; showPlume?: boolean } = {},
) {
  gl.clear();
  buildGround(gl);
  site.buildings.forEach((b) => gl.addMesh(buildingMesh(b)));
  site.audience.forEach((a) => gl.addMesh(flatPolygonMesh(a.polygon, [0.15, 0.45, 0.85], 0.35)));
  site.evacRoutes.forEach((r) => addPolyline(gl, r.points, [0.1, 0.9, 0.4], 1.5));
  site.launchPoints.forEach((p) => addLaunchPoint(gl, p));
  site.sensitive.forEach((s) => {
    addMarker(gl, s.position, s.bufferViolated ? [1, 0.2, 0.1] : [1, 0.75, 0.1], 3);
    if (opts.showBuffers && s.requiredBuffer) {
      addPolygonOutline(gl, bufferPolygon([[s.position[0], s.position[1], s.position[2]]], s.requiredBuffer, 24), [1, 0.6, 0.1]);
    }
  });
  site.obstacles.forEach((o) => addObstacle(gl, o));
  site.waterSources.forEach((w) => addMarker(gl, w.position, [0.2, 0.7, 1], 2.2));
  if (opts.showDuds) {
    for (const zone of opts.showDuds) {
      gl.addMesh(flatPolygonMesh(zone, [1, 0.35, 0.05], 0.45));
      addPolygonOutline(gl, zone, [1, 0.5, 0.1]);
    }
  }
}

function buildGround(gl: GLEngine, extent = 300, step = 20) {
  const pos: number[] = [], color: number[] = [], normal: number[] = [];
  for (let i = -extent; i <= extent; i += step) {
    pos.push(i, -extent, 0, i, extent, 0);
    color.push(0.12, 0.14, 0.18, 0.12, 0.14, 0.18);
    normal.push(0, 0, 1, 0, 0, 1);
    pos.push(-extent, i, 0, extent, i, 0);
    color.push(0.12, 0.14, 0.18, 0.12, 0.14, 0.18);
    normal.push(0, 0, 1, 0, 0, 1);
  }
  gl.addLine(new Float32Array(pos), new Float32Array(color));
}

function buildingMesh(b: Building): Parameters<GLEngine['addMesh']>[0] {
  const c = polygonCentroid(b.footprint);
  const hot = b.insulation === 'B2级可燃' || b.insulation === 'B3级易燃';
  const base: Vec3 = hot ? [0.75, 0.35, 0.25] : [0.62, 0.6, 0.55];
  const pos: number[] = [], normal: number[] = [], color: number[] = [];
  const pushQuad = (a: Vec3, bb: Vec3, cc: Vec3, d: Vec3, n: Vec3) => {
    pos.push(...a, ...bb, ...cc, ...a, ...cc, ...d);
    for (let k = 0; k < 6; k++) {
      normal.push(...n);
      color.push(...base);
    }
  };
  // 侧面
  for (let i = 0; i < b.footprint.length; i++) {
    const p = b.footprint[i], q = b.footprint[(i + 1) % b.footprint.length];
    const top: Vec3 = [p[0], p[1], p[2] + b.height];
    const topQ: Vec3 = [q[0], q[1], q[2] + b.height];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    const len = Math.hypot(dx, dy) || 1;
    pushQuad(p, q, topQ, top, [-dy / len, dx / len, 0]);
  }
  // 顶面
  const top = b.footprint.map((p): Vec3 => [p[0], p[1], p[2] + b.height]);
  for (let i = 1; i < top.length - 1; i++) {
    pos.push(...top[0], ...top[i], ...top[i + 1]);
    for (let k = 0; k < 3; k++) {
      normal.push(0, 0, 1);
      color.push(...base.map((v) => v * 0.8));
    }
  }
  void c;
  return { pos: new Float32Array(pos), normal: new Float32Array(normal), color: new Float32Array(color) };
}

function flatPolygonMesh(poly: Vec3[], rgb: Vec3, alpha: number): Parameters<GLEngine['addMesh']>[0] {
  const pos: number[] = [], normal: number[] = [], color: number[] = [];
  for (let i = 1; i < poly.length - 1; i++) {
    pos.push(...poly[0], ...poly[i], ...poly[i + 1]);
    for (let k = 0; k < 3; k++) {
      normal.push(0, 0, 1);
      color.push(...rgb);
    }
  }
  return { pos: new Float32Array(pos), normal: new Float32Array(normal), color: new Float32Array(color), alpha };
}

function addPolygonOutline(gl: GLEngine, poly: Vec3[], rgb: Vec3) {
  const pos: number[] = [], color: number[] = [];
  const closed = [...poly, poly[0]];
  for (let i = 0; i < closed.length - 1; i++) {
    pos.push(...closed[i], ...closed[i + 1]);
    color.push(...rgb, ...rgb);
  }
  gl.addLine(new Float32Array(pos), new Float32Array(color));
}

function addPolyline(gl: GLEngine, pts: Vec3[], rgb: Vec3, width = 1) {
  const pos: number[] = [], color: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    pos.push(...pts[i], ...pts[i + 1]);
    color.push(...rgb, ...rgb);
  }
  gl.addLine(new Float32Array(pos), new Float32Array(color));
  void width;
}

function addLaunchPoint(gl: GLEngine, p: LaunchPoint) {
  const s = 1.6;
  const [e, n, h] = p.position;
  const pos = new Float32Array([
    e - s, n - s, h + 0.2, e + s, n + s, h + 0.2,
    e + s, n - s, h + 0.2, e - s, n + s, h + 0.2,
    e, n, h, e, n, h + 6,
  ]);
  const normals = new Float32Array(pos.length).fill(0);
  const colors = new Float32Array(pos.length);
  for (let i = 0; i < colors.length; i += 3) colors.set(p.temporaryStorage ? [1, 0.5, 0.1] : [1, 0.9, 0.3], i);
  gl.addMesh({ pos, normal: normals, color: colors, mode: gl.gl.LINES, alpha: 1 });
}

function addMarker(gl: GLEngine, p: Vec3, rgb: Vec3, r: number) {
  const seg = 18;
  const pos: number[] = [], normal: number[] = [], color: number[] = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    pos.push(p[0], p[1], p[2] + 0.3, p[0] + Math.cos(a0) * r, p[1] + Math.sin(a0) * r, p[2] + 0.3,
      p[0] + Math.cos(a1) * r, p[1] + Math.sin(a1) * r, p[2] + 0.3);
    for (let k = 0; k < 3; k++) { normal.push(0, 0, 1); color.push(...rgb); }
  }
  gl.addMesh({ pos: new Float32Array(pos), normal: new Float32Array(normal), color: new Float32Array(color), alpha: 0.6 });
}

function addObstacle(gl: GLEngine, o: AirObstacle) {
  const rgb: Vec3 = o.type === '高压线' ? [1, 0.4, 0.1] : [0.9, 0.2, 0.9];
  const a: Vec3 = [o.from[0], o.from[1], o.limitHeight];
  const b: Vec3 = [o.to[0], o.to[1], o.limitHeight];
  const pos = new Float32Array([...o.from, ...a, ...a, ...b, ...b, ...o.to]);
  const color = new Float32Array(12);
  for (let i = 0; i < 4; i++) color.set(rgb, i * 3);
  gl.addLine(pos, color);
}

// ---------------- 极简 GLB 2.0 解析（仅非压缩网格，倾斜摄影导出时禁用 Draco） ----------------

export function parseGlb(buffer: ArrayBuffer): { pos: Float32Array; normal: Float32Array; color: Float32Array } | null {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) return null; // 'glTF'
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
  const binOffset = 20 + jsonLen;
  const binLen = dv.getUint32(binOffset - 8, true);
  const bin = new Uint8Array(buffer, binOffset, binLen);
  const mesh = json.meshes?.[0];
  const prim = mesh?.primitives?.[0];
  if (!prim) return null;
  const accPos = json.accessors[prim.attributes.POSITION];
  const accNorm = prim.attributes.NORMAL ? json.accessors[prim.attributes.NORMAL] : null;
  const bvPos = bufferView(json, bin, accPos.bufferView);
  const pos = new Float32Array(bvPos.buffer, bvPos.byteOffset, accPos.count * 3);
  let normal: Float32Array;
  if (accNorm) {
    const bv = bufferView(json, bin, accNorm.bufferView);
    normal = new Float32Array(bv.buffer, bv.byteOffset, accNorm.count * 3);
  } else {
    normal = new Float32Array(accPos.count * 3);
    normal.fill(1 / Math.sqrt(3));
  }
  const color = new Float32Array(accPos.count * 3);
  for (let i = 0; i < accPos.count; i++) color.set([0.68, 0.66, 0.6], i * 3);
  return { pos, normal, color };
}

function bufferView(json: any, bin: Uint8Array, idx: number) {
  const bv = json.bufferViews[idx];
  return { buffer: bin.buffer, byteOffset: (bin.byteOffset ?? 0) + (bv.byteOffset ?? 0) };
}

export function audienceList(site: SiteModel): AudienceArea[] {
  return site.audience;
}
