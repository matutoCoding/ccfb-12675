// 完整演示工程：闭合差合格的导线、建筑、敏感目标、高压线、点位、观众席、80+ 发编排
import type {
  Choreography, FireworkType, ProjectMeta, SimParams, SiteModel,
} from '../domain/types';
import { uid } from './math';
import { defaultSimParams } from './idb';
import { legsFromPoints } from './survey';
import { computeTraverse } from './survey';

export function buildDemoProject(): {
  meta: ProjectMeta; site: SiteModel; types: FireworkType[];
  choreo: Choreography; simParams: SimParams;
} {
  const simParams = defaultSimParams();

  const meta: ProjectMeta = {
    id: uid('proj'), name: '滨江新城国庆焰火晚会', location: '滨江新城市民公园沿江平台',
    organizer: '滨江新城文旅集团', showDate: '2026-10-01', showStart: '20:00:00',
    licenseLevel: 'B', companyQualLevel: 'A', createdAt: Date.now(), updatedAt: Date.now(),
  };

  // 控制点：附合导线 K0-K5，带毫米级观测误差
  const cpBase = [
    ['K0', 0, 0, 5.2], ['K1', 80, 6, 5.5], ['K2', 160, -8, 5.1],
    ['K3', 240, 10, 5.8], ['K4', 320, -4, 5.3], ['K5', 400, 4, 5.6],
  ] as const;
  const controlPoints = cpBase.map(([name, e, n, h], i) => ({
    id: uid('cp'), name, gridE: e + (i ? 0.012 * (i % 2 ? 1 : -1) : 0),
    gridN: n + (i ? 0.008 * (i % 2 ? -1 : 1) : 0), height: h + (i ? 0.006 : 0),
  }));
  const traverseLegs = legsFromPoints(controlPoints);
  const closure = computeTraverse(controlPoints, traverseLegs);

  const site: SiteModel = {
    id: uid('site'), name: '市民公园沿江平台',
    terrainPts: [], groundElevation: 5.4,
    controlPoints, traverseLegs, traverseResult: closure,
    buildings: [
      { id: uid('b'), name: '江景壹号住宅楼', footprint: foot([[120, 90], [180, 90], [180, 130], [120, 130]]), height: 48, floors: 16, use: '住宅', fireResistance: '二级', insulation: 'B2级可燃', fireLoadDensity: 480 },
      { id: uid('b'), name: '滨江商业广场', footprint: foot([[-90, 70], [-20, 70], [-20, 110], [-90, 110]]), height: 22, floors: 5, use: '商业', fireResistance: '一级', insulation: 'A级不燃', fireLoadDensity: 600 },
      { id: uid('b'), name: '实验小学教学楼', footprint: foot([[200, -140], [280, -140], [280, -100], [200, -100]]), height: 18, floors: 5, use: '学校', fireResistance: '二级', insulation: 'B1级难燃', fireLoadDensity: 350 },
      { id: uid('b'), name: '城南加油加气站', footprint: foot([[-160, -60], [-120, -60], [-120, -25], [-160, -25]]), height: 7, floors: 1, use: '加油站', fireResistance: '二级', insulation: 'A级不燃', fireLoadDensity: 200 },
    ],
    sensitive: [
      { id: uid('st'), name: '实验小学', category: '学校', position: [340, -260, 0] },
      { id: uid('st'), name: '城南加油站', category: '加油站', position: [-300, -200, 0] },
      { id: uid('st'), name: '清代古塔(文保)', category: '文保单位', position: [120, 300, 0] },
      { id: uid('st'), name: '仁济医院住院部', category: '医院', position: [-320, 260, 0] },
    ],
    obstacles: [
      { id: uid('ob'), name: '10kV 沿江高压线', type: '高压线', from: [-160, 120, 0], to: [360, 120, 0], limitHeight: 22, voltage: '10kV' },
      { id: uid('ob'), name: '工地塔吊T1', type: '塔吊', from: [150, -70, 0], to: [150, -70, 0], limitHeight: 42 },
    ],
    launchPoints: [
      lp('P01', -40, -10, 1), lp('P02', 0, -14, 2), lp('P03', 40, -10, 3),
      lp('P04', -40, 25, 4, true), lp('P05', 0, 22, 5), lp('P06', 40, 26, 6),
    ],
    audience: [
      { id: uid('au'), name: 'A区观众席', capacity: 3000, polygon: [[-70, -75, 0], [70, -75, 0], [70, -45, 0], [-70, -45, 0]] },
      { id: uid('au'), name: 'B区观众席', capacity: 2000, polygon: [[-70, -110, 0], [70, -110, 0], [70, -82, 0], [-70, -82, 0]] },
    ],
    evacRoutes: [
      { id: uid('er'), name: '1号疏散通道', width: 6, points: [[-70, -60, 0], [-110, -60, 0], [-110, -130, 0]] },
      { id: uid('er'), name: '2号疏散通道', width: 6, points: [[70, -60, 0], [110, -60, 0], [110, -130, 0]] },
    ],
    waterSources: [
      { id: uid('w'), name: '东侧市政消火栓', kind: '消火栓', position: [85, -40, 0], flowL_s: 20 },
      { id: uid('w'), name: '景观水池', kind: '水池', position: [-95, 30, 0], flowL_s: 40 },
    ],
    realityMesh: null,
    wind: { speed: 2.4, direction: 45, stability: 'D', tempC: 22, humidity: 65, backgroundNoiseDay: 55, backgroundNoiseNight: 46 },
  };

  const types: FireworkType[] = [
    fw('3寸红弹', 'LB3-R', 'B级', 76, 85, 90, 35, 110, 0.005, '锶盐(红)', 168, 35),
    fw('4寸绿弹', 'LB4-G', 'B级', 102, 160, 110, 45, 140, 0.005, '钡盐(绿)', 172, 50),
    fw('6寸银闪弹', 'LB6-S', 'A级', 152, 360, 150, 65, 200, 0.004, '铝钛(银白)', 178, 90),
    fw('蓝盆花', 'PF12-B', 'C级', 30, 12, 45, 12, 45, 0.002, '铜盐(蓝)', 152, 8),
    fw('黄瀑布架花', 'JZ-Y', 'C级', 20, 8, 25, 8, 25, 0.001, '钠盐(黄)', 142, 6),
  ];

  // 编排：4 个篇章，84 发，时间窗与撤火间隔均合规
  const chapters = [
    { id: uid('ch'), name: '序章·迎宾', start: 0, end: 30, collapsed: false, locked: false },
    { id: uid('ch'), name: '第一章·花开两岸', start: 30, end: 90, collapsed: false, locked: false },
    { id: uid('ch'), name: '第二章·盛世华章', start: 90, end: 150, collapsed: false, locked: false },
    { id: uid('ch'), name: '终章·万众同欢', start: 150, end: 200, collapsed: false, locked: false },
  ];
  const firings: Choreography['firings'] = [];
  let t = 2;
  for (let i = 0; i < 84; i++) {
    const point = site.launchPoints[i % site.launchPoints.length];
    // 同一点位相邻发次间隔 ≥ 6s，满足撤火时间
    t += i % site.launchPoints.length === 0 ? 2.5 : 1.0;
    const type = i % 9 === 0 ? types[3] : i % 7 === 0 ? types[4] : i % 4 === 0 ? types[1] : types[0];
    const ch = chapters.find((c) => t >= c.start && t < c.end) ?? chapters[0];
    firings.push({
      id: uid('f'), pointId: point.id, channel: point.channel,
      typeId: type.id, time: +t.toFixed(1), chapterId: ch.id, locked: false,
    });
  }

  const choreo: Choreography = {
    id: uid('choreo'), name: '国庆晚会主方案', firings, chapters,
    templates: [
      {
        id: uid('tpl'), name: '六连齐射',
        rows: site.launchPoints.map((p, i) => ({ dt: i * 0.2, pointCode: p.code, channel: p.channel, typeCode: 'LB3-R' })),
      },
    ],
    finalized: false,
  };

  return { meta, site, types, choreo, simParams };
}

function foot(pairs: [number, number][]): [number, number, number][] {
  return pairs.map(([e, n]) => [e, n, 0]);
}

function lp(code: string, e: number, n: number, channel: number, storage = false): SiteModel['launchPoints'][number] {
  return {
    id: uid('lp'), code, position: [e, n, 5.4], channel, orientation: 0,
    tiltAngle: 0, temporaryStorage: storage, storageChargeKg: storage ? 2 : 0.5,
  };
}

function fw(
  name: string, code: string, level: FireworkType['level'], caliber: number,
  singleChargeG: number, burstHeight: number, spreadRadius: number, fragmentRange: number,
  dudRate: number, colorant: FireworkType['colorant'], soundPowerLevel: number, smokeFactor: number,
): FireworkType {
  return {
    id: uid('fw'), name, code, level, caliber, singleChargeG, burstHeight, spreadRadius,
    dudRate, fragmentRange, colorant, tntEquivalentFactor: 0.2, soundPowerLevel, smokeFactor,
  };
}
