import type { Page } from '../ui/dom';
import { el, toast, field, numInput, textInput, selectInput, confirmDialog } from '../ui/dom';
import { store } from '../lib/store';
import { uid, fmt } from '../lib/math';
import { downloadText, toCsv } from '../lib/files';
import type { Colorant, FireworksLevel, FireworkType, LicenseLevel } from '../domain/types';
import { summarizeCharge } from '../lib/simulation';

/** 内部最小警戒半径（m）按 TNT 当量经验口径：R = 25·W^(1/3)，再与口径基数取大值 */
export function guardRadiusM(fw: FireworkType): number {
  const w = (fw.singleChargeG / 1000) * fw.tntEquivalentFactor;
  return Math.max(30, 25 * Math.cbrt(Math.max(w, 0.001)), fw.spreadRadius * 1.2);
}

const LEVEL_RANK: Record<LicenseLevel, number> = { A: 4, B: 3, C: 2, D: 1 };
const FW_RANK: Record<FireworksLevel, number> = { A级: 4, B级: 3, C级: 2, D级: 1 };

const SEED_LIBRARY: Omit<FireworkType, 'id'>[] = [
  { name: '3寸礼花弹(红)', code: 'LB3-R', level: 'B级', caliber: 76, singleChargeG: 85, burstHeight: 90, spreadRadius: 35, dudRate: 0.005, fragmentRange: 110, colorant: '锶盐(红)', tntEquivalentFactor: 0.2, soundPowerLevel: 168, smokeFactor: 35, note: '国标口径常见值，可按检测报告调整' },
  { name: '4寸礼花弹(绿)', code: 'LB4-G', level: 'B级', caliber: 102, singleChargeG: 160, burstHeight: 110, spreadRadius: 45, dudRate: 0.005, fragmentRange: 140, colorant: '钡盐(绿)', tntEquivalentFactor: 0.2, soundPowerLevel: 172, smokeFactor: 50 },
  { name: '6寸礼花弹(银闪)', code: 'LB6-S', level: 'A级', caliber: 152, singleChargeG: 360, burstHeight: 150, spreadRadius: 65, dudRate: 0.004, fragmentRange: 200, colorant: '铝钛(银白)', tntEquivalentFactor: 0.2, soundPowerLevel: 178, smokeFactor: 90 },
  { name: '8寸礼花弹(彩菊)', code: 'LB8-M', level: 'A级', caliber: 203, singleChargeG: 620, burstHeight: 180, spreadRadius: 85, dudRate: 0.004, fragmentRange: 260, colorant: '混合', tntEquivalentFactor: 0.2, soundPowerLevel: 183, smokeFactor: 140 },
  { name: '1.2寸组合盆花(蓝)', code: 'PF12-B', level: 'C级', caliber: 30, singleChargeG: 12, burstHeight: 45, spreadRadius: 12, dudRate: 0.002, fragmentRange: 45, colorant: '铜盐(蓝)', tntEquivalentFactor: 0.2, soundPowerLevel: 152, smokeFactor: 8 },
  { name: '架子烟花(黄瀑布)', code: 'JZ-Y', level: 'C级', caliber: 20, singleChargeG: 8, burstHeight: 25, spreadRadius: 8, dudRate: 0.001, fragmentRange: 25, colorant: '钠盐(黄)', tntEquivalentFactor: 0.2, soundPowerLevel: 142, smokeFactor: 6 },
];

export class FireworkPage implements Page {
  async render(container: HTMLElement) {
    if (!store.state.types.length) {
      await store.saveTypes(SEED_LIBRARY.map((t) => ({ ...t, id: uid('fw') })));
    }
    this.draw(container);
  }

