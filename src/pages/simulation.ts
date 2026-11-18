import type { Page } from '../ui/dom';
import { el, clearNode, toast, field, numInput, selectInput } from '../ui/dom';
import { store } from '../lib/store';
import { fmt } from '../lib/math';
import { runFullSimulation, type SimulationReport } from '../lib/simulation';
import { downloadText, toCsv } from '../lib/files';
import { Viewport3D } from '../webgl/viewport';
import type { SimParams } from '../domain/types';

const RESULT_TABS = ['拦截结论', '冲击波超压', '噪声超标', '烟雾能见度', '殉爆距离', '残骸与哑弹', '时间规则', '火灾荷载'];

export class SimPage implements Page {
  private host!: HTMLElement;
  private side!: HTMLElement;
  private vp?: Viewport3D;
  private report: SimulationReport | null = null;
  private tab = RESULT_TABS[0];

  async render(container: HTMLElement) {
    this.host = container;
    container.classList.add('page-nopad');
    if (!store.state.site || !store.state.choreo || !store.state.types.length) {
      container.append(el('div', { class: 'page' }, el('div', { class: 'panel' },
        el('h3', {}, '风险仿真'), el('p', { class: 'warn' }, '请先完成场地、弹种库与编排。'))));
      return;
    }
    container.append(
      el('div', { class: 'viewport-wrap', id: 'sim-vp' }),
      (this.side = el('div', { class: 'side-panel', style: 'width:620px' })),
    );
    this.vp = new Viewport3D(store.state.site, { showBuffers: true }, document.getElementById('sim-vp') ?? undefined);
    this.vp.attachPerfPanel(document.getElementById('sim-vp')!);
    this.drawSide();
  }

  private drawSide() {
    clearNode(this.side);
    const p = store.state.simParams;
    const upd = (patch: Partial<SimParams>) => store.saveSimParams({ ...p, ...patch });
    this.side.append(
      el('div', { class: 'panel' },
        el('h3', {}, '仿真参数（国标口径，可按当地公安规定调整）'),
        el('div', { class: 'grid3' },
          field('时段窗口 s', numInput(p.windowSec, (v) => upd({ windowSec: v }))),
          field('窗口药量上限 kg', numInput(p.maxChargePerWindowKg, (v) => upd({ maxChargePerWindowKg: v }))),
          field('安全撤火间隔 s', numInput(p.minIgnitionIntervalSec, (v) => upd({ minIgnitionIntervalSec: v }), '0.1')),
          field('观众席超压限值 kPa', numInput(p.overpressureAudienceKPa, (v) => upd({ overpressureAudienceKPa: v }), '0.1')),
          field('建筑外墙超压限值 kPa', numInput(p.overpressureBuildingKPa, (v) => upd({ overpressureBuildingKPa: v }), '0.1')),
          field('夜间限值 dB(A)', numInput(p.nightLimitDb, (v) => upd({ nightLimitDb: v }))),
          field('昼间限值 dB(A)', numInput(p.dayLimitDb, (v) => upd({ dayLimitDb: v }))),
          field('夜间起始时刻 h', numInput(p.nightStartHour, (v) => upd({ nightStartHour: v }))),
          field('殉爆K(点位)', numInput(p.symDetonationK, (v) => upd({ symDetonationK: v }), '0.1')),
          field('殉爆K(存药点)', numInput(p.symDetonationStorageK, (v) => upd({ symDetonationStorageK: v }), '0.1')),
          field('能见度阈值 m', numInput(p.visibilityLimitM, (v) => upd({ visibilityLimitM: v }))),
          field('烟雾浓度限值 mg/m³', numInput(p.plumeConcentrationLimit, (v) => upd({ plumeConcentrationLimit: v }), '0.1')),
          field('哑弹蒙特卡洛次数', numInput(p.dudMonteCarloN, (v) => upd({ dudMonteCarloN: v }), '10')),
          field('残骸风偏系数', numInput(p.windDriftFactor, (v) => upd({ windDriftFactor: v }), '0.1')),
        ),
        el('div', { class: 'row', style: 'margin-top:12px' },
          el('button', {
            class: 'btn btn-primary', onclick: () => this.run(),
          }, '▶ 运行整场安全仿真'),
          el('button', { class: 'btn', onclick: () => this.exportReport(), disabled: !this.report }, '导出仿真结果 CSV'),
        ),
      ),
      el('div', { id: 'sim-result' }),
    );
    if (this.report) this.renderResult();
  }

