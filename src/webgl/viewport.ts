// 可复用三维视口：封装 GLEngine + 相机 + RAF 生命周期
import { el } from '../ui/dom';
import { GLEngine, OrbitCamera } from './engine';
import { buildScene } from './scene';
import type { SiteModel, Vec3 } from '../domain/types';

export interface ViewportOptions {
  showBuffers?: boolean;
  dudZones?: Vec3[][];
  autoRotate?: boolean;
}

export class Viewport3D {
  canvas: HTMLCanvasElement;
  engine: GLEngine;
  cam: OrbitCamera;
  private raf = 0;
  private disposed = false;
  perfEl?: HTMLElement;
  onFrame?: (engine: GLEngine, cam: OrbitCamera, elapsed: number) => void;
  private t0 = performance.now();

  constructor(public site: SiteModel, opts: ViewportOptions = {}, host?: HTMLElement) {
    this.canvas = el('canvas', {}) as HTMLCanvasElement;
    host?.append(this.canvas);
    this.engine = new GLEngine(this.canvas);
    this.cam = new OrbitCamera();
    this.cam.attach(this.canvas);
    this.frameSite(opts);
    if (site.launchPoints.length) {
      const p0 = site.launchPoints[0].position;
      this.cam.target = [p0[0], p0[1], 20];
    }
    this.loop();
  }

  frameSite(opts: ViewportOptions) {
    buildScene(this.engine, this.site, {
      showBuffers: opts.showBuffers,
      showDuds: opts.dudZones,
    });
  }

  attachPerfPanel(container: HTMLElement) {
    this.perfEl = el('div', { class: 'perf-panel' });
    container.append(this.perfEl);
    this.engine.onFps = (fps) => {
      if (!this.perfEl || this.disposed) return;
      const cls = fps >= 50 ? 'fps-ok' : fps >= 28 ? 'fps-warn' : 'fps-bad';
      this.perfEl.innerHTML =
        `<div>FPS <span class="${cls}">${fps.toFixed(0)}</span></div>` +
        `<div>DrawCall ${this.engine.drawCalls}</div>` +
        `<div>粒子 ${this.engine.particleCount.toLocaleString()}</div>` +
        `<div>显存≈${this.engine.vramMB.toFixed(1)}MB</div>`;
    };
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const elapsed = (performance.now() - this.t0) / 1000;
    this.onFrame?.(this.engine, this.cam, elapsed);
    this.engine.render(this.cam);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.perfEl?.remove();
    this.engine.clear();
    this.canvas.remove();
  }
}
