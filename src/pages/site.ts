import type { Page } from '../ui/dom';
import { el, clearNode, toast, field, numInput, textInput, selectInput, confirmDialog } from '../ui/dom';
import { store, emptySite } from '../lib/store';
import { uid, fmt, distXY } from '../lib/math';
import { parseControlSurvey, legsFromPoints, computeTraverse, type ClosureDetail } from '../lib/survey';
import { parsePastedTable, pickFile, readTextFile, downloadText, isExcelFile } from '../lib/files';
import { storage } from '../lib/idb';
import { Viewport3D } from '../webgl/viewport';
import { parseGlb } from '../webgl/scene';
import { evaluateClearance, checkSensitiveBuffers, requiredSensitiveBuffer } from '../lib/safety';
import type {
  AirObstacle, Building, ControlPoint, FireResistance, InsulationFlammability,
  SensitiveCategory, SensitiveTarget, ObstacleType, LaunchPoint, Vec3,
} from '../domain/types';

const TABS = ['控制点与导线', '建筑台账', '敏感目标', '净空障碍物', '燃放点位', '观众/疏散/水源', '气象与底模'];

export class SitePage implements Page {
  private container!: HTMLElement;
  private side!: HTMLElement;
  private vp?: Viewport3D;
  private tab = TABS[0];
  private closure: ClosureDetail | null = null;

  async render(container: HTMLElement) {
    this.container = container;
    if (!store.state.site) await store.saveSite(emptySite());
    container.classList.add('page-nopad');
    container.append(
      el('div', { class: 'viewport-wrap', id: 'vp' }),
      (this.side = el('div', { class: 'side-panel', style: 'width:560px; overflow:auto;' })),
    );
    const site = store.state.site!;
    this.vp = new Viewport3D(site, { showBuffers: true }, document.getElementById('vp') ?? undefined);
    this.vp.attachPerfPanel(document.getElementById('vp')!);
    this.renderSide();
  }

  private refresh3d() {
    if (this.vp && store.state.site) {
      this.vp.site = store.state.site;
      this.vp.frameSite({ showBuffers: true });
    }
  }

  private async persist(mutator: (s: NonNullable<typeof store.state.site>) => void) {
    const s = structuredClone(store.state.site!) as NonNullable<typeof store.state.site>;
    mutator(s);
    await store.saveSite(s);
    this.renderSide();
    this.refresh3d();
  }

  private renderSide() {
    clearNode(this.side);
    this.side.append(
      el('div', { class: 'tabs' }, ...TABS.map((t) => el('button', {
        class: t === this.tab ? 'active' : '',
        onclick: () => { this.tab = t; this.renderSide(); },
      }, t))),
    );
    const map: Record<string, () => HTMLElement> = {
      [TABS[0]]: () => this.tabSurvey(),
      [TABS[1]]: () => this.tabBuildings(),
      [TABS[2]]: () => this.tabSensitive(),
      [TABS[3]]: () => this.tabObstacles(),
      [TABS[4]]: () => this.tabPoints(),
      [TABS[5]]: () => this.tabMisc(),
      [TABS[6]]: () => this.tabWindMesh(),
    };
    this.side.append(map[this.tab]());
  }

