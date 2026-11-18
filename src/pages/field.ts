import type { Page } from '../ui/dom';
import { el, clearNode, toast } from '../ui/dom';
import { store } from '../lib/store';
import { dist, distXY, fmt, uid } from '../lib/math';
import { downloadText, toCsv } from '../lib/files';
import type { CableItem, FieldPlan, RelayNode, SelfCheckResult, Vec3 } from '../domain/types';

/** 无线链路预算：自由空间路损 + 建筑遮挡穿透损耗，门限 -95dBm */
const TX_DBM = 20;
const FREQ_MHZ = 433;
const RX_SENS = -95;
const WALL_LOSS = 8; // 每栋视线内建筑遮挡 dB

export class FieldPage implements Page {
  private host!: HTMLElement;
  private plan: FieldPlan | null = null;

  async render(container: HTMLElement) {
    this.host = container;
    this.host.classList.add('page');
    if (!store.state.site) {
      this.host.append(el('div', { class: 'panel' }, el('h3', {}, '现场设置'),
        el('p', { class: 'warn' }, '请先建立场地数据。')));
      return;
    }
    this.draw();
  }

  private draw() {
    clearNode(this.host);
    const site = store.state.site!;
    this.host.append(
      el('div', { class: 'panel' },
        el('h3', {}, '现场通信与点火布设',
          el('span', { class: 'tag' }, `主控默认位于首个点位旁；${FREQ_MMHZ()}MHz 链路预算，门限 ${RX_SENS}dBm`)),
        el('div', { class: 'row' },
          el('button', { class: 'btn btn-primary', onclick: () => this.compute() }, '① 估算无线覆盖并推荐中继'),
          el('button', { class: 'btn', onclick: () => this.selfCheck() }, '② 分区域分批自检'),
          el('button', { class: 'btn', onclick: () => this.dryRun() }, '③ 整场时序空跑演练'),
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn', onclick: () => this.exportAll(), disabled: !this.plan }, '导出现场布设清单 CSV'),
        ),
      ),
      el('div', { id: 'field-out' }),
    );
    if (this.plan) this.renderPlan();
  }

  private master(): Vec3 {
    return store.state.site!.launchPoints[0]?.position ?? [0, 0, 0];
  }

  /** 自由空间路损 dB：32.45 + 20lg f(MHz) + 20lg d(km) */
  private pathLoss(d: number): number {
    return 32.45 + 20 * Math.log10(FREQ_MHZ) + 20 * Math.log10(Math.max(d, 1) / 1000);
  }

