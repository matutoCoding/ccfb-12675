import './styles.css';
import { el, clearNode } from './ui/dom';
import { store } from './lib/store';
import { SitePage } from './pages/site';
import { FireworkPage } from './pages/fireworks';
import { ChoreoPage } from './pages/choreo';
import { SimPage } from './pages/simulation';
import { PreviewPage } from './pages/preview';
import { PermitPage } from './pages/permit';
import { FieldPage } from './pages/field';
import { SettingsPage } from './pages/settings';
import type { Page } from './ui/dom';

const ROUTES: { hash: string; label: string; make: () => Page }[] = [
  { hash: '#/site', label: '场地数据', make: () => new SitePage() },
  { hash: '#/fireworks', label: '弹种管理', make: () => new FireworkPage() },
  { hash: '#/choreo', label: '编排', make: () => new ChoreoPage() },
  { hash: '#/sim', label: '风险仿真', make: () => new SimPage() },
  { hash: '#/preview', label: '预演', make: () => new PreviewPage() },
  { hash: '#/permit', label: '报批材料', make: () => new PermitPage() },
  { hash: '#/field', label: '现场设置', make: () => new FieldPage() },
  { hash: '#/settings', label: '工程设置', make: () => new SettingsPage() },
];

let current: Page | null = null;

function renderShell() {
  const app = document.getElementById('app')!;
  const hash = location.hash || '#/site';
  const route = ROUTES.find((r) => r.hash === hash) ?? ROUTES[0];
  const meta = store.state.meta;

  app.replaceChildren(
    el('header', { class: 'topbar' },
      el('div', { class: 'brand' }, '燃放安全仿真', el('span', { class: 'dot' }, '·'), '报批辅助系统'),
      el('nav', { class: 'nav' },
        ...ROUTES.map((r) => el('button', {
          class: r.hash === route.hash ? 'active' : '',
          onclick: () => { location.hash = r.hash; },
        }, r.label)),
      ),
      el('div', { class: 'topmeta' },
        meta ? `${meta.name}｜${meta.licenseLevel}级场次｜${meta.showDate || '未设日期'}` : '未建工程（工程设置中初始化）'),
    ),
    el('div', { class: 'main', id: 'main' }),
    el('div', { id: 'toast-box' }),
  );

  const main = document.getElementById('main')!;
  current?.dispose?.();
  current = route.make();
  void current.render(main);
}

window.addEventListener('hashchange', renderShell);
store.subscribe(() => {
  // 仅更新顶栏元信息，不重挂载页面
  const meta = store.state.meta;
  const top = document.querySelector('.topmeta');
  if (top) top.textContent = meta
    ? `${meta.name}｜${meta.licenseLevel}级场次｜${meta.showDate || '未设日期'}`
    : '未建工程（工程设置中初始化）';
});

void store.init().then(() => {
  if (!location.hash) location.hash = '#/site';
  renderShell();
});

export { renderShell, clearNode };