  // ---------------- 控制点与导线 ----------------
  private tabSurvey(): HTMLElement {
    const s = store.state.site!;
    const ta = el('textarea', { rows: 6, placeholder: '粘贴控制点成果表：点名\tX(北)\tY(东)\tH，首行可为表头' }) as HTMLTextAreaElement;
    const wrap = el('div', {});

    const renderResult = () => {
      clearNode(wrap);
      if (s.traverseResult) {
        const r = s.traverseResult;
        const ok = !r.overTolerance && !r.overToleranceHeight;
        wrap.append(
          el('div', { class: `pass-banner ${ok ? 'ok' : 'fail'}` },
            ok ? '✓ 导线闭合差全部在容许范围内' : '✗ 闭合差超差，标红测段须退回重测'),
          tableFromRows([
            ['fx (m)', fmt(r.fx, 4)], ['fy (m)', fmt(r.fy, 4)],
            ['全长闭合差 (m)', fmt(r.linearMisclosure, 4)],
            ['容许全长闭合差 (m)', fmt(r.allowableLinear, 4)],
            ['相对闭合差', `1/${Math.round(r.relativeClosure)}（限差 1/2000）`],
            ['高程闭合差 (m)', fmt(r.heightMisclosure, 4)],
            ['容许高程闭合差 (m)', fmt(r.allowableHeight, 4)],
            ['方位角闭合差 (″)', fmt(r.angleMisclosure ?? 0, 1)],
          ]),
        );
      }
      if (this.closure) {
        wrap.append(el('h4', {}, '测段改正与可疑标记'),
          el('div', { class: 'table-wrap' }, (() => {
            const t = el('table', { class: 'data' },
              el('thead', {}, el('tr', {}, ...['测段', 'ΔE改正(m)', 'ΔN改正(m)', 'Δh改正(m)', '判定'].map((h) => el('th', {}, h)))),
              el('tbody', {}));
            const tb = t.querySelector('tbody')!;
            this.closure!.perLegCorrection.forEach((c, i) => {
              const leg = s.traverseLegs[i];
              tb.append(el('tr', {},
                el('td', {}, `${leg?.from}→${leg?.to}`),
                el('td', { class: 'num' }, fmt(c.dE, 4)),
                el('td', { class: 'num' }, fmt(c.dN, 4)),
                el('td', { class: 'num' }, fmt(c.dh, 4)),
                el('td', { class: c.suspect ? 'bad' : 'good' }, c.suspect ? '残差异常·退回重测' : '正常'),
              ));
            });
            return t;
          })()));
      }
    };

    const panel = el('div', { class: 'panel' },
      el('h3', {}, '控制点成果导入', el('span', { class: 'tag' }, '全站仪 / RTK，制表符或逗号分隔')),
      ta,
      el('div', { class: 'row', style: 'margin-top:8px' },
        el('button', {
          class: 'btn btn-primary', onclick: async () => {
            const rows = parsePastedTable(ta.value);
            const parsed = parseControlSurvey(rows.map((r) => r.join('\t')).join('\n'));
            if (!parsed.points.length) return toast('未解析到有效控制点', 'warn');
            if (parsed.warnings.length) toast(parsed.warnings.join('；'), 'warn');
            await this.persist((d) => {
              d.controlPoints = parsed.points;
              d.traverseLegs = legsFromPoints(parsed.points);
              d.traverseResult = null;
            });
            this.closure = null;
            toast(`导入 ${parsed.points.length} 个控制点`, 'ok');
          },
        }, '解析并导入'),
        el('button', {
          class: 'btn', onclick: async () => {
            const files = await pickFile('.csv,.txt,.dat');
            if (!files.length) return;
            if (isExcelFile(files[0].name)) return toast('请在 Excel 中另存为 CSV 后导入（系统零依赖离线运行）', 'warn');
            ta.value = await readTextFile(files[0]);
            toast('文件内容已载入文本框，点击“解析并导入”', 'info');
          },
        }, '选择 CSV/TXT'),
        el('button', {
          class: 'btn', onclick: () => {
            const rows = [['点名', 'X北(m)', 'Y东(m)', 'H(m)'],
              ...s.controlPoints.map((p) => [p.name, p.gridN, p.gridE, p.height])];
            downloadText('控制点成果表.csv', rows.map((r) => r.join(',')).join('\n'), 'text/csv');
          },
        }, '导出成果表'),
      ),
    );

    const cpTable = el('div', { class: 'panel' },
      el('h3', {}, `控制点列表（${s.controlPoints.length}）`),
      el('div', { class: 'table-wrap' }, (() => {
        const t = el('table', { class: 'data' },
          el('thead', {}, el('tr', {}, ...['点名', 'E(m)', 'N(m)', 'H(m)', '操作'].map((h) => el('th', {}, h)))),
          el('tbody', {}));
        const tb = t.querySelector('tbody')!;
        s.controlPoints.forEach((p) => tb.append(el('tr', {},
          el('td', {}, p.name),
          el('td', { class: 'num' }, fmt(p.gridE, 3)),
          el('td', { class: 'num' }, fmt(p.gridN, 3)),
          el('td', { class: 'num' }, fmt(p.height, 3)),
          el('td', {}, el('button', {
            class: 'btn btn-sm btn-danger', onclick: () => this.persist((d) => {
              d.controlPoints = d.controlPoints.filter((q) => q.id !== p.id);
              d.traverseLegs = legsFromPoints(d.controlPoints);
            }),
          }, '删除')),
        )));
        return t;
      })()),
      el('div', { class: 'row', style: 'margin-top:10px' },
        el('button', {
          class: 'btn btn-primary', onclick: () => {
            if (s.controlPoints.length < 3) return toast('至少需要 3 个控制点才能核算闭合差', 'warn');
            this.closure = computeTraverse(s.controlPoints, s.traverseLegs);
            void this.persist((d) => { d.traverseResult = this.closure; });
            toast(this.closure!.overTolerance || this.closure!.overToleranceHeight ? '存在超差项！' : '核算通过',
              this.closure!.overTolerance || this.closure!.overToleranceHeight ? 'error' : 'ok');
          },
        }, '核算导线闭合差 / 高程闭合差'),
        el('button', {
          class: 'btn', onclick: async () => {
            const p: ControlPoint = { id: uid('cp'), name: `P${s.controlPoints.length + 1}`, gridE: 0, gridN: 0, height: 0 };
            await this.persist((d) => d.controlPoints.push(p));
          },
        }, '手工加控制点'),
      ),
    );
    renderResult();
    return el('div', {}, panel, cpTable, wrap);
  }

