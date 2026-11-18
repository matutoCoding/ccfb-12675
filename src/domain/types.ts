// ============================================================
// 领域模型：场地 / 弹种 / 编排 / 仿真 / 报批 / 现场
// 坐标约定：站点内部统一采用本地工程坐标系（单位：米，ENU：东E、北N、高程H）
// 经纬度仅用于 GeoJSON 导入与导出展示
// ============================================================

export type ID = string;
export type Vec3 = [number, number, number]; // [E, N, H] 米

export interface ProjectMeta {
  id: ID;
  name: string;
  location: string;
  organizer: string;
  showDate: string;          // ISO 日期
  showStart: string;         // HH:mm:ss 夜间/昼间判定用
  licenseLevel: LicenseLevel;   // 公安许可场次级别
  companyQualLevel: LicenseLevel; // 公司资质等级
  createdAt: number;
  updatedAt: number;
}

/** 烟花爆竹燃放作业级别（GB 24284 / GA 103 口径） */
export type LicenseLevel = 'A' | 'B' | 'C' | 'D';

// ---------------- 场地：控制点 / 导线 ----------------

export interface ControlPoint {
  id: ID;
  name: string;
  gridE: number;  // 已知/观测东坐标 m
  gridN: number;
  height: number; // 高程 m
  known?: boolean; // 已知控制点
}

/** 全站仪/RTK 控制点成果表导入行（原始观测） */
export interface ControlSurveyRow {
  pointName: string;
  x: number; // m（成果表 X 通常为北坐标，导入时映射）
  y: number;
  h: number;
  remark?: string;
}

export interface TraverseLeg {
  id: ID;
  from: string;
  to: string;
  distance: number;   // m
  azimuth: number;    // °（方位角）
  dhObs: number;      // m 观测高差
  known?: boolean;    // 附合到已知边
}

export interface TraverseResult {
  legId: ID;
  angleMisclosure: number | null; // 方位角闭合差（整条导线一个值，汇总在首行）
  fx: number; fy: number;         // 坐标闭合差分量 m
  linearMisclosure: number;       // 全长闭合差 m
  relativeClosure: number;        // 相对闭合差 1/K
  heightMisclosure: number;       // 高程闭合差 m
  allowableLinear: number;        // 容许全长闭合差 m（图根导线 1/2000 等）
  allowableHeight: number;        // 容许高程闭合差 m（±12√L 或 ±40√L，mm）
  overTolerance: boolean;
  overToleranceHeight: boolean;
}

// ---------------- 场地：建筑 / 敏感目标 / 线路 / 点位 ----------------

export type BuildingUse =
  | '住宅' | '商业' | '办公' | '学校' | '医院' | '加油站' | '文保单位'
  | '工业' | '仓储' | '公共设施' | '其他';

export type FireResistance = '一级' | '二级' | '三级' | '四级';
export type InsulationFlammability = 'A级不燃' | 'B1级难燃' | 'B2级可燃' | 'B3级易燃' | '未知';

export interface Building {
  id: ID;
  name: string;
  footprint: Vec3[];      // 建筑外轮廓（闭合多边形，H=地面高）
  height: number;         // m
  floors: number;
  use: BuildingUse;
  fireResistance: FireResistance;
  insulation: InsulationFlammability;
  fireLoadDensity?: number; // MJ/m² 火灾荷载密度（可空，按用途给默认）
}

export type SensitiveCategory =
  | '学校' | '医院' | '加油站' | '文保单位' | '车站' | '居民区' | '养老机构' | '其他';

export interface SensitiveTarget {
  id: ID;
  name: string;
  category: SensitiveCategory;
  position: Vec3;
  lon?: number; lat?: number;
  peopleCount?: number;
  /** 按最危险弹种覆盖半径核算出的缓冲距离 m（计算字段） */
  requiredBuffer?: number;
  actualMinDistance?: number; // 距最近燃放点 m
  bufferViolated?: boolean;
}

export type ObstacleType = '高压线' | '塔吊' | '通信塔' | '其他高耸物';

export interface AirObstacle {
  id: ID;
  name: string;
  type: ObstacleType;
  /** 线段（高压线为两个塔位连线；塔吊/通信塔用单点退化为零长度） */
  from: Vec3;
  to: Vec3;
  limitHeight: number; // 限高/线高 m（绝对高程）
  voltage?: string;
}

export interface LaunchPoint {
  id: ID;
  code: string;          // 点位编号 P01...
  position: Vec3;        // 发射点（含地面高程）
  channel: number;       // 默认点火通道
  orientation?: number;  // 发射方向角 °（默认垂直 90° 仰角）
  tiltAngle?: number;    // 倾角 °，0=垂直
  temporaryStorage?: boolean; // 是否临时存药点
  storageChargeKg?: number;   // 存药点药量 kg
}

