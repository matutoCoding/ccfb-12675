import type { Page } from '../ui/dom';
import { el, clearNode, toast, confirmDialog, selectInput, numInput, textInput } from '../ui/dom';
import { store, emptyChoreography } from '../lib/store';
import { uid, fmt } from '../lib/math';
import { parsePastedTable, downloadText, toCsv, pickFile, readTextFile } from '../lib/files';
import type { Chapter, Choreography, Firing, SalvoTemplate } from '../domain/types';

export class ChoreoPage implements Page {
  private host!: HTMLElement;
  private selected = new Set<string>();

  async render(container: HTMLElement) {
    if (!store.state.choreo) await store.saveChoreo(emptyChoreography());
    this.host = container;
    this.draw();
  }

  private get c() { return store.state.choreo!; }

  private async commit(mutator: (c: Choreography) => void) {
    const draft = structuredClone(this.c) as Choreography;
    mutator(draft);
    await store.saveChoreo(draft);
    this.draw();
  }

  private draw() {
    clearNode(this.host);
    this.host.classList.add('page');
    const c = this.c;
    const site = store.state.site;
    const types = store.state.types;
    const pointOpts = site?.launchPoints ?? [];

    if (!pointOpts.length || !types.length) {
      this.host.append(el('div', { class: 'panel' },
        el('h3', {}, '编排'),
        el('p', { class: 'warn' }, '请先在「场地数据」建立燃放点位、在「弹种管理」建立弹种库。')));
      return;
    }

    const toolbar = el('div', { class: 'panel' },
      el('div', { class: 'row' },
        el('strong', {}, '方案：'),
        textInput(c.name, (v) => this.commit((d) => { d.name = v; })),
        el('span', { class: 'spacer' }),
        c.finalized
          ? el('span', { class: 'badge badge-ok' }, '已定稿（只读，可解锁）')
          : el('span', { class: 'badge badge-warn' }, '编辑中'),
        el('button', {
          class: c.finalized ? 'btn' : 'btn btn-ok',
          onclick: () => this.commit((d) => { d.finalized = !d.finalized; }),
        }, c.finalized ? '解锁定稿' : '定稿锁定'),
      ),
      el('hr', { class: 'sep' }),
      el('div', { class: 'row' },
        el('button', { class: 'btn btn-primary', onclick: () => this.addFiring() }, '新增发次'),
        el('button', { class: 'btn', onclick: () => this.pasteDialog() }, '从 Excel 粘贴'),
        el('button', { class: 'btn', onclick: () => this.batchShift() }, '选中批量平移时刻'),
        el('button', { class: 'btn', onclick: () => this.batchChannel() }, '选中批量换通道'),
        el('button', { class: 'btn btn-danger', onclick: () => this.batchDelete() }, '删除选中'),
        el('button', { class: 'btn', onclick: () => this.replaceTypeDialog() }, '全场替换弹种'),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', onclick: () => this.exportCsv() }, '导出编排 CSV'),
        el('button', { class: 'btn', onclick: () => this.importCsv() }, '原样导回 CSV'),
        el('button', { class: 'btn', onclick: () => this.exportTiming() }, '导出点火时序文件'),
        el('button', { class: 'btn', onclick: () => this.exportManifest() }, '弹种数量明细表'),
      ),
    );

    // 篇章管理
    const chapterPanel = el('div', { class: 'panel' },
      el('h3', {}, '篇章分组（折叠 / 锁定）'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['篇章', '开始s', '结束s', '折叠', '锁定', '操作'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...c.chapters.map((ch) => el('tr', {},
          el('td', {}, textInput(ch.name, (v) => this.commit((d) => { d.chapters.find((x) => x.id === ch.id)!.name = v; }))),
          el('td', {}, numInput(ch.start, (v) => this.commit((d) => { d.chapters.find((x) => x.id === ch.id)!.start = v; }))),
          el('td', {}, numInput(ch.end, (v) => this.commit((d) => { d.chapters.find((x) => x.id === ch.id)!.end = v; }))),
          el('td', {}, el('input', { type: 'checkbox', checked: ch.collapsed, onchange: (e: Event) => this.commit((d) => { d.chapters.find((x) => x.id === ch.id)!.collapsed = (e.target as HTMLInputElement).checked; }) })),
          el('td', {}, el('input', { type: 'checkbox', checked: ch.locked, onchange: (e: Event) => this.commit((d) => { d.chapters.find((x) => x.id === ch.id)!.locked = (e.target as HTMLInputElement).checked; }) })),
          el('td', {}, el('button', {
            class: 'btn btn-sm btn-danger',
            onclick: () => this.commit((d) => { d.chapters = d.chapters.filter((x) => x.id !== ch.id); }),
          }, '删除')),
        ))))),
      el('button', {
        class: 'btn btn-primary', style: 'margin-top:8px',
        onclick: () => this.commit((d) => d.chapters.push({
          id: uid('ch'), name: `篇章${d.chapters.length + 1}`,
          start: d.chapters.at(-1)?.end ?? 0, end: (d.chapters.at(-1)?.end ?? 0) + 60,
          collapsed: false, locked: false,
        })),
      }, '新增篇章'),
    );

