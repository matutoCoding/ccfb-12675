import type { Page } from '../ui/dom';
import { el, toast, field, textInput, selectInput, confirmDialog } from '../ui/dom';
import { store, emptySite, emptyChoreography } from '../lib/store';
import { storage } from '../lib/idb';
import { downloadText, pickFile, readTextFile } from '../lib/files';
import { buildDemoProject } from '../lib/demo';
import type { LicenseLevel, ProjectMeta } from '../domain/types';

export class SettingsPage implements Page {
  async render(container: HTMLElement) {
    container.classList.add('page');
    container.replaceChildren();
    const meta = store.state.meta;
    container.append(
      el('div', { class: 'panel' },
        el('h3', {}, '场次工程信息'),
        el('div', { class: 'grid3' },
          field('项目名称', textInput(meta?.name ?? '', (v) => this.save({ name: v }))),
          field('作业地点', textInput(meta?.location ?? '', (v) => this.save({ location: v }))),
          field('主办单位', textInput(meta?.organizer ?? '', (v) => this.save({ organizer: v }))),
          field('燃放日期', el('input', {
            type: 'date', value: meta?.showDate ?? '',
            onchange: (e: Event) => this.save({ showDate: (e.target as HTMLInputElement).value }),
          })),
          field('开场时间', el('input', {
            type: 'time', value: meta?.showStart ?? '20:00',
            onchange: (e: Event) => this.save({ showStart: (e.target as HTMLInputElement).value }),
          })),
          field('公安许可场次级别', selectInput(['A', 'B', 'C', 'D'], meta?.licenseLevel ?? 'B',
            (v) => this.save({ licenseLevel: v as LicenseLevel }))),
          field('公司资质等级', selectInput(['A', 'B', 'C', 'D'], meta?.companyQualLevel ?? 'B',
            (v) => this.save({ companyQualLevel: v as LicenseLevel }))),
        ),
        !meta ? el('button', {
          class: 'btn btn-primary', style: 'margin-top:12px',
          onclick: () => this.createProject(),
        }, '初始化工程') : el('p', { class: 'good', style: 'margin-top:10px' }, '✓ 工程已初始化，所有修改自动保存到本地 IndexedDB'),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, '数据与交接（纯本地，断网可用）'),
        el('p', { class: 'muted' }, '场地、弹种、编排、仿真参数全部存储于浏览器 IndexedDB；交接时导出工程包文件，在另一台电脑导入即可，无需服务器。'),
        el('div', { class: 'row' },
          el('button', { class: 'btn btn-primary', onclick: () => this.exportBackup() }, '导出完整工程包（JSON）'),
          el('button', { class: 'btn', onclick: () => this.importBackup() }, '导入工程包'),
          el('button', {
            class: 'btn btn-danger', onclick: async () => {
              if (!await confirmDialog('将清空当前浏览器内全部工程数据，确认？')) return;
              indexedDB.deleteDatabase('fw-safety-db');
              location.reload();
            },
          }, '清空本地数据库'),
        ),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, '演示与快速体验'),
        el('p', { class: 'muted' }, '生成一套含控制点、建筑、敏感目标、高压线、6 个燃放点位、观众席与 80+ 发编排的完整示例工程，用于熟悉全流程。'),
        el('div', { class: 'row' },
          el('button', { class: 'btn btn-primary', onclick: () => this.loadDemo() }, '生成完整演示工程'),
          el('button', {
            class: 'btn', onclick: async () => {
              if (!await confirmDialog('重置为空场地与空编排？')) return;
              await store.saveSite(emptySite());
              await store.saveChoreo(emptyChoreography());
              toast('已重置', 'ok');
            },
          }, '重置场地/编排'),
        ),
      ),
      el('div', { class: 'panel' },
        el('h3', {}, '离线部署说明'),
        el('ol', { class: 'checklist' },
          el('li', {}, '开发机执行 npm run build，产物全部在 dist/ 静态目录。'),
          el('li', {}, '将 dist/ 整个拷贝到现场任意电脑，用 npx serve 或双击 index.html（建议 Chrome/Edge 最新版）即可运行。'),
          el('li', {}, '系统无任何外网请求，WebGL2 与 IndexedDB 均为浏览器原生能力，断网环境完整可用。'),
          el('li', {}, '实景三维底模以 GLB 二进制存入 IndexedDB；工程包 JSON 不含底模时需单独拷贝 GLB 重新挂载。'),
        ),
      ),
    );
  }

  private createProject() {
    const meta: ProjectMeta = {
      id: `proj_${Date.now().toString(36)}`,
      name: '新建焰火场次', location: '', organizer: '', showDate: '',
      showStart: '20:00', licenseLevel: 'B', companyQualLevel: 'B',
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    void store.saveMeta(meta);
    if (!store.state.site) void store.saveSite(emptySite());
    if (!store.state.choreo) void store.saveChoreo(emptyChoreography());
    toast('工程已初始化', 'ok');
  }

  private save(patch: Partial<ProjectMeta>) {
    const base = store.state.meta;
    if (!base) return;
    void store.saveMeta({ ...base, ...patch });
  }

  private async exportBackup() {
    const backup = await storage.exportBackup();
    downloadText(`焰火工程包_${backup.meta?.name ?? '未命名'}_${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(backup, null, 2), 'application/json');
    toast('工程包已导出，可用于交接/归档', 'ok');
  }

  private async importBackup() {
    const [file] = await pickFile('.json');
    if (!file) return;
    try {
      const data = JSON.parse(await readTextFile(file));
      if (data.app !== 'fireworks-safety-sim') return toast('不是本系统的工程包文件', 'error');
      if (!await confirmDialog('导入将覆盖当前本地数据，确认？')) return;
      await storage.importBackup(data);
      await store.reload();
      toast('工程包导入完成', 'ok');
    } catch {
      toast('工程包解析失败', 'error');
    }
  }

  private async loadDemo() {
    const demo = buildDemoProject();
    await store.saveMeta(demo.meta);
    await store.saveSite(demo.site);
    await store.saveTypes(demo.types);
    await store.saveChoreo(demo.choreo);
    await store.saveSimParams(demo.simParams);
    toast('演示工程已生成，可依次进入各页面体验', 'ok');
  }
}
