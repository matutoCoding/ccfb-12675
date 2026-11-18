// 导线测量闭合差 / 高程闭合差核算（附合导线模型）
import type { ControlPoint, ControlSurveyRow, TraverseLeg, TraverseResult } from '../domain/types';
import { D2R, uid } from './math';

export interface ParsedSurvey {
  points: ControlPoint[];
  rows: ControlSurveyRow[];
  warnings: string[];
}

/** 解析全站仪/RTK 控制点成果表（支持：点名 X(北) Y(东) H 备注，制表符/逗号分隔，首行可为表头） */
export function parseControlSurvey(text: string): ParsedSurvey {
  const warnings: string[] = [];
  const lines = text.replace(/\r/g, '').split(/\n/).filter((l) => l.trim());
  const points: ControlPoint[] = [];
  const rows: ControlSurveyRow[] = [];
  lines.forEach((line, idx) => {
    const cells = line.split(/\t|,/).map((c) => c.trim());
    if (cells.length < 3) return;
    const nums = cells.slice(1).map((c) => parseFloat(c));
    if (nums.some((n) => Number.isNaN(n))) {
      if (idx === 0) return; // 表头
      warnings.push(`第 ${idx + 1} 行存在无法解析的数值，已跳过：${line}`);
      return;
    }
    const [x, y, h] = nums;
    rows.push({ pointName: cells[0], x, y, h: h ?? 0, remark: cells[4] });
    // 成果表惯例：X=北坐标 N，Y=东坐标 E
    points.push({ id: uid('cp'), name: cells[0], gridE: y, gridN: x, height: h ?? 0 });
  });
  return { points, rows, warnings };
}

export function makeLeg(from: string, to: string, distance: number, azimuth: number, dh: number): TraverseLeg {
  return { id: uid('leg'), from, to, distance, azimuth, dhObs: dh };
}

/** 由控制点序列自动生成附合导线 legs（相邻点反算方位角/距离/高差） */
export function legsFromPoints(points: ControlPoint[]): TraverseLeg[] {
  const legs: TraverseLeg[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dE = b.gridE - a.gridE, dN = b.gridN - a.gridN;
    const distance = Math.hypot(dE, dN);
    let az = (Math.atan2(dE, dN) / D2R + 360) % 360;
    legs.push(makeLeg(a.name, b.name, distance, az, b.height - a.height));
  }
  return legs;
}

export interface ClosureDetail extends TraverseResult {
  perLegCorrection: { legId: string; dE: number; dN: number; dh: number; suspect: boolean }[];
  adjustedPoints: ControlPoint[];
}

/**
 * 附合导线闭合差核算
 * 容许值采用图根电磁波测距导线口径：
 *  - 方位角闭合差 ±40″√n
 *  - 全长相对闭合差 1/2000（山地 1/1000，参数可调）
 *  - 高程闭合差 ±12√L mm（L 为路线长 km，平坦区）
 */
export function computeTraverse(
  points: ControlPoint[],
  legs: TraverseLeg[],
  opts: { relLimit?: number; heightMmPerSqrtKm?: number } = {},
): ClosureDetail | null {
  if (legs.length < 2 || points.length < 2) return null;
  const relLimit = opts.relLimit ?? 2000;
  const hCoef = opts.heightMmPerSqrtKm ?? 12;

  const start = points[0], end = points[points.length - 1];
  let sumE = 0, sumN = 0, sumDh = 0, L = 0;
  for (const leg of legs) {
    const az = leg.azimuth * D2R;
    sumE += leg.distance * Math.sin(az);
    sumN += leg.distance * Math.cos(az);
    sumDh += leg.dhObs;
    L += leg.distance;
  }
  const calcEndE = start.gridE + sumE, calcEndN = start.gridN + sumN;
  const fx = calcEndE - end.gridE;
  const fy = calcEndN - end.gridN;
  const linear = Math.hypot(fx, fy);
  const relative = L / Math.max(linear, 1e-9);
  const allowableLinear = L / relLimit;

  const knownDh = end.height - start.height;
  const heightMis = sumDh - knownDh;
  const allowableHeight = (hCoef * Math.sqrt(L / 1000)) / 1000; // mm → m

  const angleMisclosureSec = 40 * Math.sqrt(legs.length);

  // 按距离比例反号分配闭合差，并标记残差显著偏大的可疑测段
  const perLeg = legs.map((leg) => {
    const share = leg.distance / L;
    const dE = -fx * share, dN = -fy * share, dh = -heightMis * share;
    return { legId: leg.id, dE, dN, dh, suspect: false };
  });
  const meanShare = 1 / legs.length;
  perLeg.forEach((c) => {
    const share = Math.hypot(c.dE, c.dN) / Math.max(linear, 1e-9);
    c.suspect = share > meanShare * 2;
  });

  // 平差后坐标
  const adjusted: ControlPoint[] = points.map((p) => ({ ...p }));
  let curE = start.gridE, curN = start.gridN, curH = start.height;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i], c = perLeg[i];
    const az = leg.azimuth * D2R;
    curE += leg.distance * Math.sin(az) + c.dE;
    curN += leg.distance * Math.cos(az) + c.dN;
    curH += leg.dhObs + c.dh;
    if (adjusted[i + 1]) {
      adjusted[i + 1] = { ...adjusted[i + 1], gridE: curE, gridN: curN, height: curH };
    }
  }

  const overTolerance = linear > allowableLinear;
  const overToleranceHeight = Math.abs(heightMis) > allowableHeight;

  return {
    legId: legs[0].id,
    angleMisclosure: angleMisclosureSec,
    fx, fy,
    linearMisclosure: linear,
    relativeClosure: relative,
    heightMisclosure: heightMis,
    allowableLinear,
    allowableHeight,
    overTolerance,
    overToleranceHeight,
    perLegCorrection: perLeg,
    adjustedPoints: adjusted,
  };
}
