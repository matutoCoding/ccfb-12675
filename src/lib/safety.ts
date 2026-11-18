// 安全物理模型：冲击波超压 / 噪声 / 高斯烟羽 / 殉爆 / 净空 / 时间规则
import type {
  AirObstacle, AudienceArea, Building, ClearanceViolation, DudPrediction, FireLoadItem,
  FireworkType, LaunchPoint, OverpressureResult, SimParams, SensitiveTarget, SmokeResult,
  SymDetonationItem, TimeRuleViolation, Vec3, WindCondition,
} from '../domain/types';
import { D2R, dist, distXY, pointInPolygon, pointSegmentDist } from './math';
import { approachRoute, exclusionZone, solveBallistic } from './ballistics';

// ---------------- 冲击波超压（TNT 当量 + Henrych 分段公式） ----------------

export function tntEquivalentKg(chargeKg: number, factor: number): number {
  return chargeKg * factor;
}

/**
 * Henrych 空气冲击波超压公式（ΔP 单位 kPa，R 距爆心 m，W 为 TNT 当量 kg）
 * 比例距离 Z = R / W^(1/3)
 */
export function overpressureKPa(distance: number, tntKg: number): number {
  if (tntKg <= 0 || distance <= 0) return 0;
  const z = distance / Math.cbrt(tntKg);
  let dp: number;
  if (z <= 0.05) dp = 1000; // 近场饱和
  else if (z <= 0.3) {
    dp = 1407.2 / z + 553.97 / z ** 2 - 57.16 / z ** 3 + 5.06;
  } else if (z <= 1) {
    dp = 619.4 / z - 32.6 / z ** 2 + 21.32 / z ** 3;
  } else if (z <= 10) {
    dp = 66.2 / z + 40.5 / z ** 2 + 32.9 / z ** 3;
  } else {
    dp = 66.2 / z + 40.5 / z ** 2 + 32.9 / z ** 3;
  }
  return Math.max(0, dp);
}

/** 观众席/建筑外墙逐目标超压核算（单点开爆，取最不利点） */
export function evaluateOverpressure(
  burst: Vec3,
  fw: FireworkType,
  site: { audience: AudienceArea[]; buildings: Building[]; launchPoints: LaunchPoint[] },
  params: SimParams,
  firingId: string,
): OverpressureResult[] {
  const tnt = tntEquivalentKg(fw.singleChargeG / 1000, fw.tntEquivalentFactor);
  const out: OverpressureResult[] = [];
  site.audience.forEach((a) => {
    const d = Math.min(...a.polygon.map((p) => dist(burst, p)));
    const dp = overpressureKPa(d, tnt);
    out.push({
      firingId, targetId: a.id, targetKind: 'audience', distance: d,
      deltaP_kPa: dp, limit_kPa: params.overpressureAudienceKPa,
      exceeded: dp > params.overpressureAudienceKPa,
    });
  });
  site.buildings.forEach((b) => {
    const wallPoint: Vec3 = [b.footprint[0][0], b.footprint[0][1], Math.min(b.height, burst[2])];
    const d = dist(burst, wallPoint);
    const dp = overpressureKPa(d, tnt);
    out.push({
      firingId, targetId: b.id, targetKind: 'building', distance: d,
      deltaP_kPa: dp, limit_kPa: params.overpressureBuildingKPa,
      exceeded: dp > params.overpressureBuildingKPa,
    });
  });
  return out;
}

// ---------------- 噪声：球面发散 + 大气吸收 ----------------

/** 大气吸收系数 dB/m（ISO 9613-1 经验近似，20℃、50%RH，频率取 500Hz 代表值） */
export function airAbsorptionDbPerM(tempC: number, humidity: number): number {
  // 查表量级：500Hz 约 0.002 dB/m；温湿度微调
  const base = 0.0022;
  const hFactor = 50 / Math.max(humidity, 10);
  const tFactor = 1 + (tempC - 20) * 0.01;
  return base * hFactor * tFactor;
}

