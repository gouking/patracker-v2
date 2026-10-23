/**
 * 追蹤表「上次的篩選」,每個人、每個專案各記一份。
 *
 * 跟欄位設定(paCols.ts)同一個做法:存在伺服器(/api/pa/prefs,表 pa_user_prefs)跟著帳號走,
 * 這台瀏覽器的 localStorage 當快取 —— 換電腦打開還是上次的篩選。
 * 不記搜尋框的字(那是一次性的),其餘都記。篩選條件裡的負責人是帳號 id,所以按專案分開存。
 */

import { api } from "./paClient";

export const PAFILTERS_KEY = "pa-filters";

export interface SavedFilters {
  phase: string | null;
  owner: string;
  mine: boolean;
  owned: boolean;
  overdue: boolean;
  stage: string | null;
  hideAlts: boolean;
  showExcluded: boolean;
  showRemoved: boolean;
}

export const NO_FILTERS: SavedFilters = {
  phase: null, owner: "", mine: false, owned: false, overdue: false, stage: null,
  hideAlts: false, showExcluded: false, showRemoved: false,
};

type Store = Record<string, SavedFilters>;
const MAX_PROJECTS = 30;

function sane(x: unknown): SavedFilters | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const b = (v: unknown) => v === true;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    phase: s(o.phase) || null, owner: s(o.owner), mine: b(o.mine), owned: b(o.owned), overdue: b(o.overdue),
    stage: s(o.stage) || null, hideAlts: b(o.hideAlts), showExcluded: b(o.showExcluded), showRemoved: b(o.showRemoved),
  };
}

function parse(raw: string | null | undefined): Store {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return {};
    const out: Store = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const f = sane(v);
      if (f) out[k] = f;
    }
    return out;
  } catch {
    return {};
  }
}

function readLocal(): Store {
  try {
    return parse(window.localStorage.getItem(PAFILTERS_KEY));
  } catch {
    return {};
  }
}

/** 這台瀏覽器記的那一份(同步,畫面一打開就能套) */
export function localFilters(projectId: string): SavedFilters | null {
  return readLocal()[projectId] ?? null;
}

let serverPromise: Promise<Store> | null = null;

/** 伺服器上的那一份(整個頁面生命週期只問一次);換電腦時靠它 */
export function serverFilters(projectId: string): Promise<SavedFilters | null> {
  serverPromise ??= api<{ prefs: Record<string, string> }>("/api/pa/prefs").then(
    (r) => parse(r.prefs?.[PAFILTERS_KEY]),
    () => ({})
  );
  return serverPromise.then((m) => m[projectId] ?? null);
}

let timer: ReturnType<typeof setTimeout> | null = null;
let latest = "";

export function saveFilters(projectId: string, f: SavedFilters): void {
  const store = readLocal();
  delete store[projectId]; // 重新插到最後,超過上限時丟最舊的專案
  store[projectId] = f;
  for (const k of Object.keys(store).slice(0, Math.max(0, Object.keys(store).length - MAX_PROJECTS))) delete store[k];
  latest = JSON.stringify(store);
  try {
    window.localStorage.setItem(PAFILTERS_KEY, latest);
  } catch {
    // 記不起來也不能擋住操作
  }
  serverPromise = Promise.resolve(store);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    api("/api/pa/prefs", { method: "PUT", json: { key: PAFILTERS_KEY, value: latest } }).catch(() => {
      // 送不上去(離線)就算了,這台瀏覽器還記得
    });
  }, 800);
}
