// 每個人自己的畫面設定(追蹤表顯示哪幾欄、欄寬),存在資料庫、跟著帳號走:
// 換電腦、換瀏覽器打開還是自己調好的樣子。瀏覽器那份(localStorage)只當快取。

import { db, now } from "./db";
import type { User } from "./auth";
import { HttpError } from "./projects";

/** 只收這幾個鍵,免得變成任意資料的儲存空間 */
export const PREF_KEYS = ["pa-hidden-cols", "pa-col-widths", "pa-filters"] as const;
const MAX_LEN = 8000;

export async function getPrefs(user: User): Promise<Record<string, string>> {
  const rows = await db.all<{ key: string; value: string }>("select key, value from pa_user_prefs where user_id = ?", [user.id]);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function setPref(user: User, key: string, value: unknown): Promise<void> {
  if (!(PREF_KEYS as readonly string[]).includes(key)) throw new HttpError(400, "不支援的設定");
  const v = String(value ?? "");
  if (v.length > MAX_LEN) throw new HttpError(400, "設定內容太長");
  try {
    JSON.parse(v);
  } catch {
    throw new HttpError(400, "設定格式錯誤");
  }
  await db.run(
    `insert into pa_user_prefs (user_id, key, value, updated_at) values (?,?,?,?)
     on conflict (user_id, key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    [user.id, key, v, now()]
  );
}