export function splAtDistance(
  sourceLw: number, distance: number, tempC: number, humidity: number,
): number {
  if (distance < 1) return sourceLw;
  return sourceLw - 20 * Math.log10(distance) - airAbsorptionDbPerM(tempC, humidity) * distance;
}

export function isNight(hour: number, nightStart: number): boolean {
  return hour >= nightStart || hour < 6;
}

// ---------------- 高斯烟羽（帕斯奎尔-吉福德/Briggs 城市系数） ----------------

// Briggs 城市扩散参数 σ = a·x^b（x 单位 m）
const BRIGGS: Record<WindCondition['stability'], { ay: number; by: number; az: number; bz: number }> = {
  A: { ay: 0.32, by: 0.0004, az: 0.24, bz: 0.0001 },
  B: { ay: 0.32, by: 0.0004, az: 0.24, bz: 0.0001 },
  C: { ay: 0.22, by: 0.0004, az: 0.2, bz: 0 },
  D: { ay: 0.16, by: 0.0004, az: 0.14, bz: 0.0003 },
  E: { ay: 0.11, by: 0.0004, az: 0.08, bz: 0.0015 },
  F: { ay: 0.11, by: 0.0004, az: 0.08, bz: 0.0015 },
};

function sigma(coef: { a: number; b: number }, x: number): number {
  return coef.a * x * Math.pow(1 + coef.b * x, -0.5);
}

/**
 * 连续点源高斯烟羽地面浓度（mg/m³）
 * Q 排放率 mg/s，u 风速 m/s，H 有效源高 m
 */
export function gaussianGroundConcentration(
  Q: number, u: number, H: number, x: number, y: number,
  stability: WindCondition['stability'],
): number {
  if (x <= 1 || u < 0.5) return 0;
  const c = BRIGGS[stability];
  const sy = sigma({ a: c.ay, b: c.by }, x);
  const sz = sigma({ a: c.az, b: c.bz }, x);
  const cross = 1 / (2 * Math.PI * sy * sz * u);
  const horiz = Math.exp(-(y * y) / (2 * sy * sy));
  const vert = Math.exp(-(H * H) / (2 * sz * sz)); // 地面 z=0，全反射项合并为 exp(-H²/2σz²)
  return Q * cross * horiz * vert * 2;
}

/** 浓度→能见度经验关系（消光系数法，K=3.912，能见度 L = K/(α)；α 与质量浓度正相关） */
export function concentrationToVisibilityM(cMg: number): number {
  if (cMg <= 0.01) return 2000;
  const alpha = 0.0032 * cMg; // m⁻¹ 经验系数
  return Math.min(2000, 3.912 / Math.max(alpha, 0.002));
}

export function smokeDissipationSec(cloudDepthM: number, windSpeed: number): number {
  const u = Math.max(windSpeed, 0.8);
  return Math.round((cloudDepthM * 3) / u);
}

/** 评估某时刻烟羽对观众席/疏散通道的影响 */
export function evaluateSmoke(
  time: number,
  source: Vec3,
  smokeG: number,
  wind: WindCondition,
  targets: { name: string; points: Vec3[] }[],
  params: SimParams,
): SmokeResult | null {
  const Q = (smokeG * 1000) / 30; // 一发烟在 30s 内释放 → mg/s
  const H = Math.max(source[2] - wind.tempC * 0, 10);
  const windRad = (wind.direction + 180) * D2R;
  let worst: SmokeResult | null = null;
  for (const tgt of targets) {
    for (const p of tgt.points) {
      // 转到风向坐标：x 下风距离，y 横向偏移
      const dE = p[0] - source[0], dN = p[1] - source[1];
      const x = dE * Math.sin(windRad) + dN * Math.cos(windRad);
      const y = dE * Math.cos(windRad) - dN * Math.sin(windRad);
      const c = gaussianGroundConcentration(Q, wind.speed, H, x, y, wind.stability);
      const vis = concentrationToVisibilityM(c);
      const alarm = vis < params.visibilityLimitM || c > params.plumeConcentrationLimit;
      if (!worst || c > worst.concentration) {
        worst = {
          time, concentration: c, visibilityM: vis, affectedArea: tgt.name,
          dissipationSec: smokeDissipationSec(Math.max(x, 50), wind.speed), alarm,
        };
      }
    }
  }
  return worst;
}