  private run() {
    const r = runFullSimulation({
      site: store.state.site!,
      types: store.state.types,
      choreo: store.state.choreo!,
      params: store.state.simParams,
      licenseLevel: store.state.meta?.licenseLevel ?? 'B',
      showStart: store.state.meta?.showStart,
    });
    this.report = r;
    // 三维中标出哑弹处置警戒区
    this.vp?.frameSite({ showBuffers: true, dudZones: r.duds.map((d) => d.exclusionZone) });
    toast(r.passed ? '仿真完成：硬性拦截项全部通过' : '仿真完成：存在必须整改的安全隐患！', r.passed ? 'ok' : 'error');
    this.tab = RESULT_TABS[0];
    this.renderResult();
  }

  private renderResult() {
    const box = document.getElementById('sim-result');
    if (!box || !this.report) return;
    clearNode(box);
    const r = this.report;
    const opExceed = r.overpressure.filter((o) => o.exceeded).length;
    const noiseExceed = r.noise.filter((n) => n.exceeded).length;
    const symBad = r.symDetonation.filter((s) => s.violated).length;
    const fragBad = r.fragmentOuts.filter((f) => f.crossedBoundary).length;
    const sensBad = r.sensitiveBuffer.filter((s) => s.bufferViolated).length;

    box.append(
      el('div', { class: `pass-banner ${r.passed ? 'ok' : 'fail'}` },
        r.passed ? '✓ 仿真通过：超压、残骸越界、殉爆、净空、时间规则等硬性项全部满足'
          : '✗ 仿真不通过：存在硬性拦截项，禁止按此方案燃放，须整改后重算'),
      el('div', { class: 'sim-summary' },
        stat('发次/总药量', `${r.totalFirings}发 / ${fmt(r.totalChargeKg, 1)}kg`),
        stat('超压超标', `${opExceed}`, opExceed > 0),
        stat('噪声超标', `${noiseExceed}`, noiseExceed > 0),
        stat('殉爆不足', `${symBad}`, symBad > 0),
        stat('残骸越界', `${fragBad}`, fragBad > 0),
        stat('缓冲不足', `${sensBad}`, sensBad > 0),
        stat('哑弹预警', `${r.duds.length}`),
        stat('时间规则', `${r.timeRules.length}`, r.timeRules.length > 0),
      ),
      el('div', { class: 'tabs' }, ...RESULT_TABS.map((t) => el('button', {
        class: t === this.tab ? 'active' : '',
        onclick: () => { this.tab = t; this.renderResult(); },
      }, t))),
    );
    const map: Record<string, () => HTMLElement> = {
      [RESULT_TABS[0]]: () => this.tabConclusion(),
      [RESULT_TABS[1]]: () => this.tabOverpressure(),
      [RESULT_TABS[2]]: () => this.tabNoise(),
      [RESULT_TABS[3]]: () => this.tabSmoke(),
      [RESULT_TABS[4]]: () => this.tabSym(),
      [RESULT_TABS[5]]: () => this.tabDuds(),
      [RESULT_TABS[6]]: () => this.tabTimeRules(),
      [RESULT_TABS[7]]: () => this.tabFireLoad(),
    };
    box.append(map[this.tab]());
  }

  private tabConclusion(): HTMLElement {
    const r = this.report!;
    const items: [boolean, string][] = [
      [r.levelViolations.length === 0, `级别/资质用药拦截：${r.levelViolations.length} 条`],
      [r.clearance.length === 0, `净空拦截：${r.clearance.length} 处`],
      [!r.overpressure.some((o) => o.exceeded), `冲击波超压：超标 ${r.overpressure.filter((o) => o.exceeded).length} 项`],
      [!r.symDetonation.some((s) => s.violated), `殉爆安全距离：不足 ${r.symDetonation.filter((s) => s.violated).length} 对`],
      [!r.fragmentOuts.some((f) => f.crossedBoundary), `残骸越界：${r.fragmentOuts.filter((f) => f.crossedBoundary).length} 发`],
      [!r.sensitiveBuffer.some((s) => s.bufferViolated), `敏感目标缓冲：不足 ${r.sensitiveBuffer.filter((s) => s.bufferViolated).length} 处`],
      [r.timeRules.length === 0, `时间维度规则：${r.timeRules.length} 条违规`],
      [true, `哑弹/未爆弹处置预案：${r.duds.length} 个警戒区已在三维视口标出`],
    ];
    return el('div', { class: 'panel' },
      el('ul', { class: 'checklist' },
        ...items.map(([ok, text]) => el('li', {}, el('span', { class: ok ? 'v' : 'x' }, ok ? '✓ ' : '✗ '), text)),
        ...r.levelViolations.map((v) => el('li', { class: 'bad' }, '拦截：' + v)),
        ...r.clearance.map((v) => el('li', { class: 'bad' },
          `净空拦截：${v.obstacleName}，弹迹顶高 ${fmt(v.burstTop, 1)}m 超过限高 ${fmt(v.limitHeight, 1)}m`)),
      ),
    );
  }

