// 全局响应式状态（发布订阅），所有页面共享
import type {
  Choreography, FireworkType, ProjectMeta, SimParams, SiteModel,
} from '../domain/types';
import { defaultSimParams, storage } from './idb';
import { uid } from './math';

interface AppState {
  meta: ProjectMeta | null;
  site: SiteModel | null;
  types: FireworkType[];
  choreo: Choreography | null;
  simParams: SimParams;
  loaded: boolean;
}

type Listener = () => void;

class Store {
  state: AppState = {
    meta: null,
    site: null,
    types: [],
    choreo: null,
    simParams: defaultSimParams(),
    loaded: false,
  };
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((fn) => fn());
  }

  async init() {
    const [meta, site, types, choreo, simParams] = await Promise.all([
      storage.loadMeta(), storage.loadSite(), storage.loadTypes(),
      storage.loadChoreo(), storage.loadSimParams(),
    ]);
    this.state = {
      meta, site, types, choreo,
      simParams: simParams ?? defaultSimParams(),
      loaded: true,
    };
    this.emit();
  }

  async saveMeta(meta: ProjectMeta) {
    this.state.meta = meta;
    await storage.saveMeta(meta);
    this.emit();
  }

  async saveSite(site: SiteModel) {
    this.state.site = site;
    await storage.saveSite(site);
    this.emit();
  }

  async saveTypes(types: FireworkType[]) {
    this.state.types = types;
    await storage.saveTypes(types);
    this.emit();
  }

  async saveChoreo(choreo: Choreography) {
    this.state.choreo = choreo;
    await storage.saveChoreo(choreo);
    this.emit();
  }

  async saveSimParams(p: SimParams) {
    this.state.simParams = p;
    await storage.saveSimParams(p);
    this.emit();
  }

  async reload() {
    await this.init();
  }
}

export const store = new Store();

export function emptySite(): SiteModel {
  return {
    id: uid('site'),
    name: '未命名场地',
    terrainPts: [],
    groundElevation: 0,
    controlPoints: [],
    traverseLegs: [],
    traverseResult: null,
    buildings: [],
    sensitive: [],
    obstacles: [],
    launchPoints: [],
    audience: [],
    evacRoutes: [],
    waterSources: [],
    realityMesh: null,
    wind: {
      speed: 2.5, direction: 0, stability: 'D', tempC: 20,
      humidity: 60, backgroundNoiseDay: 55, backgroundNoiseNight: 45,
    },
  };
}

export function emptyChoreography(): Choreography {
  return {
    id: uid('choreo'),
    name: '未命名编排',
    firings: [],
    chapters: [{ id: uid('ch'), name: '序章', start: 0, end: 60, collapsed: false, locked: false }],
    templates: [],
    finalized: false,
  };
}
