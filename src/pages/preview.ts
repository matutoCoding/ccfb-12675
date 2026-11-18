import type { Page } from '../ui/dom';
import { el, clearNode, toast, field, textInput } from '../ui/dom';
import { store } from '../lib/store';
import { uid, fmt } from '../lib/math';
import { ShowPlayer, type ShowEvent } from '../lib/simulation';
import { Viewport3D } from '../webgl/viewport';
import { COLORANT_RGB } from '../webgl/scene';
import { downloadText, toCsv } from '../lib/files';
import type { Annotation, CameraKeyframe, PerfSample } from '../domain/types';

export class PreviewPage implements Page {
  private host!: HTMLElement;
  private vp?: Viewport3D;
  private player?: ShowPlayer;
  private playing = false;
  private simTime = 0;
  private lastWall = 0;
  private speed = 1;
  private logBox?: HTMLElement;
  private logFilter = 'all';
  private logs: { ev: ShowEvent; text: string }[] = [];
  private keyframes: CameraKeyframe[] = [];
  private cruising = false;
  private annotations: Annotation[] = [];
  private perfSamples: PerfSample[] = [];
  private lowFpsRanges: { from: number; to: number; min: number }[] = [];
  private fpsBelowSince: number | null = null;
  private raf = 0;

  async render(container: HTMLElement) {
    this.host = container;
    if (!store.state.site || !store.state.choreo || !store.state.types.length) {
      container.append(el('div', { class: 'page' }, el('div', { class: 'panel' },
        el('h3', {}, '预演'), el('p', { class: 'warn' }, '请先完成场地、弹种库与编排。'))));
      return;
    }
    container.classList.add('page-nopad');
    container.append(
      el('div', { class: 'viewport-wrap', id: 'pv-vp' },
        el('div', { class: 'hud-overlay', id: 'hud' }, '预演就绪'),
      ),
      el('div', { class: 'side-panel', id: 'pv-side' }),
    );
    const site = store.state.site;
    this.vp = new Viewport3D(site, { showBuffers: true }, document.getElementById('pv-vp') ?? undefined);
    this.vp.attachPerfPanel(document.getElementById('pv-vp')!);
    this.player = new ShowPlayer(store.state.choreo!, site, store.state.types);
    this.buildSide();
    this.tick();
  }

