// 供應商清單與 Email:催供應商發信用。所有登入的人都能新增、修改、刪除。
// 名稱不分大小寫不能重複(跟零件上的「供應商」欄位用同一個名字對得起來)。

import { db, newId, now } from "./db";
import type { User } from "./auth";
import { HttpError } from "./projects";

export interface Supplier {
  id: string;
  name: string;
  emails: string;
  contact: string;
  note: string;
  updated_at: string | null;
  updated_by: string | null;
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** 換行、逗號、分號都當分隔;去重、轉小寫 */
export function splitEmails(raw: string): string[] {
  return [...new Set(raw.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];
}

function clean(b: Partial<Pick<Supplier, "name" | "emails" | "contact" | "note">>) {
  const name = String(b.name ?? "").trim();
  if (!name) throw new HttpError(400, "供應商名稱不能空白");
  if (name.length > 200) throw new HttpError(400, "供應商名稱太長");
  const list = splitEmails(String(b.emails ?? ""));
  const bad = list.find((e) => !EMAIL_RE.test(e));
  if (bad) throw new HttpError(400, `Email 格式不對：${bad}`);
  return {
    name,
    emails: list.join("\n"),
    contact: String(b.contact ?? "").trim().slice(0, 100),
    note: String(b.note ?? "").trim().slice(0, 500),
  };
}

export async function listSuppliers(): Promise<{ suppliers: Supplier[]; unlisted: { name: string; parts: number }[] }> {
  const suppliers = await db.all<Supplier>("select * from pa_suppliers order by lower(name)");
  // 零件上出現過、但還沒建檔的供應商,讓人一鍵補進來
  const unlisted = await db.all<{ name: string; parts: number }>(
    `select trim(p.supplier) as name, count(*)::int as parts
       from pa_parts p
      where coalesce(trim(p.supplier), '') <> ''
        and not exists (select 1 from pa_suppliers s where lower(s.name) = lower(trim(p.supplier)))
      group by trim(p.supplier)
      order by count(*) desc, trim(p.supplier)`
  );
  return { suppliers, unlisted };
}

async function dupCheck(name: string, exceptId?: string) {
  const d = await db.get<{ id: string }>("select id from pa_suppliers where lower(name) = lower(?)", [name]);
  if (d && d.id !== exceptId) throw new HttpError(409, `「${name}」已經在清單裡了`);
}

export async function createSupplier(user: User, b: Partial<Supplier>): Promise<Supplier> {
  const c = clean(b);
  await dupCheck(c.name);
  const id = newId();
  await db.run(
    "insert into pa_suppliers (id, name, emails, contact, note, updated_at, updated_by) values (?,?,?,?,?,?,?)",
    [id, c.name, c.emails, c.contact, c.note, now(), user.id]
  );
  return (await db.get<Supplier>("select * from pa_suppliers where id = ?", [id]))!;
}

export async function updateSupplier(user: User, id: string, b: Partial<Supplier>): Promise<Supplier> {
  const c = clean(b);
  await dupCheck(c.name, id);
  const r = await db.run(
    "update pa_suppliers set name = ?, emails = ?, contact = ?, note = ?, updated_at = ?, updated_by = ? where id = ?",
    [c.name, c.emails, c.contact, c.note, now(), user.id, id]
  );
  if (!r.changes) throw new HttpError(404, "找不到這家供應商");
  return (await db.get<Supplier>("select * from pa_suppliers where id = ?", [id]))!;
}

export async function deleteSupplier(id: string): Promise<void> {
  await db.run("delete from pa_suppliers where id = ?", [id]);
}

/** 把零件上出現過、還沒建檔的供應商名稱全部補進清單(Email 先空白) */
export async function importFromParts(user: User): Promise<number> {
  const { unlisted } = await listSuppliers();
  for (const u of unlisted) {
    await db.run(
      "insert into pa_suppliers (id, name, updated_at, updated_by) values (?,?,?,?) on conflict do nothing",
      [newId(), u.name, now(), user.id]
    );
  }
  return unlisted.length;
}