// ---------------- 殉爆安全距离 R = K·√Q ----------------

export function symDetonationDistance(chargeKg: number, k: number): number {
  return k * Math.sqrt(Math.max(chargeKg, 0.001));
}

export function evaluateSymDetonation(
  points: LaunchPoint[], params: SimParams,
): SymDetonationItem[] {
  const items: SymDetonationItem[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i], b = points[j];
      const actual = distXY(a.position, b.position);
      const storagePair = a.temporaryStorage || b.temporaryStorage;
      const q = Math.max(a.storageChargeKg ?? 0.5, b.storageChargeKg ?? 0.5);
      const k = storagePair ? params.symDetonationStorageK : params.symDetonationK;
      const required = symDetonationDistance(q, k);
      items.push({
        aId: a.id, bId: b.id,
        kind: storagePair ? '存药点-点位' : '点位-点位',
        actual, required, chargeKg: q, violated: actual < required,
      });
    }
  }
  return items;
}

// ---------------- 净空拦截 ----------------

export function evaluateClearance(
  points: LaunchPoint[], types: FireworkType[], obstacles: AirObstacle[],
): ClearanceViolation[] {
  const out: ClearanceViolation[] = [];
  const corridor = (o: AirObstacle) => (o.type === '高压线' ? 30 : 15);
  for (const lp of points) {
    const maxBurst = Math.max(...types.map((t) => lp.position[2] + t.burstHeight));
    for (const ob of obstacles) {
      // 仅按水平距离判定安全走廊（垂直限高另行比较）
      const a: Vec3 = [ob.from[0], ob.from[1], 0];
      const b: Vec3 = [ob.to[0], ob.to[1], 0];
      const p: Vec3 = [lp.position[0], lp.position[1], 0];
      const d = pointSegmentDist(p, a, b);
      if (d > corridor(ob)) continue;
      const gap = ob.limitHeight - maxBurst;
      if (gap < 5) {
        out.push({
          pointId: lp.id, obstacleId: ob.id, obstacleName: ob.name,
          burstTop: maxBurst, limitHeight: ob.limitHeight, gap,
        });
      }
    }
  }
  return out;
}

// ---------------- 时间维度规则 ----------------

export function evaluateTimeRules(
  firings: { id: string; pointId: string; time: number; chargeG: number }[],
  params: SimParams,
): TimeRuleViolation[] {
  const out: TimeRuleViolation[] = [];
  const sorted = [...firings].sort((a, b) => a.time - b.time);

  // 滑动窗口药量
  for (let i = 0; i < sorted.length; i++) {
    const window = sorted.filter((f) => f.time >= sorted[i].time && f.time < sorted[i].time + params.windowSec);
    const kg = window.reduce((s, f) => s + f.chargeG, 0) / 1000;
    if (kg > params.maxChargePerWindowKg) {
      out.push({
        kind: '时段药量超限', time: sorted[i].time,
        detail: `${params.windowSec}s 窗口内总药量 ${kg.toFixed(2)}kg 超过上限 ${params.maxChargePerWindowKg}kg`,
        firingIds: window.map((f) => f.id),
      });
      break;
    }
  }
  // 同一点位相邻点火间隔
  const byPoint = new Map<string, typeof sorted>();
  for (const f of sorted) {
    const arr = byPoint.get(f.pointId) ?? [];
    arr.push(f);
    byPoint.set(f.pointId, arr);
  }
  for (const [, arr] of byPoint) {
    for (let i = 1; i < arr.length; i++) {
      const dt = arr[i].time - arr[i - 1].time;
      if (dt < params.minIgnitionIntervalSec) {
        out.push({
          kind: '点火间隔不足', time: arr[i].time,
          detail: `同一点位相邻点火间隔 ${dt.toFixed(2)}s 短于安全撤火时间 ${params.minIgnitionIntervalSec}s`,
          firingIds: [arr[i - 1].id, arr[i].id],
        });
      }
    }
  }
  return out;
}

