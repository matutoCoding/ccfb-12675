// 整场安全仿真：汇总超压/噪声/烟雾/殉爆/净空/残骸/时间规则，生成拦截报告
import type {
  Choreography, DudPrediction, FireworkType, NoiseResult, SimulationReport,
  SimParams, SiteModel, SmokeResult, SensitiveTarget, OverpressureResult,
} from '../domain/types';
export type { SimulationReport } from '../domain/types';
import { distXY, pointInPolygon } from './math';
import { solveBallistic } from './ballistics';
import {
  checkSensitiveBuffers, evaluateClearance, evaluateFireLoad, evaluateOverpressure,
  evaluateSmoke, evaluateSymDetonation, evaluateTimeRules, isNight, predictDuds,
  requiredSensitiveBuffer, splAtDistance,
} from './safety';
import type { LicenseLevel } from '../domain/types';

const LEVEL_RANK: Record<LicenseLevel, number> = { A: 4, B: 3, C: 2, D: 1 };
const FW_RANK: Record<FireworkType['level'], number> = { A级: 4, B级: 3, C级: 2, D级: 1 };

/** 单点位药量上限（kg，按场次级别口径，可在代码常量维护） */
const POINT_CHARGE_LIMIT: Record<LicenseLevel, number> = { A: 60, B: 30, C: 10, D: 3 };

export interface ChargeSummary {
  totalKg: number;
  perPoint: Record<string, number>;
  perType: Record<string, number>;
}

export function summarizeCharge(
  choreo: Choreography, types: FireworkType[],
): ChargeSummary {
  const map = new Map(types.map((t) => [t.id, t]));
  const perPoint: Record<string, number> = {};
  const perType: Record<string, number> = {};
  let total = 0;
  for (const f of choreo.firings) {
    const t = map.get(f.typeId);
    if (!t) continue;
    const kg = t.singleChargeG / 1000;
    total += kg;
    perPoint[f.pointId] = (perPoint[f.pointId] ?? 0) + kg;
    perType[t.id] = (perType[t.id] ?? 0) + 1;
  }
  return { totalKg: total, perPoint, perType };
}

export interface FullSimInput {
  site: SiteModel;
  types: FireworkType[];
  choreo: Choreography;
  params: SimParams;
  licenseLevel: LicenseLevel;
  showStart?: string; // HH:mm:ss
}