export interface AudienceArea {
  id: ID;
  name: string;
  polygon: Vec3[];
  capacity: number;
}

export interface EvacRoute {
  id: ID;
  name: string;
  points: Vec3[]; // 折线
  width: number;  // m
}

export interface FireWaterSource {
  id: ID;
  name: string;
  position: Vec3;
  kind: '消火栓' | '水池' | '天然水源' | '消防车取水口';
  flowL_s?: number;
}

export interface SiteModel {
  id: ID;
  name: string;
  terrainPts: Vec3[];          // 地形散点（简单高程插值用）
  groundElevation: number;     // 场地平均地面高程 m
  controlPoints: ControlPoint[];
  traverseLegs: TraverseLeg[];
  traverseResult: TraverseResult | null;
  buildings: Building[];
  sensitive: SensitiveTarget[];
  obstacles: AirObstacle[];
  launchPoints: LaunchPoint[];
  audience: AudienceArea[];
  evacRoutes: EvacRoute[];
  waterSources: FireWaterSource[];
  /** 倾斜摄影实景三维底模（GLB 文件元数据；二进制存 IndexedDB Blob 表） */
  realityMesh?: { blobId: ID; fileName: string; size: number; importedAt: number } | null;
  wind: WindCondition;
}

export interface WindCondition {
  speed: number;   // m/s
  direction: number; // 风向角 °（来风方向，北风=0，顺时针）
  stability: 'A' | 'B' | 'C' | 'D' | 'E' | 'F'; // 大气稳定度（帕斯奎尔）
  tempC: number;
  humidity: number; // %
  backgroundNoiseDay: number;   // dB(A)
  backgroundNoiseNight: number;
}

// ---------------- 弹种 ----------------

export type FireworksLevel = 'A级' | 'B级' | 'C级' | 'D级';
export type Colorant = '锶盐(红)' | '钡盐(绿)' | '钠盐(黄)' | '铜盐(蓝)' | '钾盐(紫)' | '铝钛(银白)' | '混合';

export interface FireworkType {
  id: ID;
  name: string;
  code: string;
  level: FireworksLevel;
  caliber: number;       // 口径 mm
  singleChargeG: number; // 单发药量 g（国标口径）
  burstHeight: number;   // 开爆高度 m（相对发射点）
  spreadRadius: number;  // 覆盖半径 m（水平）
  dudRate: number;       // 哑弹率（小数，如 0.005）
  fragmentRange: number; // 残骸最大落距 m（垂直发射无风）
  colorant: Colorant;
  tntEquivalentFactor: number; // 火药→TNT 当量系数（默认 0.2）
  soundPowerLevel: number;     // 单发开爆声功率级 dB（1m 处声压级近似）
  smokeFactor: number;         // 发烟量系数 g/发
  note?: string;
}

// ---------------- 编排 ----------------

export interface Firing {
  id: ID;
  pointId: ID;
  channel: number;
  typeId: ID;
  time: number;   // 点火时刻 s（相对开场）
  chapterId: ID;
  locked: boolean;
}

export interface Chapter {
  id: ID;
  name: string;
  start: number; // s
  end: number;   // s
  collapsed: boolean;
  locked: boolean;
}

export interface SalvoTemplate {
  id: ID;
  name: string;
  /** 相对首发射的偏移定义 */
  rows: { dt: number; pointCode: string; channel: number; typeCode: string }[];
}

export interface Choreography {
  id: ID;
  name: string;
  firings: Firing[];
  chapters: Chapter[];
  templates: SalvoTemplate[];
  finalized: boolean;
}

// ---------------- 仿真参数与结果 ----------------

export interface SimParams {
  // 时间维度管控
  maxChargePerWindowKg: number; // 同时段（默认10s窗口）点火总药量上限 kg
  windowSec: number;
  minIgnitionIntervalSec: number; // 相邻点位最小点火间隔（安全撤火时间）s
  // 超压
  overpressureAudienceKPa: number;  // 观众席允许超压 kPa（默认 2.0，轻伤阈值口径）
  overpressureBuildingKPa: number;  // 建筑外墙允许超压 kPa（默认 5.0，玻璃/次结构口径）
  // 噪声
  nightStartHour: number;
  nightLimitDb: number;  // 夜间限值 dB(A)
  dayLimitDb: number;
  // 殉爆
  symDetonationK: number;     // R=K√Q 的 K 系数（裸露/存药点口径，默认 0.3→米·千克制换算见公式）
  symDetonationStorageK: number;
  // 烟雾
  visibilityLimitM: number;   // 能见度告警阈值 m
  plumeConcentrationLimit: number; // mg/m³
  // 残骸
  dudMonteCarloN: number;
  windDriftFactor: number;     // 残骸风偏经验系数
}

