// 纯本地 IndexedDB 封装，无任何网络依赖
import type { BackupFile, Choreography, FireworkType, ProjectMeta, SimParams, SiteModel } from '../domain/types';

const DB_NAME = 'fw-safety-db';
const DB_VERSION = 1;
const STORES = ['meta', 'site', 'types', 'choreo', 'simParams', 'blobs', 'kv'] as const;
type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const idb = {
  get: <T>(store: StoreName, key: string) => tx<T | undefined>(store, 'readonly', (s) => s.get(key)),
  put: <T>(store: StoreName, key: string, val: T) => tx(store, 'readwrite', (s) => s.put(val, key)),
  del: (store: StoreName, key: string) => tx(store, 'readwrite', (s) => s.delete(key)),
  all: async <T>(store: StoreName): Promise<T[]> => {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result as T[]);
      req.onerror = () => reject(req.error);
    });
  },
  clear: (store: StoreName) => tx(store, 'readwrite', (s) => s.clear()),
};

// ---------------- 业务对象存取 ----------------

const KEY = {
  meta: 'project',
  site: 'site',
  choreo: 'choreo',
  simParams: 'simParams',
  typesList: 'fireworkTypes',
} as const;

export const storage = {
  async loadMeta(): Promise<ProjectMeta | null> {
    return (await idb.get<ProjectMeta>('meta', KEY.meta)) ?? null;
  },
  saveMeta(m: ProjectMeta) {
    return idb.put('meta', KEY.meta, { ...m, updatedAt: Date.now() });
  },
  loadSite(): Promise<SiteModel | null> {
    return idb.get<SiteModel>('site', KEY.site).then((r) => r ?? null);
  },
  saveSite(s: SiteModel) {
    return idb.put('site', KEY.site, s);
  },
  loadTypes(): Promise<FireworkType[]> {
    return idb.get<FireworkType[]>('types', KEY.typesList).then((r) => r ?? []);
  },
  saveTypes(t: FireworkType[]) {
    return idb.put('types', KEY.typesList, t);
  },
  loadChoreo(): Promise<Choreography | null> {
    return idb.get<Choreography>('choreo', KEY.choreo).then((r) => r ?? null);
  },
  saveChoreo(c: Choreography) {
    return idb.put('choreo', KEY.choreo, c);
  },
  loadSimParams(): Promise<SimParams | null> {
    return idb.get<SimParams>('simParams', KEY.simParams).then((r) => r ?? null);
  },
  saveSimParams(p: SimParams) {
    return idb.put('simParams', KEY.simParams, p);
  },
  async saveBlob(key: string, blob: Blob) {
    await idb.put('blobs', key, blob);
  },
  loadBlob(key: string): Promise<Blob | undefined> {
    return idb.get<Blob>('blobs', key);
  },
  async exportBackup(): Promise<BackupFile> {
    const [meta, site, types, choreo, simParams] = await Promise.all([
      storage.loadMeta(), storage.loadSite(), storage.loadTypes(),
      storage.loadChoreo(), storage.loadSimParams(),
    ]);
    return {
      app: 'fireworks-safety-sim',
      version: 1,
      exportedAt: Date.now(),
      meta, site, types, choreo,
      simParams: simParams ?? defaultSimParams(),
    };
  },
  async importBackup(b: BackupFile) {
    if (b.meta) await storage.saveMeta(b.meta);
    if (b.site) await storage.saveSite(b.site);
    if (b.types) await storage.saveTypes(b.types);
    if (b.choreo) await storage.saveChoreo(b.choreo);
    if (b.simParams) await storage.saveSimParams(b.simParams);
  },
};

export function defaultSimParams(): SimParams {
  return {
    maxChargePerWindowKg: 12,
    windowSec: 10,
    minIgnitionIntervalSec: 0.5,
    overpressureAudienceKPa: 2.0,
    overpressureBuildingKPa: 5.0,
    nightStartHour: 22,
    nightLimitDb: 55,
    dayLimitDb: 70,
    symDetonationK: 2.0,
    symDetonationStorageK: 3.0,
    visibilityLimitM: 50,
    plumeConcentrationLimit: 5,
    dudMonteCarloN: 200,
    windDriftFactor: 1.0,
  };
}