  private tabOverpressure(): HTMLElement {
    const r = this.report!;
    const bad = r.overpressure.filter((o) => o.exceeded);
    const show = bad.length ? bad : r.overpressure.slice(0, 200);
    return el('div', { class: 'panel' },
      el('p', { class: 'muted' }, `Henrych 公式按 TNT 当量逐目标核算；下表${bad.length ? '仅列超标项' : '无超标，列前 200 项'}（共 ${r.overpressure.length} 项）`),
      simpleTable(['发次', '目标类型', '距离m', '超压kPa', '限值kPa', '判定'],
        show.map((o) => [o.firingId.slice(-6), o.targetKind, fmt(o.distance, 1),
          fmt(o.deltaP_kPa, 3), fmt(o.limit_kPa, 2), o.exceeded ? '超标·拦截' : '满足']),
        (row) => row[5] !== '满足'),
    );
  }

  private tabNoise(): HTMLElement {
    const r = this.report!;
    const bad = r.noise.filter((n) => n.exceeded);
    return el('div', { class: 'panel' },
      el('p', { class: 'muted' }, `球面发散衰减 + 大气吸收；超标 ${bad.length} 项，按时段列出发次`),
      simpleTable(['时刻s', '发次', '敏感目标', '昼/夜', '距离m', '声压级dB', '限值dB', '判定'],
        (bad.length ? bad : r.noise.slice(0, 100)).map((n) => [
          n.time.toFixed(1), n.firingId.slice(-6), n.targetName, n.isNight ? '夜' : '昼',
          fmt(n.distance, 1), fmt(n.spl_dB, 1), String(n.limit_dB), n.exceeded ? '超标' : '满足']),
        (row) => row[7] !== '满足'),
    );
  }

  private tabSmoke(): HTMLElement {
    const r = this.report!;
    if (!r.smoke.length) return el('div', { class: 'panel' }, el('p', { class: 'good' }, '✓ 各时刻观众席与疏散通道烟雾浓度/能见度均满足要求'));
    return el('div', { class: 'panel' },
      el('p', { class: 'muted' }, '高斯烟羽（Briggs 城市扩散参数），告警即覆盖观众席或疏散通道'),
      simpleTable(['时刻s', '影响区域', '浓度mg/m³', '能见度m', '预计消散s', '判定'],
        r.smoke.map((s) => [s.time.toFixed(1), s.affectedArea, fmt(s.concentration, 3),
          fmt(s.visibilityM, 1), String(s.dissipationSec), '告警']),
        () => true),
    );
  }

  private tabSym(): HTMLElement {
    const r = this.report!;
    const site = store.state.site!;
    const name = (id: string) => site.launchPoints.find((p) => p.id === id)?.code ?? id;
    return el('div', { class: 'panel' },
      el('p', { class: 'muted' }, '殉爆安全距离 R = K·√Q（米·千克制），点对点清单'),
      simpleTable(['A点位', 'B点位', '类型', '实际距离m', '要求距离m', '药量kg', '判定'],
        r.symDetonation.map((s) => [name(s.aId), name(s.bId), s.kind, fmt(s.actual, 1),
          fmt(s.required, 1), fmt(s.chargeKg, 2), s.violated ? '不足·拦截' : '满足']),
        (row) => row[6] !== '满足'),
    );
  }