  private draw(c: HTMLElement) {
    c.replaceChildren();
    c.classList.add('page');
    const types = store.state.types;
    const choreo = store.state.choreo;
    const meta = store.state.meta;
    const charge = choreo ? summarizeCharge(choreo, types) : null;

    const levelBlocked = types.filter((t) => meta && FW_RANK[t.level] > LEVEL_RANK[meta.licenseLevel]);

    c.append(
      el('div', { class: 'panel' },
        el('h3', {}, '弹种库（国标口径参数）',
          el('span', { class: 'tag' }, '级别 / 口径 / 单发药量 / 开爆高度 / 覆盖半径 / 焰色药剂')),
        meta ? el('div', { class: 'pass-banner ' + (levelBlocked.length ? 'fail' : 'ok') },
          levelBlocked.length
            ? `✗ 弹种库中 ${levelBlocked.length} 种超出 ${meta.licenseLevel} 级场次许可，编排选用时将被当场拦截：${levelBlocked.map((t) => t.name).join('、')}`
            : `✓ 弹种级别均在 ${meta.licenseLevel} 级场次许可与公司资质范围内`)
          : el('div', { class: 'pass-banner fail' }, '尚未初始化工程（工程设置页），无法进行级别比对拦截'),
        el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
          el('thead', {}, el('tr', {},
            ...['名称', '编码', '级别', '口径mm', '单发药量g', '开爆高度m', '覆盖半径m', '残骸落距m', '哑弹率', '焰色药剂', 'TNT系数', '声功率dB', '发烟g', '警戒半径m', '操作'].map((h) => el('th', {}, h)))),
          el('tbody', {}, ...types.map((t) => this.row(t))))),
        el('div', { class: 'row', style: 'margin-top:10px' },
          el('button', { class: 'btn btn-primary', onclick: () => this.add() }, '新增弹种'),
          el('button', { class: 'btn', onclick: () => this.exportLibrary() }, '导出弹种库 CSV'),
        ),
      ),
      charge ? this.chargePanel(types, charge.totalKg, charge.perPoint, charge.perType) : el('div', { class: 'panel' },
        el('h3', {}, '药量核算表'), el('p', { class: 'muted' }, '编排页建立方案后，此处自动生成药量核算表（可直接放入报批材料）。')),
    );
  }

  private row(t: FireworkType): HTMLElement {
    const upd = (patch: Partial<FireworkType>) => {
      const all = store.state.types.map((x) => x.id === t.id ? { ...x, ...patch } : x);
      void store.saveTypes(all);
      this.draw(document.querySelector('.page') as HTMLElement);
    };
    const del = async () => {
      if (!await confirmDialog(`删除弹种「${t.name}」？已编排发次将显示缺弹。`)) return;
      await store.saveTypes(store.state.types.filter((x) => x.id !== t.id));
      this.draw(document.querySelector('.page') as HTMLElement);
    };
    const meta = store.state.meta;
    const overLevel = meta && FW_RANK[t.level] > LEVEL_RANK[meta.licenseLevel];
    return el('tr', { class: overLevel ? 'bad' : '' },
      el('td', {}, textInput(t.name, (v) => upd({ name: v }))),
      el('td', {}, textInput(t.code, (v) => upd({ code: v }))),
      el('td', {}, selectInput(['A级', 'B级', 'C级', 'D级'], t.level, (v) => upd({ level: v as FireworksLevel }))),
      el('td', {}, numInput(t.caliber, (v) => upd({ caliber: v }))),
      el('td', {}, numInput(t.singleChargeG, (v) => upd({ singleChargeG: v }))),
      el('td', {}, numInput(t.burstHeight, (v) => upd({ burstHeight: v }))),
      el('td', {}, numInput(t.spreadRadius, (v) => upd({ spreadRadius: v }))),
      el('td', {}, numInput(t.fragmentRange, (v) => upd({ fragmentRange: v }))),
      el('td', {}, numInput(t.dudRate, (v) => upd({ dudRate: v }), '0.001')),
      el('td', {}, selectInput(['锶盐(红)', '钡盐(绿)', '钠盐(黄)', '铜盐(蓝)', '钾盐(紫)', '铝钛(银白)', '混合'], t.colorant,
        (v) => upd({ colorant: v as Colorant }))),
      el('td', {}, numInput(t.tntEquivalentFactor, (v) => upd({ tntEquivalentFactor: v }), '0.01')),
      el('td', {}, numInput(t.soundPowerLevel, (v) => upd({ soundPowerLevel: v }))),
      el('td', {}, numInput(t.smokeFactor, (v) => upd({ smokeFactor: v }))),
      el('td', { class: 'num good' }, fmt(guardRadiusM(t), 1)),
      el('td', {}, el('button', { class: 'btn btn-sm btn-danger', onclick: del }, '删除')),
    );
  }

  private add() {
    const t: FireworkType = {
      id: uid('fw'), name: '新弹种', code: `FW${store.state.types.length + 1}`, level: 'C级',
      caliber: 30, singleChargeG: 10, burstHeight: 40, spreadRadius: 12, dudRate: 0.003,
      fragmentRange: 40, colorant: '混合', tntEquivalentFactor: 0.2, soundPowerLevel: 150, smokeFactor: 8,
    };
    void store.saveTypes([...store.state.types, t]);
    this.draw(document.querySelector('.page') as HTMLElement);
  }

  private chargePanel(
    types: FireworkType[], totalKg: number,
    perPoint: Record<string, number>, perType: Record<string, number>,
  ): HTMLElement {
    const site = store.state.site;
    const pointName = (id: string) => site?.launchPoints.find((p) => p.id === id)?.code ?? id;
    return el('div', { class: 'panel' },
      el('h3', {}, '药量核算表（自动联动编排）'),
      el('div', { class: 'sim-summary' },
        stat('整场总药量', `${fmt(totalKg, 2)} kg`),
        stat('发次总数', String(store.state.choreo?.firings.length ?? 0)),
        stat('弹种种类', String(types.length)),
        stat('最大单点药量', `${fmt(Math.max(0, ...Object.values(perPoint)), 2)} kg`),
      ),
      el('h4', {}, '按弹种汇总'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['弹种', '级别', '数量(发)', '单发药量g', '小计药量kg', '警戒半径m'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...Object.entries(perType).map(([tid, n]) => {
          const t = types.find((x) => x.id === tid);
          if (!t) return el('tr', {}, el('td', { colspan: '6', class: 'bad' }, '弹种已删除，请在编排中替换'));
          return el('tr', {},
            el('td', {}, t.name), el('td', {}, t.level), el('td', { class: 'num' }, String(n)),
            el('td', { class: 'num' }, String(t.singleChargeG)),
            el('td', { class: 'num' }, fmt((n * t.singleChargeG) / 1000, 2)),
            el('td', { class: 'num' }, fmt(guardRadiusM(t), 1)));
        })))),
      el('h4', { style: 'margin-top:14px' }, '按点位汇总'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['点位', '总药量kg'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...Object.entries(perPoint).map(([pid, kg]) => el('tr', {},
          el('td', {}, pointName(pid)), el('td', { class: 'num' }, fmt(kg, 2))))))),
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', {
          class: 'btn btn-primary', onclick: () => {
            const rows: (string | number)[][] = [
              ['弹种名称', '编码', '级别', '口径mm', '数量(发)', '单发药量g', '小计药量kg', '警戒半径m'],
              ...Object.entries(perType).map(([tid, n]) => {
                const t = types.find((x) => x.id === tid)!;
                return [t.name, t.code, t.level, t.caliber, n, t.singleChargeG,
                  (n * t.singleChargeG / 1000).toFixed(2), guardRadiusM(t).toFixed(1)];
              }),
              [], ['整场总药量(kg)', totalKg.toFixed(2)],
            ];
            downloadText('药量核算表.csv', toCsv(rows), 'text/csv');
            toast('药量核算表已导出', 'ok');
          },
        }, '导出药量核算表 CSV')),
    );
  }

  private exportLibrary() {
    const rows: (string | number)[][] = [
      ['名称', '编码', '级别', '口径mm', '单发药量g', '开爆高度m', '覆盖半径m', '残骸落距m', '哑弹率', '焰色药剂', 'TNT系数', '声功率dB', '发烟g'],
      ...store.state.types.map((t) => [t.name, t.code, t.level, t.caliber, t.singleChargeG, t.burstHeight,
        t.spreadRadius, t.fragmentRange, t.dudRate, t.colorant, t.tntEquivalentFactor, t.soundPowerLevel, t.smokeFactor]),
    ];
    downloadText('弹种参数库.csv', toCsv(rows), 'text/csv');
    toast('弹种库已导出', 'ok');
  }
}

function stat(k: string, v: string): HTMLElement {
  return el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v));
}