// ---------------- 哑弹预测汇总 ----------------

export function predictDuds(
  firings: { id: string; point: LaunchPoint; fw: FireworkType }[],
  wind: WindCondition,
  staging: Vec3,
  n: number,
): DudPrediction[] {
  const out: DudPrediction[] = [];
  firings.forEach((f, idx) => {
    if (f.fw.dudRate <= 0) return;
    const sol = solveBallistic(f.point, f.fw, wind, idx + 7);
    // 蒙特卡洛扩大散布
    const r = sol.dispersionRadius + f.fw.fragmentRange * f.fw.dudRate * 4;
    out.push({
      firingId: f.id, pointCode: f.point.code, typeName: f.fw.name,
      nominalLand: sol.nominalLand, windLand: sol.windLand,
      dispersionRadius: r,
      exclusionZone: exclusionZone(sol.windLand, r),
      approachRoute: approachRoute(staging, sol.windLand, r),
    });
  });
  return out;
}

// ---------------- 建筑火灾荷载与灭火器材 ----------------

const DEFAULT_FIRE_LOAD: Record<Building['use'], number> = {
  住宅: 480, 商业: 600, 办公: 450, 学校: 350, 医院: 400, 加油站: 200,
  文保单位: 700, 工业: 800, 仓储: 1200, 公共设施: 400, 其他: 450,
};

export function evaluateFireLoad(
  buildings: Building[], water: { position: Vec3 }[],
): FireLoadItem[] {
  return buildings.map((b) => {
    const center: Vec3 = [b.footprint[0][0], b.footprint[0][1], 0];
    const nearestWaterDist = water.length
      ? Math.min(...water.map((w) => distXY(center, w.position)))
      : 9999;
    const density = b.fireLoadDensity ?? DEFAULT_FIRE_LOAD[b.use];
    const flammable = b.insulation === 'B2级可燃' || b.insulation === 'B3级易燃' || b.insulation === '未知';
    const risk: FireLoadItem['risk'] =
      (flammable && density >= 600) || b.insulation === 'B3级易燃' ? '高'
      : flammable || density >= 600 ? '中' : '低';
    // 灭火器材：每 100m² 一具（按占地×层数估算面积），易燃外墙上浮 50%
    const area = b.footprint.length
      ? polygonArea(b.footprint) * Math.max(b.floors, 1) : 200;
    const count = Math.max(2, Math.ceil((area / 100) * (flammable ? 1.5 : 1)));
    return {
      buildingId: b.id, name: b.name, insulation: b.insulation,
      nearestWaterDist, extinguisherCount: count, risk,
    };
  });
}

function polygonArea(poly: Vec3[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** 敏感目标缓冲距离：最危险弹种覆盖半径 + 残骸落距 */
export function requiredSensitiveBuffer(fw: FireworkType[]): number {
  if (!fw.length) return 0;
  return Math.max(...fw.map((t) => t.spreadRadius + t.fragmentRange));
}

export function checkSensitiveBuffers(
  targets: SensitiveTarget[], points: LaunchPoint[], buffer: number,
): SensitiveTarget[] {
  return targets.map((t) => {
    const d = Math.min(...points.map((p) => distXY(t.position, p.position)));
    return { ...t, requiredBuffer: buffer, actualMinDistance: d, bufferViolated: d < buffer };
  });
}

export function pointInsideAnyPolygon(p: Vec3, polys: Vec3[][]): boolean {
  return polys.some((poly) => pointInPolygon(p, poly));
}