export function runFullSimulation(input: FullSimInput): SimulationReport {
  const { site, types, choreo, params, licenseLevel, showStart } = input;
  const startHour = parseStartHour(showStart);
  const typeMap = new Map(types.map((t) => [t.id, t]));
  const pointMap = new Map(site.launchPoints.map((p) => [p.id, p]));
  const charge = summarizeCharge(choreo, types);

  const levelViolations: string[] = [];
  const overpressure: OverpressureResult[] = [];
  const noise: NoiseResult[] = [];
  const smoke: SmokeResult[] = [];
  const fragmentOuts: SimulationReport['fragmentOuts'] = [];
  const dudInputs: { id: string; point: (typeof site.launchPoints)[number]; fw: FireworkType }[] = [];
  const timeRuleInput: { id: string; pointId: string; time: number; chargeG: number }[] = [];

  // 级别 / 资质拦截
  for (const f of choreo.firings) {
    const t = typeMap.get(f.typeId);
    const p = pointMap.get(f.pointId);
    if (!t || !p) continue;
    if (FW_RANK[t.level] > LEVEL_RANK[licenseLevel]) {
      levelViolations.push(`发次 ${f.id}：弹种「${t.name}」为 ${t.level}，超出 ${licenseLevel} 级场次许可，已拦截`);
    }
    timeRuleInput.push({ id: f.id, pointId: f.pointId, time: f.time, chargeG: t.singleChargeG });
  }
  for (const [pid, kg] of Object.entries(charge.perPoint)) {
    if (kg > POINT_CHARGE_LIMIT[licenseLevel]) {
      levelViolations.push(`点位 ${pid} 总药量 ${kg.toFixed(2)}kg 超过 ${licenseLevel} 级单点位上限 ${POINT_CHARGE_LIMIT[licenseLevel]}kg，已拦截`);
    }
  }

  // 逐发次物理核算
  for (const f of choreo.firings) {
    const t = typeMap.get(f.typeId);
    const p = pointMap.get(f.pointId);
    if (!t || !p) continue;
    const sol = solveBallistic(p, t, site.wind, hashSeed(f.id));

    overpressure.push(...evaluateOverpressure(sol.burstPos, t, site, params, f.id));

    const hour = startHour + f.time / 3600;
    const night = isNight(hour % 24, params.nightStartHour);
    const limit = night ? params.nightLimitDb : params.dayLimitDb;
    const noiseTargets: SensitiveTarget[] = site.sensitive;
    for (const st of noiseTargets) {
      const d = Math.max(distXY(sol.burstPos, st.position), 1);
      const spl = splAtDistance(t.soundPowerLevel, d, site.wind.tempC, site.wind.humidity);
      noise.push({
        firingId: f.id, targetId: st.id, targetName: st.name, isNight: night,
        distance: d, spl_dB: spl, limit_dB: limit, exceeded: spl > limit, time: f.time,
      });
    }

    // 烟雾：观众席 + 疏散通道
    const smokeTargets = [
      ...site.audience.map((a) => ({ name: `观众席·${a.name}`, points: a.polygon })),
      ...site.evacRoutes.map((r) => ({ name: `疏散通道·${r.name}`, points: r.points })),
    ];
    const sm = evaluateSmoke(f.time, sol.burstPos, t.smokeFactor, site.wind, smokeTargets, params);
    if (sm && sm.alarm) smoke.push(sm);

    // 残骸越界：落入观众席或敏感目标缓冲区内
    const inAudience = site.audience.some((a) => pointInPolygon(sol.fragmentLand, a.polygon));
    const inBuffer = site.sensitive.some((s) => distXY(sol.fragmentLand, s.position) < (s.requiredBuffer ?? 0) * 0.5);
    fragmentOuts.push({
      firingId: f.id, pointCode: p.code, land: sol.windLand,
      crossedBoundary: inAudience || inBuffer,
    });

    if (t.dudRate > 0) dudInputs.push({ id: f.id, point: p, fw: t });
  }

  const sym = evaluateSymDetonation(site.launchPoints, params);
  const clearance = evaluateClearance(site.launchPoints, types, site.obstacles);
  const timeRules = evaluateTimeRules(timeRuleInput, params);
  const fireLoad = evaluateFireLoad(site.buildings, site.waterSources);

  const buffer = requiredSensitiveBuffer(types);
  const sensitiveBuffer = checkSensitiveBuffers(site.sensitive, site.launchPoints, buffer);

  const staging: [number, number, number] = site.audience[0]?.polygon[0]
    ?? [0, 0, site.groundElevation];
  const duds: DudPrediction[] = predictDuds(dudInputs, site.wind, staging, params.dudMonteCarloN);

  const hardFail =
    levelViolations.length > 0 ||
    clearance.length > 0 ||
    overpressure.some((o) => o.exceeded) ||
    sym.some((s) => s.violated) ||
    timeRules.length > 0 ||
    fragmentOuts.some((f) => f.crossedBoundary) ||
    sensitiveBuffer.some((s) => s.bufferViolated);

  const maxSingle = Math.max(0, ...Object.values(charge.perPoint));

  return {
    generatedAt: Date.now(),
    totalFirings: choreo.firings.length,
    totalChargeKg: charge.totalKg,
    maxSinglePointChargeKg: maxSingle,
    levelViolations,
    clearance,
    overpressure,
    noise,
    smoke,
    symDetonation: sym,
    duds,
    fragmentOuts,
    timeRules,
    fireLoad,
    sensitiveBuffer,
    passed: !hardFail,
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 100000;
}

function parseStartHour(showStart?: string): number {
  if (!showStart) return 20;
  const m = showStart.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return 20;
  return Number(m[1]) + Number(m[2]) / 60 + (m[3] ? Number(m[3]) / 3600 : 0);
}

// ============================================================
// 时间线播放器：预演页 / 三维视图共用
// ============================================================

export interface ShowEvent {
  time: number;
  kind: 'ignite' | 'burst' | 'land';
  firingId: string;
  pointId: string;
  typeId: string;
  pos: [number, number, number];
}

export class ShowPlayer {
  readonly events: ShowEvent[] = [];
  private cursor = 0;
  time = 0;
  duration = 0;

  constructor(
    private choreo: Choreography,
    private site: SiteModel,
    private types: FireworkType[],
  ) {
    const tm = new Map(types.map((t) => [t.id, t]));
    const pm = new Map(site.launchPoints.map((p) => [p.id, p]));
    for (const f of choreo.firings) {
      const t = tm.get(f.typeId);
      const p = pm.get(f.pointId);
      if (!t || !p) continue;
      const sol = solveBallistic(p, t, site.wind, hashSeed(f.id));
      const rise = Math.sqrt((2 * t.burstHeight) / 9.81) * 0.9;
      const fall = Math.sqrt((2 * t.burstHeight) / 9.81);
      this.events.push({ time: f.time, kind: 'ignite', firingId: f.id, pointId: f.pointId, typeId: f.typeId, pos: p.position });
      this.events.push({ time: f.time + rise, kind: 'burst', firingId: f.id, pointId: f.pointId, typeId: f.typeId, pos: sol.burstPos });
      this.events.push({ time: f.time + rise + fall, kind: 'land', firingId: f.id, pointId: f.pointId, typeId: f.typeId, pos: sol.windLand });
    }
    this.events.sort((a, b) => a.time - b.time);
    this.duration = this.events.length ? this.events[this.events.length - 1].time + 2 : 0;
  }

  reset() {
    this.time = 0;
    this.cursor = 0;
  }

  /** 推进到 timeSec，返回新触发的事件 */
  advance(timeSec: number): ShowEvent[] {
    this.time = timeSec;
    const fired: ShowEvent[] = [];
    while (this.cursor < this.events.length && this.events[this.cursor].time <= timeSec) {
      fired.push(this.events[this.cursor++]);
    }
    return fired;
  }

  get totalEvents() {
    return this.events.length;
  }
}