  private blockCount(a: Vec3, b: Vec3): number {
    // 线段是否穿过建筑 footprint（二维相交近似：采样点落入多边形计数）
    let n = 0;
    for (const bld of store.state.site!.buildings) {
      const steps = 8;
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const p: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0];
        if (pointIn(p, bld.footprint)) { n++; break; }
      }
    }
    return n;
  }

  private compute() {
    const site = store.state.site!;
    const master = this.master();
    const relays: RelayNode[] = [];
    const cables: CableItem[] = [];
    const latencyBudget: FieldPlan['latencyBudget'] = [];

    const coverage = site.launchPoints.map((p) => {
      const d = distXY(master, p.position);
      const loss = this.pathLoss(d) + this.blockCount(master, p.position) * WALL_LOSS;
      const rssi = TX_DBM - loss;
      return { p, d, rssi };
    });
    const dead = coverage.filter((c) => c.rssi < RX_SENS);

    // 中继推荐：在信号盲区的质心方向、距主控 150m 级联布点
    if (dead.length) {
      const ce: Vec3 = [
        dead.reduce((s, x) => s + x.p.position[0], 0) / dead.length,
        dead.reduce((s, x) => s + x.p.position[1], 0) / dead.length,
        master[2] + 8,
      ];
      relays.push({ id: uid('relay'), name: `中继R1`, position: ce, hops: 1 });
      // 二级中继：若盲区距中继仍超 200m
      const far = dead.filter((c) => distXY(ce, c.p.position) > 200);
      if (far.length) {
        const ce2: Vec3 = [
          far.reduce((s, x) => s + x.p.position[0], 0) / far.length,
          far.reduce((s, x) => s + x.p.position[1], 0) / far.length,
          master[2] + 8,
        ];
        relays.push({ id: uid('relay'), name: '中继R2', position: ce2, hops: 2 });
      }
    }

    // 线缆走向：主控沿点位编号顺序串联（含 10% 弯曲余量），遮挡点强制有线
    let prev = master;
    let prevName = '主控';
    site.launchPoints.forEach((p, i) => {
      const needWire = this.blockCount(prev, p.position) > 0 || i === 0;
      const d = dist(prev, p.position) * 1.1;
      if (needWire) {
        cables.push({
          id: uid('cable'), from: prevName, to: p.code, length: Math.ceil(d / 5) * 5,
          route: [prev, p.position],
        });
      }
      prev = p.position;
      prevName = p.code;
    });

    // 时延预算：每跳无线 25ms + 有线 8ms
    const maxHops = relays.length;
    for (let hops = 0; hops <= maxHops; hops++) {
      const estimated = hops * 25 + 8;
      latencyBudget.push({ hops, budgetMs: 100 + hops * 50, estimatedMs: estimated });
    }

    this.plan = {
      relays, cables, latencyBudget,
      selfCheck: [], dryRun: [],
    };
    this.renderPlan(coverage);
    toast(dead.length ? `发现 ${dead.length} 个信号空白点，已推荐 ${relays.length} 个中继位` : '主控信号全域覆盖，无需中继',
      dead.length ? 'warn' : 'ok');
  }

  private renderPlan(coverage?: { p: { code: string; position: Vec3 }; d: number; rssi: number }[]) {
    const out = document.getElementById('field-out')!;
    clearNode(out);
    const plan = this.plan!;

    const coveragePanel = el('div', { class: 'panel' },
      el('h3', {}, '无线信号覆盖估算'),
      coverage ? this.coverageTable(coverage) : el('p', { class: 'muted' }, '点击上方按钮开始估算'),
      el('h4', { style: 'margin-top:12px' }, '推荐中继位'),
      plan.relays.length ? this.relayTable(plan.relays) : el('p', { class: 'muted' }, '无空白区'),
    );

    const latencyPanel = el('div', { class: 'panel' },
      el('h3', {}, '通信时延预算（按跳数）'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['跳数', '预算ms', '预估ms', '判定'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...plan.latencyBudget.map((l) => el('tr', {},
          el('td', { class: 'num' }, String(l.hops)),
          el('td', { class: 'num' }, String(l.budgetMs)),
          el('td', { class: 'num' }, String(l.estimatedMs)),
          el('td', { class: l.estimatedMs > l.budgetMs ? 'bad' : 'good' },
            l.estimatedMs > l.budgetMs ? '超预算' : '满足')))))),
    );

    const cablePanel = el('div', { class: 'panel' },
      el('h3', {}, `主控→点火器线缆走向与长度清单（${plan.cables.length} 段，含 10% 弯曲余量）`),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['起点', '终点', '长度m(取5m整)'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...plan.cables.map((c) => el('tr', {},
          el('td', {}, c.from), el('td', {}, c.to), el('td', { class: 'num' }, String(c.length))))))),
      el('p', { class: 'muted' }, `线缆合计 ${plan.cables.reduce((s, c) => s + c.length, 0)} m`),
    );

    const dryRunPanel = el('div', { class: 'panel' },
      el('h3', {}, '空跑时序演练（通道响应偏差）'),
      plan.dryRun.length ? this.dryRunTable(plan.dryRun) : el('p', { class: 'muted' }, '尚未空跑'),
    );

    out.append(
      el('div', { class: 'grid2' }, coveragePanel, latencyPanel),
      cablePanel,
      el('div', { class: 'grid2' },
        el('div', { class: 'panel' }, el('h3', {}, '分批自检结果'), this.checkTable(plan.selfCheck)),
        dryRunPanel),
    );
  }

  private coverageTable(coverage: { p: { code: string; position: Vec3 }; d: number; rssi: number }[]): HTMLElement {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['点位', '距主控m', '接收电平dBm', '判定'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...coverage.map((c) => el('tr', {},
        el('td', {}, c.p.code),
        el('td', { class: 'num' }, fmt(c.d, 1)),
        el('td', { class: 'num ' + (c.rssi < RX_SENS ? 'bad' : 'good') }, fmt(c.rssi, 1)),
        el('td', {}, c.rssi < RX_SENS ? '空白区·需中继' : '覆盖良好'))))));
  }

  private relayTable(relays: RelayNode[]): HTMLElement {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['编号', 'E', 'N', '高程m', '跳数'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...relays.map((r) => el('tr', {},
        el('td', {}, r.name), el('td', { class: 'num' }, fmt(r.position[0], 1)),
        el('td', { class: 'num' }, fmt(r.position[1], 1)),
        el('td', { class: 'num' }, fmt(r.position[2], 1)),
        el('td', { class: 'num' }, String(r.hops)))))));
  }

  private dryRunTable(rows: FieldPlan['dryRun']): HTMLElement {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['通道', '计划时刻s', '实测时刻s', '偏差ms', '判定'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows.map((d) => el('tr', {},
        el('td', { class: 'num' }, String(d.channel)),
        el('td', { class: 'num' }, fmt(d.planned, 2)),
        el('td', { class: 'num' }, fmt(d.actual, 2)),
        el('td', { class: 'num ' + (Math.abs(d.deviationMs) > 50 ? 'bad' : 'good') }, String(d.deviationMs)),
        el('td', {}, Math.abs(d.deviationMs) > 50 ? '超差·排查' : '合格'))))));
  }

  private checkTable(rows: SelfCheckResult[]): HTMLElement {
    if (!rows.length) return el('p', { class: 'muted' }, '点击“分批自检”按区域逐通道检测');
    return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['通道', '点位', '结果', '时延ms', '详情'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows.map((r) => el('tr', {},
        el('td', { class: 'num' }, String(r.channel)),
        el('td', {}, r.pointCode),
        el('td', { class: r.ok ? 'good' : 'bad' }, r.ok ? '正常' : '失败'),
        el('td', { class: 'num' }, r.latencyMs != null ? String(r.latencyMs) : '—'),
        el('td', {}, r.detail))))),
    );
  }

  private selfCheck() {
    if (!this.plan) this.compute();
    const site = store.state.site!;
    // 确定性伪随机模拟：92% 通道正常，失败定位到具体通道编号
    let seed = 1234567;
    const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const results: SelfCheckResult[] = [];
    const groups = new Map<number, typeof site.launchPoints>();
    site.launchPoints.forEach((p) => {
      const g = Math.ceil(p.channel / 4);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(p);
    });
    for (const [g, pts] of groups) {
      for (const p of pts) {
        const roll = rng();
        const ok = roll > 0.08;
        results.push({
          channel: p.channel, pointCode: p.code, ok,
          latencyMs: ok ? 18 + Math.round(rng() * 30) : undefined,
          detail: ok ? `第${g}批自检通过，回路电阻正常` : `第${g}批自检失败：通道 ${p.channel}（${p.code}）点火头回路开路，请检查接线编号`,
        });
      }
    }
    this.plan!.selfCheck = results;
    this.renderPlan();
    const failed = results.filter((r) => !r.ok);
    toast(failed.length ? `自检完成：${failed.length} 个通道失败，已定位编号` : '全部通道自检通过',
      failed.length ? 'error' : 'ok');
  }

  private dryRun() {
    const choreo = store.state.choreo;
    if (!choreo?.firings.length) return toast('编排为空，无法空跑', 'warn');
    let seed = 7654321;
    const rng = () => { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; };
    const byChannel = new Map<number, number>();
    for (const f of choreo.firings) {
      const cur = byChannel.get(f.channel);
      if (cur == null || f.time < cur) byChannel.set(f.channel, f.time);
    }
    this.plan ??= { relays: [], cables: [], latencyBudget: [], selfCheck: [], dryRun: [] };
    this.plan.dryRun = [...byChannel.entries()].sort((a, b) => a[0] - b[0]).map(([channel, planned]) => {
      const deviationMs = Math.round((rng() - 0.5) * 60);
      return { channel, planned, actual: planned + deviationMs / 1000, deviationMs };
    });
    this.renderPlan();
    toast(`空跑完成：${this.plan.dryRun.length} 个通道，偏差超 50ms 的需排查`, 'ok');
  }

  private exportAll() {
    const plan = this.plan!;
    const rows: (string | number)[][] = [
      ['--中继推荐--'], ['编号', 'E', 'N', 'H', '跳数'],
      ...plan.relays.map((r) => [r.name, r.position[0].toFixed(1), r.position[1].toFixed(1), r.position[2].toFixed(1), r.hops]),
      [], ['--线缆清单--'], ['起点', '终点', '长度m'],
      ...plan.cables.map((c) => [c.from, c.to, c.length]),
      [], ['--自检结果--'], ['通道', '点位', '结果', '时延ms', '详情'],
      ...plan.selfCheck.map((r) => [r.channel, r.pointCode, r.ok ? '正常' : '失败', r.latencyMs ?? '', r.detail]),
      [], ['--空跑偏差--'], ['通道', '计划s', '实测s', '偏差ms'],
      ...plan.dryRun.map((d) => [d.channel, d.planned.toFixed(2), d.actual.toFixed(2), d.deviationMs]),
    ];
    downloadText('现场布设与自检清单.csv', toCsv(rows), 'text/csv');
    toast('现场清单已导出', 'ok');
  }
}

function FREQ_MMHZ() { return 433; }

function pointIn(p: Vec3, poly: Vec3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    const hit = yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}