    // 齐射模板
    const tplPanel = el('div', { class: 'panel' },
      el('h3', {}, '齐射组合模板'),
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => this.saveTemplate() }, '把当前选中发次存为模板'),
        ...c.templates.map((t) => el('button', {
          class: 'btn', onclick: () => this.insertTemplate(t),
          title: t.rows.map((r) => `+${r.dt}s ${r.pointCode}`).join('\n'),
        }, `插入：${t.name}（${t.rows.length}发）`)),
      ),
    );

    // 发次表（按篇章分组渲染）
    const tablePanel = el('div', { class: 'panel' },
      el('h3', {}, `发次编排（${c.firings.length} 发，已选 ${this.selected.size}）`),
      ...this.renderChapterTables(),
    );

    this.host.append(toolbar, chapterPanel, tplPanel, tablePanel);
  }

  private chapterOf(f: Firing): Chapter {
    return this.c.chapters.find((ch) => f.time >= ch.start && f.time < ch.end)
      ?? this.c.chapters[0];
  }

  private renderChapterTables(): HTMLElement[] {
    const c = this.c;
    const groups = new Map<string, Firing[]>();
    for (const ch of c.chapters) groups.set(ch.id, []);
    for (const f of [...c.firings].sort((a, b) => a.time - b.time)) {
      const ch = this.chapterOf(f);
      groups.get(ch.id)?.push(f);
    }
    const out: HTMLElement[] = [];
    for (const ch of c.chapters) {
      const list = groups.get(ch.id) ?? [];
      const head = el('tr', { class: 'chapter-row' },
        el('td', { colspan: '9' },
          `${ch.collapsed ? '▶' : '▼'} ${ch.name}（${ch.start}-${ch.end}s，${list.length}发）${ch.locked ? ' 🔒已锁定' : ''}`),
      );
      head.style.cursor = 'pointer';
      head.addEventListener('click', () => this.commit((d) => {
        d.chapters.find((x) => x.id === ch.id)!.collapsed = !ch.collapsed;
      }));
      const table = el('table', { class: 'data' },
        el('thead', {}, el('tr', {},
          ...['选', '时刻s', '点位', '通道', '弹种', '篇章', '锁定', 'ID', '操作'].map((h) => el('th', {}, h)))),
        el('tbody', {}, head,
          ...(ch.collapsed ? [] : list.map((f) => this.firingRow(f, ch)))));
      out.push(el('div', { class: 'table-wrap', style: 'margin-bottom:12px' }, table));
    }
    return out;
  }

  private firingRow(f: Firing, ch: Chapter): HTMLElement {
    const site = store.state.site!;
    const types = store.state.types;
    const locked = ch.locked || this.c.finalized || f.locked;
    const upd = (patch: Partial<Firing>) => {
      if (locked) return toast('该段落已锁定/方案已定稿，请先解锁', 'warn');
      this.commit((d) => Object.assign(d.firings.find((x) => x.id === f.id)!, patch));
    };
    const cb = el('input', {
      type: 'checkbox', checked: this.selected.has(f.id),
      onchange: (e: Event) => {
        if ((e.target as HTMLInputElement).checked) this.selected.add(f.id);
        else this.selected.delete(f.id);
        this.draw();
      },
    }) as HTMLInputElement;
    return el('tr', {},
      el('td', {}, cb),
      el('td', {}, numInput(f.time, (v) => upd({ time: v }), '0.1')),
      el('td', {}, selectInput(site.launchPoints.map((p) => p.code),
        site.launchPoints.find((p) => p.id === f.pointId)?.code ?? '',
        (code) => upd({ pointId: site.launchPoints.find((p) => p.code === code)!.id }))),
      el('td', {}, numInput(f.channel, (v) => upd({ channel: v }), '1')),
      el('td', {}, selectInput(types.map((t) => t.name),
        types.find((t) => t.id === f.typeId)?.name ?? '',
        (name) => upd({ typeId: types.find((t) => t.name === name)!.id }))),
      el('td', {}, ch.name),
      el('td', {}, el('input', {
        type: 'checkbox', checked: f.locked,
        onchange: (e: Event) => upd({ locked: (e.target as HTMLInputElement).checked }),
      })),
      el('td', { class: 'muted mono', style: 'font-size:11px' }, f.id.slice(-6)),
      el('td', {}, el('button', {
        class: 'btn btn-sm btn-danger', disabled: locked,
        onclick: () => this.commit((d) => { d.firings = d.firings.filter((x) => x.id !== f.id); }),
      }, '删除')),
    );
  }

  private addFiring() {
    const p = store.state.site!.launchPoints[0];
    const t = store.state.types[0];
    this.commit((d) => d.firings.push({
      id: uid('f'), pointId: p.id, channel: p.channel, typeId: t.id,
      time: Math.max(0, ...d.firings.map((x) => x.time)) + 1,
      chapterId: d.chapters[0].id, locked: false,
    }));
  }

  // ---------------- Excel 粘贴 ----------------
  private pasteDialog() {
    const ta = el('textarea', { rows: 10, placeholder: '每行一发，列顺序：时刻s\t点位编号\t通道\t弹种编码（首行可含表头）' }) as HTMLTextAreaElement;
    const dlg = el('div', { class: 'modal-mask' }, el('div', { class: 'modal', style: 'min-width:560px' },
      el('h3', {}, '从 Excel 整块粘贴'), ta,
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => dlg.remove() }, '取消'),
        el('button', {
          class: 'btn btn-primary', onclick: () => {
            const rows = parsePastedTable(ta.value);
            this.importRows(rows);
            dlg.remove();
          },
        }, '导入'),
      )));
    document.body.append(dlg);
  }

  private importRows(rows: string[][]) {
    const site = store.state.site!;
    const types = store.state.types;
    let ok = 0, skip = 0;
    const added: Firing[] = [];
    for (const r of rows) {
      if (r.length < 4) continue;
      const time = parseFloat(r[0]);
      if (Number.isNaN(time)) continue; // 表头
      const point = site.launchPoints.find((p) => p.code === r[1].trim());
      const type = types.find((t) => t.code === r[2]?.trim() || t.name === r[3]?.trim())
        ?? types.find((t) => t.code === r[3]?.trim());
      const channel = parseInt(r[2], 10);
      if (!point || !type || Number.isNaN(channel)) { skip++; continue; }
      added.push({
        id: uid('f'), pointId: point.id, channel, typeId: type.id, time,
        chapterId: this.c.chapters[0].id, locked: false,
      });
      ok++;
    }
    void this.commit((d) => d.firings.push(...added));
    toast(`导入成功 ${ok} 发，跳过 ${skip} 行（点位/弹种不匹配）`, ok ? 'ok' : 'warn');
  }

  // ---------------- 批量操作 ----------------
  private selectedFirings(): Firing[] {
    return this.c.firings.filter((f) => this.selected.has(f.id));
  }

  private batchShift() {
    const v = prompt('输入时刻平移量（秒，负数提前）', '5');
    if (v == null) return;
    const dt = parseFloat(v);
    if (Number.isNaN(dt)) return;
    this.commit((d) => d.firings.forEach((f) => {
      if (this.selected.has(f.id)) f.time = Math.max(0, f.time + dt);
    }));
  }

  private batchChannel() {
    const v = prompt('输入新通道号', '1');
    if (v == null) return;
    const ch = parseInt(v, 10);
    if (Number.isNaN(ch)) return;
    this.commit((d) => d.firings.forEach((f) => {
      if (this.selected.has(f.id)) f.channel = ch;
    }));
  }

  private batchDelete() {
    if (!this.selected.size) return toast('请先勾选发次', 'warn');
    this.commit((d) => {
      d.firings = d.firings.filter((f) => !this.selected.has(f.id));
    });
    this.selected.clear();
  }

  private replaceTypeDialog() {
    const types = store.state.types;
    if (types.length < 2) return toast('至少需要两个弹种', 'warn');
    const from = selectInput(types.map((t) => t.name), types[0].name, () => {});
    const to = selectInput(types.map((t) => t.name), types[1].name, () => {});
    const dlg = el('div', { class: 'modal-mask' }, el('div', { class: 'modal' },
      el('h3', {}, '全场替换弹种（联动药量/仿真）'),
      el('div', { class: 'row' }, el('label', {}, '原弹种 ', from), el('label', {}, '替换为 ', to)),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => dlg.remove() }, '取消'),
        el('button', {
          class: 'btn btn-primary', onclick: () => {
            const a = types.find((t) => t.name === from.value)!;
            const b = types.find((t) => t.name === to.value)!;
            let n = 0;
            this.commit((d) => d.firings.forEach((f) => {
              if (f.typeId === a.id) { f.typeId = b.id; n++; }
            }));
            toast(`已替换 ${n} 发`, 'ok');
            dlg.remove();
          },
        }, '替换'),
      )));
    document.body.append(dlg);
  }

  // ---------------- 模板 ----------------
  private saveTemplate() {
    const list = this.selectedFirings().sort((a, b) => a.time - b.time);
    if (list.length < 2) return toast('请至少勾选 2 发再存模板', 'warn');
    const site = store.state.site!;
    const types = store.state.types;
    const t0 = list[0].time;
    const tpl: SalvoTemplate = {
      id: uid('tpl'),
      name: `齐射${this.c.templates.length + 1}`,
      rows: list.map((f) => ({
        dt: +(f.time - t0).toFixed(2),
        pointCode: site.launchPoints.find((p) => p.id === f.pointId)!.code,
        channel: f.channel,
        typeCode: types.find((t) => t.id === f.typeId)!.code,
      })),
    };
    this.commit((d) => d.templates.push(tpl));
    toast(`模板「${tpl.name}」已保存`, 'ok');
  }

  private insertTemplate(tpl: SalvoTemplate) {
    const site = store.state.site!;
    const types = store.state.types;
    const base = Math.max(0, ...this.c.firings.map((f) => f.time)) + 1;
    const added: Firing[] = [];
    for (const r of tpl.rows) {
      const point = site.launchPoints.find((p) => p.code === r.pointCode);
      const type = types.find((t) => t.code === r.typeCode);
      if (!point || !type) continue;
      added.push({
        id: uid('f'), pointId: point.id, channel: r.channel, typeId: type.id,
        time: +(base + r.dt).toFixed(2), chapterId: this.c.chapters[0].id, locked: false,
      });
    }
    this.commit((d) => d.firings.push(...added));
    toast(`插入 ${added.length} 发`, 'ok');
  }

  // ---------------- 导入导出 ----------------
  private exportCsv() {
    const site = store.state.site!;
    const types = store.state.types;
    const rows: (string | number)[][] = [
      ['时刻s', '点位编号', '通道', '弹种编码', '弹种名称', '发次ID', '锁定'],
      ...[...this.c.firings].sort((a, b) => a.time - b.time).map((f) => [
        f.time,
        site.launchPoints.find((p) => p.id === f.pointId)?.code ?? '',
        f.channel,
        types.find((t) => t.id === f.typeId)?.code ?? '',
        types.find((t) => t.id === f.typeId)?.name ?? '',
        f.id, f.locked ? 1 : 0,
      ]),
    ];
    downloadText(`${this.c.name}_编排表.csv`, toCsv(rows), 'text/csv');
    toast('编排表已导出（含发次ID，可原样导回）', 'ok');
  }

  private async importCsv() {
    const [file] = await pickFile('.csv,.txt');
    if (!file) return;
    const text = await readTextFile(file);
    const rows = parsePastedTable(text);
    const site = store.state.site!;
    const types = store.state.types;
    const restored: Firing[] = [];
    for (const r of rows.slice(1)) {
      const time = parseFloat(r[0]);
      if (Number.isNaN(time)) continue;
      const point = site.launchPoints.find((p) => p.code === r[1]?.trim());
      const ch = parseInt(r[2], 10);
      const type = types.find((t) => t.code === r[3]?.trim());
      if (!point || !type || Number.isNaN(ch)) continue;
      restored.push({
        id: r[5] ? uid('f') : uid('f'), pointId: point.id, channel: ch, typeId: type.id,
        time, chapterId: this.c.chapters[0].id, locked: r[6] === '1',
      });
    }
    if (!restored.length) return toast('未识别到有效发次行', 'error');
    if (!await confirmDialog(`识别到 ${restored.length} 发，确认覆盖当前编排？`)) return;
    await this.commit((d) => { d.firings = restored; });
    toast('编排已原样导回', 'ok');
  }

  /** 点火时序文件：按点位与通道列每发精确时刻 */
  private exportTiming() {
    const site = store.state.site!;
    const sorted = [...this.c.firings].sort((a, b) => a.channel - b.channel || a.time - b.time);
    const rows: (string | number)[][] = [
      ['点位编号', '通道', '序号', '点火时刻s', '点火时刻(mm:ss.s)'],
      ...sorted.map((f, i) => {
        const p = site.launchPoints.find((x) => x.id === f.pointId);
        const mm = Math.floor(f.time / 60);
        const ss = (f.time % 60).toFixed(1).padStart(4, '0');
        return [p?.code ?? '', f.channel, i + 1, f.time.toFixed(2), `${String(mm).padStart(2, '0')}:${ss}`];
      }),
    ];
    downloadText('点火时序文件.csv', toCsv(rows), 'text/csv');
    toast('点火时序文件已导出，交主控/点火器使用', 'ok');
  }

  /** 弹种数量明细表（备药用） */
  private exportManifest() {
    const types = store.state.types;
    const count = new Map<string, number>();
    for (const f of this.c.firings) count.set(f.typeId, (count.get(f.typeId) ?? 0) + 1);
    const rows: (string | number)[][] = [
      ['弹种编码', '弹种名称', '级别', '口径mm', '单发药量g', '数量(发)', '合计药量kg', '建议备损(发)'],
      ...[...count.entries()].map(([tid, n]) => {
        const t = types.find((x) => x.id === tid)!;
        return [t.code, t.name, t.level, t.caliber, t.singleChargeG, n,
          (n * t.singleChargeG / 1000).toFixed(2), Math.ceil(n * (t.dudRate + 0.01))];
      }),
    ];
    downloadText('弹种数量明细表_备药.csv', toCsv(rows), 'text/csv');
    toast('备药明细表已导出', 'ok');
  }
}