export interface OverpressureResult {
  firingId: ID;
  targetId: ID;
  targetKind: 'audience' | 'building' | 'storage';
  distance: number;
  deltaP_kPa: number;
  limit_kPa: number;
  exceeded: boolean;
}

export interface NoiseResult {
  firingId: ID;
  targetId: ID;
  targetName: string;
  isNight: boolean;
  distance: number;
  spl_dB: number;
  limit_dB: number;
  exceeded: boolean;
  time: number;
}

export interface SmokeResult {
  time: number;
  concentration: number; // mg/m³ 观众席/通道最大处
  visibilityM: number;
  affectedArea: '观众席' | '疏散通道' | string;
  dissipationSec: number;
  alarm: boolean;
}

export interface SymDetonationItem {
  aId: ID; bId: ID;
  kind: '点位-点位' | '存药点-点位' | '存药点-存药点';
  actual: number;
  required: number;
  chargeKg: number;
  violated: boolean;
}

export interface ClearanceViolation {
  pointId: ID;
  obstacleId: ID;
  obstacleName: string;
  burstTop: number;   // 弹丸轨迹最高点
  limitHeight: number;
  gap: number;
}

export interface DudPrediction {
  firingId: ID;
  pointCode: string;
  typeName: string;
  nominalLand: Vec3;       // 理论落点（无风）
  windLand: Vec3;          // 风偏修正落点
  dispersionRadius: number; // 蒙特卡洛散布半径
  exclusionZone: Vec3[];   // 处置警戒区多边形
  approachRoute: Vec3[];   // 专业人员进场路线
}

export interface TimeRuleViolation {
  kind: '时段药量超限' | '点火间隔不足';
  time: number;
  detail: string;
  firingIds: ID[];
}

export interface FireLoadItem {
  buildingId: ID;
  name: string;
  insulation: InsulationFlammability;
  nearestWaterDist: number;
  extinguisherCount: number; // 建议灭火器材配置数量（具）
  risk: '高' | '中' | '低';
}

export interface SimulationReport {
  generatedAt: number;
  totalFirings: number;
  totalChargeKg: number;
  maxSinglePointChargeKg: number;
  levelViolations: string[];      // 超级别/超资质用药拦截
  clearance: ClearanceViolation[];
  overpressure: OverpressureResult[];
  noise: NoiseResult[];
  smoke: SmokeResult[];
  symDetonation: SymDetonationItem[];
  duds: DudPrediction[];
  fragmentOuts: { firingId: ID; pointCode: string; land: Vec3; crossedBoundary: boolean }[];
  timeRules: TimeRuleViolation[];
  fireLoad: FireLoadItem[];
  sensitiveBuffer: SensitiveTarget[];
  passed: boolean; // 全部硬性拦截项通过
}

// ---------------- 预演 / 批注 / 性能 ----------------

export interface CameraKeyframe {
  id: ID;
  name: string;
  pos: Vec3;
  target: Vec3;
  t: number; // 在巡航路径上的时间 s
}

export interface Annotation {
  id: ID;
  firingId?: ID;
  time: number;
  text: string;
  status: '待改' | '已改';
  createdAt: number;
}

export interface PerfSample {
  t: number;
  fps: number;
  drawCalls: number;
  particles: number;
  vramMB: number;
}

// ---------------- 现场设置 ----------------

export interface RelayNode {
  id: ID;
  name: string;
  position: Vec3;
  hops: number;
}

export interface CableItem {
  id: ID;
  from: string;
  to: string;
  length: number;
  route: Vec3[];
}

export interface SelfCheckResult {
  channel: number;
  pointCode: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

export interface FieldPlan {
  relays: RelayNode[];
  cables: CableItem[];
  latencyBudget: { hops: number; budgetMs: number; estimatedMs: number }[];
  selfCheck: SelfCheckResult[];
  dryRun: { channel: number; planned: number; actual: number; deviationMs: number }[];
}

// ---------------- 导出文件格式 ----------------

export interface BackupFile {
  app: 'fireworks-safety-sim';
  version: number;
  exportedAt: number;
  meta: ProjectMeta | null;
  site: SiteModel | null;
  types: FireworkType[];
  choreo: Choreography | null;
  simParams: SimParams;
}