  private tabDuds(): HTMLElement {
    const r = this.report!;
    const fragBad = r.fragmentOuts.filter((f) => f.crossedBoundary);
    return el('div', {},
      el('div', { class: 'panel' },
        el('h3', {}, `残骸越界（${fragBad.length}/${r.fragmentOuts.length} 发）`),
        fragBad.length ? simpleTable(['发次', '点位', '落点 E', '落点 N', '判定'],
          fragBad.map((f) => [f.firingId.slice(-6), f.pointCode, fmt(f.land[0], 1), fmt(f.land[1], 1), '越界·拦截']),
          () => true)
          : el('p', { class: 'good' }, '✓ 无残骸落入观众席或敏感目标缓冲区')),
      el('div', { class: 'panel' },
        el('h3', {}, `哑弹理论落点与处置警戒区（${r.duds.length} 个，已在三维视口橙色标出）`),
        simpleTable(['发次', '点位', '弹种', '风偏落点 E,N', '散布半径m', '进场路线点数'],
          r.duds.slice(0, 150).map((d) => [d.firingId.slice(-6), d.pointCode, d.typeName,
            `${fmt(d.windLand[0], 1)}, ${fmt(d.windLand[1], 1)}`, fmt(d.dispersionRadius, 1), String(d.approachRoute.length)])),
        el('p', { class: 'muted', style: 'margin-top:8px' },
          '应急处置流程：① 断电断讯、警戒区围挡（理论落点+蒙特卡洛散布半径）；② 专业人员沿进场路线双人小组抵近；③ 水浸降温→现场引爆或转移至防爆罐；④ 全程录像并填写未爆弹处置记录，复核无误后解除警戒。')),
    );
  }

  private tabTimeRules(): HTMLElement {
    const r = this.report!;
    if (!r.timeRules.length) return el('div', { class: 'panel' }, el('p', { class: 'good' }, '✓ 同时段点火总量与相邻点位撤火间隔均满足当地规定'));
    return el('div', { class: 'panel' },
      simpleTable(['时刻s', '类型', '详情'],
        r.timeRules.map((t) => [t.time.toFixed(1), t.kind, t.detail]), () => true));
  }

  private tabFireLoad(): HTMLElement {
    const r = this.report!;
    return el('div', { class: 'panel' },
      el('p', { class: 'muted' }, '外墙保温易燃楼宇 + 最近消防水源 + 灭火器材配置数量清单'),
      simpleTable(['建筑', '保温材料', '最近水源m', '建议灭火器(具)', '风险'],
        r.fireLoad.map((f) => [f.name, f.insulation, fmt(f.nearestWaterDist, 1),
          String(f.extinguisherCount), f.risk]),
        (row) => row[4] !== '低'),
    );
  }

  private exportReport() {
    const r = this.report!;
    const rows: (string | number)[][] = [
      ['仿真报告', new Date(r.generatedAt).toLocaleString()],
      ['发次总数', r.totalFirings], ['总药量kg', r.totalChargeKg.toFixed(2)],
      ['硬性结论', r.passed ? '通过' : '不通过'], [],
      ['--超压超标项--'],
      ...r.overpressure.filter((o) => o.exceeded).map((o) =>
        [o.firingId, o.targetKind, o.distance.toFixed(1), o.deltaP_kPa.toFixed(3), o.limit_kPa.toFixed(2)]),
      [], ['--噪声超标项--'],
      ...r.noise.filter((n) => n.exceeded).map((n) =>
        [n.time.toFixed(1), n.firingId, n.targetName, n.spl_dB.toFixed(1), n.limit_dB]),
      [], ['--殉爆不足项--'],
      ...r.symDetonation.filter((s) => s.violated).map((s) => [s.aId, s.bId, s.actual.toFixed(1), s.required.toFixed(1)]),
      [], ['--残骸越界--'],
      ...r.fragmentOuts.filter((f) => f.crossedBoundary).map((f) => [f.firingId, f.pointCode, f.land[0].toFixed(1), f.land[1].toFixed(1)]),
      [], ['--时间规则--'],
      ...r.timeRules.map((t) => [t.time.toFixed(1), t.kind, t.detail]),
    ];
    downloadText('安全仿真结果.csv', toCsv(rows), 'text/csv');
    toast('仿真结果已导出', 'ok');
  }

  dispose() {
    this.vp?.dispose();
    this.host.classList.remove('page-nopad');
  }
}

function stat(k: string, v: string, bad = false): HTMLElement {
  return el('div', { class: 'stat' },
    el('div', { class: 'k' }, k),
    el('div', { class: 'v', style: bad ? 'color:var(--danger)' : '' }, v));
}

function simpleTable(headers: string[], rows: (string | number)[][], isBad?: (row: (string | number)[]) => boolean): HTMLElement {
  return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
    el('thead', {}, el('tr', {}, ...headers.map((h) => el('th', {}, h)))),
    el('tbody', {}, ...rows.map((row) => el('tr', {},
      ...row.map((cell, i) => el('td', {
        class: `${isBad?.(row) ? 'bad' : ''} ${typeof cell === 'number' ? 'num' : ''}`,
      }, String(cell))))))));
}