  // ---------------- 建筑台账 ----------------
  private tabBuildings(): HTMLElement {
    const s = store.state.site!;
    const add = () => this.persist((d) => d.buildings.push({
      id: uid('b'), name: `建筑${d.buildings.length + 1}`,
      footprint: [[0, 0, 0], [20, 0, 0], [20, 14, 0], [0, 14, 0]],
      height: 24, floors: 6, use: '住宅', fireResistance: '二级', insulation: 'B1级难燃',
    }));
    const rows = s.buildings.map((b) => this.buildingRow(b));
    return el('div', { class: 'panel' },
      el('h3', {}, '周边建筑台账', el('span', { class: 'tag' }, '用途 / 耐火等级 / 外墙保温材料 / 火灾荷载')),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['名称', '高度m', '层数', '用途', '耐火等级', '外墙保温', '外轮廓 E,N（闭合）', '操作'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...rows))),
      el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'btn btn-primary', onclick: add }, '新增建筑')),
    );
  }

  private buildingRow(b: Building): HTMLElement {
    const upd = (patch: Partial<Building>) => this.persist((d) => {
      const x = d.buildings.find((q) => q.id === b.id)!;
      Object.assign(x, patch);
    });
    const tr = el('tr', {});
    tr.append(
      el('td', {}, textInput(b.name, (v) => upd({ name: v }))),
      el('td', {}, numInput(b.height, (v) => upd({ height: v }))),
      el('td', {}, numInput(b.floors, (v) => upd({ floors: v }))),
      el('td', {}, selectInput(['住宅', '商业', '办公', '学校', '医院', '加油站', '文保单位', '工业', '仓储', '公共设施', '其他'], b.use, (v) => upd({ use: v as Building['use'] }))),
      el('td', {}, selectInput(['一级', '二级', '三级', '四级'], b.fireResistance, (v) => upd({ fireResistance: v as FireResistance }))),
      el('td', {}, selectInput(['A级不燃', 'B1级难燃', 'B2级可燃', 'B3级易燃', '未知'], b.insulation, (v) => upd({ insulation: v as InsulationFlammability }))),
      el('td', {}, el('input', {
        type: 'text', value: b.footprint.map((p) => `${p[0]},${p[1]}`).join(' '),
        style: 'min-width:220px',
        onchange: (e: Event) => {
          const vals = (e.target as HTMLInputElement).value.trim().split(/\s+/).map((pair) => {
            const [x, y] = pair.split(',').map(Number);
            return [x, y, 0] as Vec3;
          });
          if (vals.every((p) => p.every(isFinite))) upd({ footprint: vals });
          else toast('坐标格式应为 E,N 空格分隔', 'error');
        },
      })),
      el('td', {}, el('button', {
        class: 'btn btn-sm btn-danger', onclick: () => this.persist((d) => {
          d.buildings = d.buildings.filter((q) => q.id !== b.id);
        }),
      }, '删除')),
    );
    return tr;
  }

  // ---------------- 敏感目标 ----------------
  private tabSensitive(): HTMLElement {
    const s = store.state.site!;
    const buffer = requiredSensitiveBuffer(store.state.types);
    const checked = checkSensitiveBuffers(s.sensitive, s.launchPoints, buffer);
    const geoInput = el('input', { type: 'file', accept: '.geojson,.json' }) as HTMLInputElement;
    geoInput.addEventListener('change', async () => {
      const file = geoInput.files?.[0];
      if (!file) return;
      try {
        const geo = JSON.parse(await file.text());
        const feats = geo.features ?? [];
        const added: SensitiveTarget[] = [];
        for (const f of feats) {
          const g = f.geometry;
          const pos: Vec3 = g?.type === 'Point' ? [g.coordinates[0], g.coordinates[1], 0] : [0, 0, 0];
          const name = f.properties?.name ?? f.properties?.名称 ?? `敏感目标${s.sensitive.length + added.length + 1}`;
          const cat = mapCategory(f.properties?.type ?? f.properties?.类别 ?? name);
          added.push({ id: uid('st'), name, category: cat, position: pos, lon: pos[0], lat: pos[1] });
        }
        if (!added.length) return toast('GeoJSON 未含 Point 要素', 'warn');
        toast(`GeoJSON 坐标为经纬度，已保留原值；请在表内换算/录入本地工程坐标`, 'warn');
        await this.persist((d) => d.sensitive.push(...added));
      } catch {
        toast('GeoJSON 解析失败', 'error');
      }
    });
    const add = () => this.persist((d) => d.sensitive.push({
      id: uid('st'), name: `敏感目标${d.sensitive.length + 1}`, category: '学校', position: [0, 0, 0],
    }));
    return el('div', { class: 'panel' },
      el('h3', {}, '敏感目标缓冲核算', el('span', { class: 'tag' },
        `当前弹种库要求缓冲距离 ${fmt(buffer, 1)} m（最大覆盖半径+残骸落距）`)),
      el('div', { class: 'row', style: 'margin-bottom:10px' },
        el('label', { class: 'btn' }, '导入公开 GeoJSON', geoInput),
        el('button', { class: 'btn btn-primary', onclick: add }, '手工新增'),
      ),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['名称', '类别', 'E(m)', 'N(m)', '最近点位m', '要求缓冲m', '判定'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...checked.map((t) => {
          const upd = (patch: Partial<SensitiveTarget>) => this.persist((d) => {
            const x = d.sensitive.find((q) => q.id === t.id)!;
            Object.assign(x, patch);
          });
          return el('tr', {},
            el('td', {}, textInput(t.name, (v) => upd({ name: v }))),
            el('td', {}, selectInput(['学校', '医院', '加油站', '文保单位', '车站', '居民区', '养老机构', '其他'], t.category,
              (v) => upd({ category: v as SensitiveCategory }))),
            el('td', {}, numInput(t.position[0], (v) => upd({ position: [v, t.position[1], t.position[2]] }))),
            el('td', {}, numInput(t.position[1], (v) => upd({ position: [t.position[0], v, t.position[2]] }))),
            el('td', { class: 'num' }, fmt(t.actualMinDistance ?? 0, 1)),
            el('td', { class: 'num' }, fmt(buffer, 1)),
            el('td', { class: t.bufferViolated ? 'bad' : 'good' }, t.bufferViolated ? '缓冲不足·拦截' : '满足'),
          );
        })))),
    );
  }

  // ---------------- 净空障碍物 ----------------
  private tabObstacles(): HTMLElement {
    const s = store.state.site!;
    const violations = evaluateClearance(s.launchPoints, store.state.types, s.obstacles);
    const add = () => this.persist((d) => d.obstacles.push({
      id: uid('ob'), name: `障碍物${d.obstacles.length + 1}`, type: '高压线',
      from: [0, 0, 0], to: [40, 0, 0], limitHeight: 25, voltage: '10kV',
    }));
    return el('div', { class: 'panel' },
      el('h3', {}, '高压线 / 塔吊 / 通信塔净空', el('span', { class: 'tag' }, '点位上空净空不足直接拦截')),
      violations.length ? el('div', { class: 'pass-banner fail' },
        `✗ ${violations.length} 处净空不足：` + violations.map((v) => `${v.obstacleName}(缺口${fmt(v.gap, 1)}m)`).join('；'))
        : el('div', { class: 'pass-banner ok' }, '✓ 当前无净空冲突'),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['名称', '类型', '起点E,N,H', '终点E,N,H', '限高m', '电压/备注', '操作'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...s.obstacles.map((o) => this.obstacleRow(o))))),
      el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'btn btn-primary', onclick: add }, '新增障碍物')),
    );
  }

  private obstacleRow(o: AirObstacle): HTMLElement {
    const upd = (patch: Partial<AirObstacle>) => this.persist((d) => {
      Object.assign(d.obstacles.find((q) => q.id === o.id)!, patch);
    });
    const vecInputs = (v: Vec3, key: 'from' | 'to') => el('input', {
      type: 'text', value: v.join(','), style: 'min-width:150px',
      onchange: (e: Event) => {
        const p = (e.target as HTMLInputElement).value.split(',').map(Number) as Vec3;
        if (p.length === 3 && p.every(isFinite)) upd({ [key]: p } as Partial<AirObstacle>);
      },
    });
    return el('tr', {},
      el('td', {}, textInput(o.name, (v) => upd({ name: v }))),
      el('td', {}, selectInput(['高压线', '塔吊', '通信塔', '其他高耸物'], o.type, (v) => upd({ type: v as ObstacleType }))),
      el('td', {}, vecInputs(o.from, 'from')),
      el('td', {}, vecInputs(o.to, 'to')),
      el('td', {}, numInput(o.limitHeight, (v) => upd({ limitHeight: v }))),
      el('td', {}, textInput(o.voltage ?? '', (v) => upd({ voltage: v }))),
      el('td', {}, el('button', {
        class: 'btn btn-sm btn-danger',
        onclick: () => this.persist((d) => { d.obstacles = d.obstacles.filter((q) => q.id !== o.id); }),
      }, '删除')),
    );
  }

  // ---------------- 燃放点位 ----------------
  private tabPoints(): HTMLElement {
    const s = store.state.site!;
    const add = () => this.persist((d) => d.launchPoints.push({
      id: uid('lp'), code: `P${String(d.launchPoints.length + 1).padStart(2, '0')}`,
      position: [d.launchPoints.length * 12, 0, 0], channel: d.launchPoints.length + 1,
      tiltAngle: 0, temporaryStorage: false, storageChargeKg: 0.5,
    }));
    return el('div', { class: 'panel' },
      el('h3', {}, `燃放点位（${s.launchPoints.length}）`, el('span', { class: 'tag' }, '橙色杆为普通点位，红黄为临时存药点')),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', {}, el('tr', {}, ...['编号', 'E(m)', 'N(m)', '高程m', '通道', '倾角°', '存药点', '存药量kg', '间距检查', '操作'].map((h) => el('th', {}, h)))),
        el('tbody', {}, ...s.launchPoints.map((p) => {
          const upd = (patch: Partial<LaunchPoint>) => this.persist((d) => {
            Object.assign(d.launchPoints.find((q) => q.id === p.id)!, patch);
          });
          const nearest = s.launchPoints.filter((q) => q.id !== p.id)
            .reduce<{ d: number; code: string } | null>((acc, q) => {
              const d = distXY(p.position, q.position);
              return !acc || d < acc.d ? { d, code: q.code } : acc;
            }, null);
          return el('tr', {},
            el('td', {}, textInput(p.code, (v) => upd({ code: v }))),
            el('td', {}, numInput(p.position[0], (v) => upd({ position: [v, p.position[1], p.position[2]] }))),
            el('td', {}, numInput(p.position[1], (v) => upd({ position: [p.position[0], v, p.position[2]] }))),
            el('td', {}, numInput(p.position[2], (v) => upd({ position: [p.position[0], p.position[1], v] }))),
            el('td', {}, numInput(p.channel, (v) => upd({ channel: v }), '1')),
            el('td', {}, numInput(p.tiltAngle ?? 0, (v) => upd({ tiltAngle: v }))),
            el('td', {}, el('input', { type: 'checkbox', checked: p.temporaryStorage, onchange: (e: Event) => upd({ temporaryStorage: (e.target as HTMLInputElement).checked }) })),
            el('td', {}, numInput(p.storageChargeKg ?? 0.5, (v) => upd({ storageChargeKg: v }))),
            el('td', {}, nearest ? el('span', { class: nearest.d < 8 ? 'bad' : 'muted' }, `${nearest.code} ${fmt(nearest.d, 1)}m`) : el('span', { class: 'muted' }, '—')),
            el('td', {}, el('button', {
              class: 'btn btn-sm btn-danger',
              onclick: () => this.persist((d) => { d.launchPoints = d.launchPoints.filter((q) => q.id !== p.id); }),
            }, '删除')),
          );
        })))),
      el('div', { class: 'row', style: 'margin-top:10px' }, el('button', { class: 'btn btn-primary', onclick: add }, '新增点位')),
    );
  }

  // ---------------- 观众/疏散/水源 ----------------
  private tabMisc(): HTMLElement {
    const s = store.state.site!;
    return el('div', {},
      el('div', { class: 'panel' },
        el('h3', {}, '观众席区域'),
        this.simpleAreaTable(s.audience.map((a) => ({ id: a.id, name: a.name, poly: a.polygon, extra: String(a.capacity) })),
          async (rows) => {
            await this.persist((d) => {
              d.audience = rows.map((r) => ({ id: r.id, name: r.name, polygon: r.poly, capacity: Number(r.extra) || 0 }));
            });
          }, '容纳人数'),
        el('button', {
          class: 'btn btn-primary', style: 'margin-top:8px', onclick: () => this.persist((d) => d.audience.push({
            id: uid('au'), name: `观众席${d.audience.length + 1}`, capacity: 500,
            polygon: [[-30, -40, 0], [30, -40, 0], [30, -25, 0], [-30, -25, 0]],
          })),
        }, '新增观众席'),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, '疏散通道'),
        this.simpleAreaTable(s.evacRoutes.map((r) => ({ id: r.id, name: r.name, poly: r.points, extra: String(r.width) })),
          async (rows) => {
            await this.persist((d) => {
              d.evacRoutes = rows.map((r) => ({ id: r.id, name: r.name, points: r.poly, width: Number(r.extra) || 3 }));
            });
          }, '宽度m'),
        el('button', {
          class: 'btn btn-primary', style: 'margin-top:8px', onclick: () => this.persist((d) => d.evacRoutes.push({
            id: uid('er'), name: `通道${d.evacRoutes.length + 1}`, width: 4,
            points: [[-30, -25, 0], [-30, -60, 0]],
          })),
        }, '新增通道'),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, '消防水源'),
        el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
          el('thead', {}, el('tr', {}, ...['名称', '类型', 'E', 'N', '流量L/s', '操作'].map((h) => el('th', {}, h)))),
          el('tbody', {}, ...s.waterSources.map((w) => el('tr', {},
            el('td', {}, textInput(w.name, (v) => this.persist((d) => Object.assign(d.waterSources.find((q) => q.id === w.id)!, { name: v })))),
            el('td', {}, selectInput(['消火栓', '水池', '天然水源', '消防车取水口'], w.kind,
              (v) => this.persist((d) => Object.assign(d.waterSources.find((q) => q.id === w.id)!, { kind: v as never })))),
            el('td', {}, numInput(w.position[0], (v) => this.persist((d) => Object.assign(d.waterSources.find((q) => q.id === w.id)!, { position: [v, w.position[1], w.position[2]] })))),
            el('td', {}, numInput(w.position[1], (v) => this.persist((d) => Object.assign(d.waterSources.find((q) => q.id === w.id)!, { position: [w.position[0], v, w.position[2]] })))),
            el('td', {}, numInput(w.flowL_s ?? 15, (v) => this.persist((d) => Object.assign(d.waterSources.find((q) => q.id === w.id)!, { flowL_s: v })))),
            el('td', {}, el('button', {
              class: 'btn btn-sm btn-danger',
              onclick: () => this.persist((d) => { d.waterSources = d.waterSources.filter((q) => q.id !== w.id); }),
            }, '删除')),
          )))),
        ),
      ),
    );
  }

  private simpleAreaTable(
    rows: { id: string; name: string; poly: Vec3[]; extra: string }[],
    onCommit: (rows: { id: string; name: string; poly: Vec3[]; extra: string }[]) => void,
    extraLabel: string,
  ): HTMLElement {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
      el('thead', {}, el('tr', {}, ...['名称', extraLabel, '折线/多边形点 E,N（空格分隔）'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows.map((r) => el('tr', {},
        el('td', {}, textInput(r.name, (v) => { r.name = v; onCommit(rows); })),
        el('td', {}, textInput(r.extra, (v) => { r.extra = v; onCommit(rows); })),
        el('td', {}, el('input', {
          type: 'text', style: 'min-width:260px', value: r.poly.map((p) => `${p[0]},${p[1]}`).join(' '),
          onchange: (e: Event) => {
            const poly = (e.target as HTMLInputElement).value.trim().split(/\s+/).map((pair) => {
              const [x, y] = pair.split(',').map(Number);
              return [x, y, 0] as Vec3;
            });
            if (poly.every((p) => p.every(isFinite))) {
              r.poly = poly;
              onCommit(rows);
            } else toast('坐标格式错误', 'error');
          },
        })),
      )))));
  }

  // ---------------- 气象与底模 ----------------
  private tabWindMesh(): HTMLElement {
    const s = store.state.site!;
    const w = s.wind;
    const upd = (patch: Partial<typeof w>) => this.persist((d) => Object.assign(d.wind, patch));
    const meshInput = el('input', { type: 'file', accept: '.glb' }) as HTMLInputElement;
    meshInput.addEventListener('change', async () => {
      const file = meshInput.files?.[0];
      if (!file) return;
      const buf = await file.arrayBuffer();
      const parsed = parseGlb(buf);
      if (!parsed) return toast('仅支持未压缩（无 Draco）的 GLB 2.0 网格', 'error');
      const blobId = uid('mesh');
      await storage.saveBlob(blobId, new Blob([buf]));
      await this.persist((d) => {
        d.realityMesh = { blobId, fileName: file.name, size: file.size, importedAt: Date.now() };
      });
      this.vp?.engine.addMesh({ pos: parsed.pos, normal: parsed.normal, color: parsed.color, alpha: 0.92 });
      toast(`实景三维底模已挂载（${(file.size / 1048576).toFixed(1)}MB），存于本地 IndexedDB`, 'ok');
    });
    return el('div', {},
      el('div', { class: 'panel' },
        el('h3', {}, '气象条件（仿真实时引用）'),
        el('div', { class: 'grid3' },
          field('风速 m/s', numInput(w.speed, (v) => upd({ speed: v }))),
          field('风向°（来风方向，北风=0）', numInput(w.direction, (v) => upd({ direction: v }))),
          field('大气稳定度', selectInput(['A', 'B', 'C', 'D', 'E', 'F'], w.stability, (v) => upd({ stability: v as never }))),
          field('气温 ℃', numInput(w.tempC, (v) => upd({ tempC: v }))),
          field('湿度 %', numInput(w.humidity, (v) => upd({ humidity: v }))),
          field('昼间背景噪声 dB', numInput(w.backgroundNoiseDay, (v) => upd({ backgroundNoiseDay: v }))),
          field('夜间背景噪声 dB', numInput(w.backgroundNoiseNight, (v) => upd({ backgroundNoiseNight: v }))),
          field('场地平均地面高程 m', numInput(s.groundElevation, (v) => this.persist((d) => { d.groundElevation = v; }))),
        ),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, '倾斜摄影实景三维底模'),
        s.realityMesh
          ? el('div', { class: 'kv' },
            el('dt', {}, '当前文件'), el('dd', {}, s.realityMesh.fileName),
            el('dt', {}, '大小'), el('dd', {}, `${(s.realityMesh.size / 1048576).toFixed(2)} MB`),
            el('dt', {}, '导入时间'), el('dd', {}, new Date(s.realityMesh.importedAt).toLocaleString()))
          : el('p', { class: 'muted' }, '尚未挂载底模。请将倾斜摄影模型导出为 GLB 2.0（禁用 Draco 压缩）。'),
        el('div', { class: 'row', style: 'margin-top:10px' },
          el('label', { class: 'btn btn-primary' }, '挂载 GLB 底模', meshInput),
          el('button', {
            class: 'btn btn-danger', onclick: async () => {
              if (!await confirmDialog('确认移除实景底模？')) return;
              await this.persist((d) => { d.realityMesh = null; });
              this.refresh3d();
            },
          }, '移除底模'),
        ),
      ),
    );
  }

  dispose() {
    this.vp?.dispose();
    this.container.classList.remove('page-nopad');
  }
}

function mapCategory(raw: string): SensitiveCategory {
  const t = String(raw);
  if (t.includes('学校')) return '学校';
  if (t.includes('医院')) return '医院';
  if (t.includes('加油') || t.includes('燃气')) return '加油站';
  if (t.includes('文物') || t.includes('保护')) return '文保单位';
  if (t.includes('车站')) return '车站';
  if (t.includes('养老')) return '养老机构';
  if (t.includes('居民') || t.includes('住宅')) return '居民区';
  return '其他';
}

function tableFromRows(rows: [string, string][]): HTMLElement {
  return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
    el('tbody', {}, ...rows.map(([k, v]) => el('tr', {}, el('td', {}, k), el('td', { class: 'num' }, v))))));
}
