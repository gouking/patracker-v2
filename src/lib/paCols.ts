/**
 * 追蹤表要顯示哪幾欄。
 *
 * 全部 19 欄加起來 2600px 左右,一般螢幕一定得橫捲;橫捲的表格很難用——看不到
 * 料號就對不上是哪一列。所以預設把「平常不看、需要時再打開」的那幾欄收起來,
 * 讓剩下的寬度放得進一個畫面。
 *
 * 個人偏好,跟著帳號走(2026-10-08 起):伺服器上存一份(/api/pa/prefs,表 pa_user_prefs),
 * 這台瀏覽器的 localStorage 當快取 —— 打開追蹤表時 syncColPrefs() 先把伺服器那份拉下來,
 * 之後每次改都寫回去(稍微延遲合併,拖欄寬時不會一直送)。換電腦打開還是自己調好的樣子。
 * 讀法跟 src/lib/homeview.ts 一樣走 useSyncExternalStore,所以 readHiddenCols()
 * **必須回同一個物件**(值沒變就不能換參考),否則 React 會一直重畫。
 */

import { api } from "./paClient";

export const PACOLS_KEY = "pa-hidden-cols";

/** 預設收起來的欄位:退件次數點開側欄就看得到,PLM/首件與 BOM 欄位平常不看。 */
export const HIDDEN_DEFAULT: string[] = [
  "rd_review_start",
  "qa_review_start",
  "rd_issues",
  "qa_issues",
  "lifecycle",
  "fg_model",
  "main_pn",
  "fg_pn",
  "fg_desc",
  "bom_level",
  "parent_pn",
  "find_num",
  "alt_of_pn",
  "qty",
  "ref_des",
];

const DEFAULT_SET: ReadonlySet<string> = new Set(HIDDEN_DEFAULT);

function parse(raw: string | null): ReadonlySet<string> {
  if (!raw) return DEFAULT_SET;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.map(String)) : DEFAULT_SET;
  } catch {
    return DEFAULT_SET;
  }
}

let cache: { raw: string | null; value: ReadonlySet<string> } | null = null;

export function readHiddenCols(): ReadonlySet<string> {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PACOLS_KEY);
  } catch {
    return DEFAULT_SET;
  }
  if (!cache || cache.raw !== raw) cache = { raw, value: parse(raw) };
  return cache.value;
}

/** 伺服器端畫第一版時用預設值(那裡沒有 localStorage)。 */
export function serverHiddenCols(): ReadonlySet<string> {
  return DEFAULT_SET;
}

const listeners = new Set<() => void>();

export function writeHiddenCols(hidden: ReadonlySet<string>): void {
  const raw = JSON.stringify([...hidden]);
  try {
    window.localStorage.setItem(PACOLS_KEY, raw);
  } catch {
    // 記不起來也不能擋住操作
  }
  push(PACOLS_KEY, raw);
  for (const fn of listeners) fn();
}

// ---------- 跟著帳號走:同步到伺服器 ----------

const pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** 改了就排著,0.8 秒內的變更合併成一次送出 */
function push(key: string, raw: string): void {
  pending.set(key, raw);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const batch = [...pending];
    pending.clear();
    for (const [k, v] of batch) {
      api("/api/pa/prefs", { method: "PUT", json: { key: k, value: v } }).catch(() => {
        // 送不上去(離線)就算了,這台瀏覽器還記得;下次改動會再送
      });
    }
  }, 800);
}

let synced = false;

/** 打開追蹤表時呼叫一次:伺服器有的以伺服器為準;伺服器還沒有、這台瀏覽器有的,就把這台的傳上去
 *  (之前只存在瀏覽器裡的設定才不會不見)。 */
export async function syncColPrefs(): Promise<void> {
  if (synced) return;
  synced = true;
  let server: Record<string, string> = {};
  try {
    server = (await api<{ prefs: Record<string, string> }>("/api/pa/prefs")).prefs ?? {};
  } catch {
    synced = false;
    return;
  }
  let changed = false;
  for (const key of [PACOLS_KEY, PAWIDTH_KEY]) {
    let local: string | null = null;
    try {
      local = window.localStorage.getItem(key);
    } catch {
      // 讀不到就當沒有
    }
    if (server[key] !== undefined) {
      if (server[key] !== local) {
        try {
          window.localStorage.setItem(key, server[key]);
          changed = true;
        } catch {
          // 寫不進去就只好用預設
        }
      }
    } else if (local) {
      push(key, local);
    }
  }
  if (changed) for (const fn of listeners) fn();
}

export function subscribeHiddenCols(fn: () => void): () => void {
  listeners.add(fn);
  window.addEventListener("storage", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", fn);
  };
}

// ---------- 欄寬 ----------
//
// 每個人看的螢幕不一樣、在意的欄位也不一樣,所以欄寬可以自己拉(表頭右緣往左右拖),
// 拉完記在這台瀏覽器。沒拉過的欄位就用 Tracker.tsx 裡 COLS[].w 的預設值。

export const PAWIDTH_KEY = "pa-col-widths";

/** 太窄看不到內容、太寬會把別人擠出畫面 */
export const MIN_COL_W = 60;
export const MAX_COL_W = 900;

export const clampColW = (w: number) => Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.round(w)));

const NO_WIDTHS: ReadonlyMap<string, number> = new Map();
let widthCache: { raw: string | null; value: ReadonlyMap<string, number> } | null = null;

function parseWidths(raw: string | null): ReadonlyMap<string, number> {
  if (!raw) return NO_WIDTHS;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return NO_WIDTHS;
    return new Map(
      Object.entries(obj as Record<string, unknown>)
        .map(([k, v]) => [k, clampColW(Number(v))] as const)
        .filter(([, v]) => Number.isFinite(v))
    );
  } catch {
    return NO_WIDTHS;
  }
}

export function readColWidths(): ReadonlyMap<string, number> {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(PAWIDTH_KEY);
  } catch {
    return NO_WIDTHS;
  }
  if (!widthCache || widthCache.raw !== raw) widthCache = { raw, value: parseWidths(raw) };
  return widthCache.value;
}

export function serverColWidths(): ReadonlyMap<string, number> {
  return NO_WIDTHS;
}

export function writeColWidth(key: string, w: number): void {
  const next = new Map(readColWidths());
  next.set(key, clampColW(w));
  save(next);
}

/** 全部回到預設寬度 */
export function resetColWidths(): void {
  save(new Map());
}

function save(next: ReadonlyMap<string, number>): void {
  const raw = JSON.stringify(Object.fromEntries(next));
  try {
    window.localStorage.setItem(PAWIDTH_KEY, raw);
  } catch {
    // 記不起來也不能擋住操作
  }
  push(PAWIDTH_KEY, raw);
  for (const fn of listeners) fn();
}