  private buildSide() {
    const side = document.getElementById('pv-side')!;
    clearNode(side);
    side.append(
      el('div', { class: 'panel' },
        el('h3', {}, '播放控制'),
        el('div', { class: 'row' },
          el('button', { class: 'btn btn-primary', id: 'btn-play', onclick: () => this.togglePlay() }, '▶ 播放'),
          el('button', { class: 'btn', onclick: () => this.reset() }, '⏮ 复位'),
          el('label', { class: 'field' }, '播放倍速', el('select', {
            onchange: (e: Event) => { this.speed = parseFloat((e.target as HTMLSelectElement).value); },
          }, ...[0.5, 1, 2, 4].map((v) => el('option', { value: String(v), selected: v === 1 }, `${v}x`)))),
        ),
        el('div', { class: 'row', style: 'margin-top:8px' },
          el('span', { class: 'mono', id: 'time-label' }, '00:00.0 / --:--'),
        ),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, '相机巡航关键帧'),
        el('div', { class: 'row' },
          el('button', { class: 'btn', onclick: () => this.addKeyframe() }, '存当前视点为关键帧'),
          el('button', {
            class: 'btn btn-primary', onclick: () => this.toggleCruise(),
          }, this.cruising ? '停止巡航' : '按关键帧巡航'),
          el('button', { class: 'btn', onclick: () => this.exportKeyframes() }, '存为模板/导出'),
        ),
        el('div', { id: 'kf-list', style: 'margin-top:8px' }, this.kfListView()),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, '事件日志'),
        el('div', { class: 'row pill-row' },
          ...(['all', 'ignite', 'burst', 'land'] as const).map((k) => el('button', {
            class: `btn btn-sm ${this.logFilter === k ? 'btn-primary' : ''}`,
            onclick: () => { this.logFilter = k; this.renderLog(); },
          }, ({ all: '全部', ignite: '点火', burst: '开爆', land: '落地' } as const)[k])),
          el('button', { class: 'btn btn-sm', onclick: () => this.exportLog() }, '导出 CSV'),
        ),
        (this.logBox = el('div', { class: 'event-log', style: 'margin-top:8px' })),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, '发次批注与整改清单'),
        el('div', { class: 'row' },
          textInput('', (v) => (this.pendingNote = v)),
          el('button', { class: 'btn btn-primary', onclick: () => this.addAnnotation() }, '对当前时刻贴批注'),
        ),
        el('div', { id: 'anno-list', style: 'margin-top:8px' }, this.annoView()),
        el('button', { class: 'btn', style: 'margin-top:8px', onclick: () => this.exportAnnotations() }, '导出整改清单 CSV'),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, '性能报告'),
        el('div', { class: 'row' },
          el('button', { class: 'btn', onclick: () => this.exportPerfReport() }, '生成性能报告（含掉帧时段）'),
        ),
        el('p', { class: 'muted', id: 'perf-info' },
          `采样 ${this.perfSamples.length} 次；掉帧(<28fps)时段 ${this.lowFpsRanges.length} 段；低配机粒子已自动缩减至 ${Math.round((this.vp?.engine.qualityScale ?? 1) * 100)}%`),
      ),
    );
    this.renderLog();
  }

  private pendingNote = '';

  private kfListView(): HTMLElement {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['#', '时刻s', '位置 E,N,H', '操作'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...this.keyframes.map((k, i) => el('tr', {},
        el('td', {}, String(i + 1)),
        el('td', { class: 'num' }, fmt(k.t, 1)),
        el('td', { class: 'mono' }, k.pos.map((v) => fmt(v, 0)).join(',')),
        el('td', {}, el('button', {
          class: 'btn btn-sm btn-danger',
          onclick: () => { this.keyframes = this.keyframes.filter((x) => x.id !== k.id); this.buildSide(); },
        }, '删除')),
      )))));
  }

  private annoView(): HTMLElement {
    if (!this.annotations.length) return el('p', { class: 'muted' }, '暂无批注');
    return el('div', {}, ...this.annotations.map((a) => el('div', { class: 'annotation-card' },
      el('div', { class: 'row' },
        el('strong', {}, `t=${fmt(a.time, 1)}s ${a.firingId ? '发次' + a.firingId.slice(-6) : ''}`),
        el('span', { class: `badge ${a.status === '已改' ? 'badge-ok' : 'badge-warn'}` }, a.status),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn btn-sm',
          onclick: () => {
            a.status = a.status === '待改' ? '已改' : '待改';
            document.getElementById('anno-list')?.replaceWith(this.annoView());
          },
        }, '切换状态'),
        el('button', {
          class: 'btn btn-sm btn-danger',
          onclick: () => { this.annotations = this.annotations.filter((x) => x.id !== a.id); this.buildSide(); },
        }, '删除'),
      ),
      el('div', {}, a.text),
    )));
  }

  private addKeyframe() {
    const cam = this.vp!.cam;
    this.keyframes.push({
      id: uid('kf'), name: `KF${this.keyframes.length + 1}`,
      pos: [...cam.pos] as [number, number, number],
      target: [...cam.target] as [number, number, number],
      t: this.simTime,
    });
    this.keyframes.sort((a, b) => a.t - b.t);
    this.buildSide();
    toast('关键帧已保存', 'ok');
  }

  private toggleCruise() {
    if (this.keyframes.length < 2) return toast('至少保存 2 个关键帧', 'warn');
    this.cruising = !this.cruising;
    this.buildSide();
  }

  private togglePlay() {
    this.playing = !this.playing;
    this.lastWall = performance.now();
    const btn = document.getElementById('btn-play');
    if (btn) btn.textContent = this.playing ? '⏸ 暂停' : '▶ 播放';
  }

  private reset() {
    this.playing = false;
    this.simTime = 0;
    this.player?.reset();
    this.logs = [];
    this.vp?.engine.clear();
    this.vp?.frameSite({ showBuffers: true });
    this.renderLog();
    const btn = document.getElementById('btn-play');
    if (btn) btn.textContent = '▶ 播放';
  }

  private tick = () => {
    this.raf = requestAnimationFrame(this.tick);
    const now = performance.now();
    const dt = Math.min((now - this.lastWall) / 1000, 0.1);
    this.lastWall = now;

    if (this.playing && this.player) {
      this.simTime += dt * this.speed;
      if (this.simTime >= this.player.duration) {
        this.simTime = this.player.duration;
        this.playing = false;
        const btn = document.getElementById('btn-play');
        if (btn) btn.textContent = '▶ 播放';
      }
      const events = this.player.advance(this.simTime);
      for (const ev of events) this.handleEvent(ev);
    }

    // 巡航插值
    if (this.cruising && this.keyframes.length >= 2) {
      const kfs = this.keyframes;
      let i = kfs.findIndex((k) => k.t >= this.simTime);
      if (i < 0) i = kfs.length - 1;
      const a = kfs[Math.max(0, i - 1)], b = kfs[i];
      const span = Math.max(b.t - a.t, 0.01);
      const t = Math.min(1, Math.max(0, (this.simTime - a.t) / span));
      this.vp!.cam.flyTo(b.pos, b.target, 0.06 * (0.5 + t));
    }

    // 时间标签 / HUD
    const label = document.getElementById('time-label');
    if (label && this.player) {
      label.textContent = `${mmss(this.simTime)} / ${mmss(this.player.duration)}`;
    }
    const hud = document.getElementById('hud');
    if (hud) {
      hud.textContent = `仿真时刻 ${mmss(this.simTime)}｜事件 ${this.logs.length}/${this.player?.totalEvents ?? 0}｜粒子 ${this.vp?.engine.particleCount ?? 0}`;
    }

    // 性能采样（1Hz）
    this.samplePerf(now);
  };

  private handleEvent(ev: ShowEvent) {
    const type = store.state.types.find((t) => t.id === ev.typeId);
    const point = store.state.site!.launchPoints.find((p) => p.id === ev.pointId);
    const nameMap = { ignite: '点火', burst: '开爆', land: '落地' };
    const text = `[${mmss(ev.time)}] ${nameMap[ev.kind]} 发次${ev.firingId.slice(-6)} 点位${point?.code ?? ''} 弹种${type?.name ?? ''}`;
    this.logs.push({ ev, text });
    this.renderLog();
    if (ev.kind === 'burst' && type) {
      this.vp!.engine.spawnBurst({
        origin: ev.pos,
        color: COLORANT_RGB[type.colorant],
        particles: 5000 + Math.round(type.caliber * 12),
        speed: 14 + type.caliber * 0.12,
      });
    }
  }

  private renderLog() {
    if (!this.logBox) return;
    clearNode(this.logBox);
    const filtered = this.logs.filter((l) => this.logFilter === 'all' || l.ev.kind === this.logFilter);
    this.logBox.append(...filtered.slice(-300).map((l) =>
      el('div', { class: `log-${l.ev.kind}` }, l.text)));
    this.logBox.scrollTop = this.logBox.scrollHeight;
  }

  private addAnnotation() {
    if (!this.pendingNote.trim()) return toast('请输入批注内容', 'warn');
    const current = this.logs.filter((l) => Math.abs(l.ev.time - this.simTime) < 1).at(-1);
    this.annotations.push({
      id: uid('an'), time: this.simTime, text: this.pendingNote.trim(),
      firingId: current?.ev.firingId, status: '待改', createdAt: Date.now(),
    });
    this.pendingNote = '';
    this.buildSide();
    toast('批注已加入整改清单', 'ok');
  }

  private samplePerf(now: number) {
    const fps = this.vp ? parseFloat(this.vp.perfEl?.querySelector('.fps-ok,.fps-warn,.fps-bad')?.textContent ?? '0') : 0;
    if (!fps) return;
    const t = now / 1000;
    this.perfSamples.push({ t, fps, drawCalls: this.vp!.engine.drawCalls, particles: this.vp!.engine.particleCount, vramMB: this.vp!.engine.vramMB });
    if (fps < 28) {
      if (this.fpsBelowSince === null) this.fpsBelowSince = this.simTime;
    } else if (this.fpsBelowSince !== null) {
      this.lowFpsRanges.push({ from: this.fpsBelowSince, to: this.simTime, min: fps });
      this.fpsBelowSince = null;
    }
  }

  private exportLog() {
    const rows: (string | number)[][] = [
      ['时刻s', '事件类型', '发次ID', '点位ID', '弹种ID', 'E', 'N', 'H'],
      ...this.logs.map(({ ev }) => [ev.time.toFixed(2), ev.kind, ev.firingId, ev.pointId, ev.typeId,
        ev.pos[0].toFixed(2), ev.pos[1].toFixed(2), ev.pos[2].toFixed(2)]),
    ];
    downloadText('预演事件日志.csv', toCsv(rows), 'text/csv');
    toast('事件日志已导出', 'ok');
  }

  private exportAnnotations() {
    const rows: (string | number)[][] = [
      ['时刻s', '关联发次', '批注内容', '状态'],
      ...this.annotations.map((a) => [a.time.toFixed(1), a.firingId ?? '', a.text, a.status]),
    ];
    downloadText('整改清单.csv', toCsv(rows), 'text/csv');
    toast('整改清单已导出', 'ok');
  }

  private exportKeyframes() {
    downloadText('巡航路径模板.json', JSON.stringify(this.keyframes, null, 2), 'application/json');
    toast('巡航路径模板已导出，可在其他场次导入复用', 'ok');
  }

  private exportPerfReport() {
    const avg = this.perfSamples.reduce((s, x) => s + x.fps, 0) / Math.max(this.perfSamples.length, 1);
    const rows: (string | number)[][] = [
      ['性能报告'],
      ['采样点数', this.perfSamples.length],
      ['平均FPS', avg.toFixed(1)],
      ['峰值粒子数', Math.max(0, ...this.perfSamples.map((s) => s.particles))],
      ['平均DrawCall', (this.perfSamples.reduce((s, x) => s + x.drawCalls, 0) / Math.max(this.perfSamples.length, 1)).toFixed(1)],
      ['显存占用MB(峰值)', Math.max(0, ...this.perfSamples.map((s) => s.vramMB)).toFixed(1)],
      [], ['掉帧时段(<28fps)', '开始s', '结束s'],
      ...this.lowFpsRanges.map((r) => ['', r.from.toFixed(1), r.to.toFixed(1)]),
    ];
    downloadText('性能报告.csv', toCsv(rows), 'text/csv');
    toast('性能报告已导出', 'ok');
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.vp?.dispose();
    this.host.classList.remove('page-nopad');
  }
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}
