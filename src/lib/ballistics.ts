// 弹道近似、风偏、残骸落点与哑弹散布（蒙特卡洛）
import type { FireworkType, LaunchPoint, Vec3, WindCondition } from '../domain/types';
import { D2R, mulberry32, randn, uid } from './math';

export interface BallisticSolution {
  burstPos: Vec3;       // 开爆点
  apex: number;         // 轨迹最高点高程
  nominalLand: Vec3;    // 哑弹理论落点（无风）
  windLand: Vec3;       // 风偏修正落点
  fragmentLand: Vec3;   // 正常残骸落心（风偏）
  dispersionRadius: number;
}

/**
 * 简化外弹道：
 *  - 正常弹：升至 burstHeight 开爆，残骸从开爆点自由落体+风偏
 *  - 哑弹：未开爆整体下落，发射倾角导致水平分量，落地为 nominalLand
 *  - 风偏：下落时间 t = sqrt(2h/g)，水平漂移 v·t·经验系数
 */
export function solveBallistic(
  lp: LaunchPoint,
  fw: FireworkType,
  wind: WindCondition,
  rngSeed = 1,
): BallisticSolution {
  const g = 9.81;
  const tilt = (lp.tiltAngle ?? 0) * D2R;
  const az = ((lp.orientation ?? 0) * D2R);
  const h = fw.burstHeight;
  const [e0, n0, h0] = lp.position;
  const burstPos: Vec3 = [
    e0 + Math.sin(az) * h * Math.sin(tilt),
    n0 + Math.cos(az) * h * Math.sin(tilt),
    h0 + h * Math.cos(tilt),
  ];
  const fallT = Math.sqrt((2 * (burstPos[2] - h0)) / g);

  // 风向：来风方向，风的运动方向 = 风向+180°
  const windRad = (wind.direction + 180) * D2R;
  const drift = wind.speed * fallT;
  const windDE = Math.sin(windRad) * drift;
  const windDN = Math.cos(windRad) * drift;

  // 哑弹：保留上升水平速度（按倾角估），落点在发射方向，再叠加风偏
  const launchRange = h * Math.tan(tilt) * 0.6; // 阻力损耗经验系数
  const nominalLand: Vec3 = [
    e0 + Math.sin(az) * launchRange,
    n0 + Math.cos(az) * launchRange,
    h0,
  ];
  const windLand: Vec3 = [
    nominalLand[0] + windDE,
    nominalLand[1] + windDN,
    h0,
  ];
  const fragmentLand: Vec3 = [
    burstPos[0] + windDE,
    burstPos[1] + windDN,
    h0,
  ];

  // 蒙特卡洛散布（发射扰动 + 风脉动），取 95% 半径
  const rng = mulberry32(rngSeed);
  let maxR = 0;
  const N = 60;
  for (let i = 0; i < N; i++) {
    const gust = wind.speed * (0.25 + 0.5 * rng());
    const dE = Math.sin(windRad) * gust * fallT + randn(rng) * fw.fragmentRange * 0.08;
    const dN = Math.cos(windRad) * gust * fallT + randn(rng) * fw.fragmentRange * 0.08;
    maxR = Math.max(maxR, Math.hypot(dE, dN));
  }
  return { burstPos, apex: burstPos[2], nominalLand, windLand, fragmentLand, dispersionRadius: maxR };
}

/** 哑弹处置警戒区：以风偏落点为中心、散布半径为半径的 32 边多边形 */
export function exclusionZone(center: Vec3, radius: number, seg = 32): Vec3[] {
  const poly: Vec3[] = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    poly.push([center[0] + Math.cos(a) * radius, center[1] + Math.sin(a) * radius, center[2]]);
  }
  return poly;
}

/** 进场路线：从最近观众席边界/集合点直线趋近，避开建筑（简化为折线到警戒区边缘再到中心） */
export function approachRoute(staging: Vec3, center: Vec3, radius: number): Vec3[] {
  const d = Math.hypot(center[0] - staging[0], center[1] - staging[1]) || 1;
  const edge: Vec3 = [
    center[0] - ((center[0] - staging[0]) / d) * (radius + 2),
    center[1] - ((center[1] - staging[1]) / d) * (radius + 2),
    center[2],
  ];
  return [staging, edge, center];
}

export function dudId(seed: number) {
  return uid(`dud_${seed}`);
}
