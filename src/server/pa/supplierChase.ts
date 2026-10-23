// 每日催供應商信:把「同一個供應商逾期」的料號與品名列在同一封信,請他盡快提供。
//
// 對象是供應商清單(pa_suppliers,/pa/suppliers)裡有填 Email 的供應商;名稱跟零件上的「供應商」欄位
// 用同一個名字對(不分大小寫、去頭尾空白)。沒填 Email 的供應商不寄,只列在預覽裡提醒補。
//
// 兩種逾期算進來(都是球在供應商手上):
//   * 通知之後超過天數,還沒提供文件(收齊資料逾期)
//   * 被 QA/RD 退件後,超過天數還沒送回更新資料(供應商更新資料逾期)
// pa_supplier_chase_log 以 (日期, 供應商) 當主鍵,同一天重複觸發不會重寄。

import { db, now } from "./db";
import { getUsersByIds } from "./auth";
import { TIMEZONE, listParts } from "./parts";
import { routeTo, todayIn, type Role } from "@/lib/pa";
import { isTwWorkday } from "@/lib/twCalendar";
import { isPendingId, virtualMembers, virtualUsers, withPending, type PendingByPart } from "./pending";
import { MAIL_FROM, mailer, smtpReady } from "./mail";
import { splitEmails } from "./suppliers";


export interface ChaseItem {
  project: string;
  part_pn: string;
  part_desc: string;
  /** 需要供應商做什麼 */
  need: "docs" | "update";
  overBy: number;
  from: string;
  sla: number;
}

export interface SupplierChase {
  /** 供應商名稱(以零件上寫的為準) */
  supplier: string;
  key: string;
  emails: string[];
  /** 這些料的 Sourcer owner 的信箱:信的「回覆」會寄給他們 */
  replyTo: string[];
  /** 副本:這些料負責的 Sourcer、RD、QA(有指定 owner 就只給他,沒指定就整組) */
  cc: string[];
  items: ChaseItem[];
}

const keyOf = (s: string) => s.trim().toLowerCase();

export async function buildSupplierChase(
  today = todayIn(TIMEZONE)
): Promise<{ chases: SupplierChase[]; noEmail: { supplier: string; items: number }[] }> {
  const dir = new Map(
    (await db.all<{ name: string; emails: string }>("select name, emails from pa_suppliers")).map((r) => [keyOf(r.name), splitEmails(r.emails)])
  );
  const projects = await db.all<{ id: string; name: string }>("select id, name from pa_projects where archived = 0 order by name");
  const bySupplier = new Map<string, { supplier: string; items: ChaseItem[]; owners: Set<string>; cc: Set<string> }>();
  const virtual = new Map<string, { id: string; email: string; name: string }>();
  for (const p of projects) {
    const members = await db.all<{ user_id: string; role: string }>("select user_id, role from pa_project_members where project_id = ?", [p.id]);
    const listed = await listParts(p.id, today);
    // 被邀請、還沒建好帳號的 owner 預約:當成虛擬成員,副本直接寄到邀請的信箱
    const pend: PendingByPart = new Map(listed.filter((x) => x.pending_owner).map((x) => [x.id, x.pending_owner!]));
    members.push(...virtualMembers(pend));
    for (const [id, u] of virtualUsers(pend)) virtual.set(id, u);
    for (const raw of listed) {
      const part = withPending(raw, pend);
      if (part.removed_from_bom || part.excluded || !part.supplier.trim()) continue;
      if (part.plm_released || part.plm_upload) continue;
      const add = (item: Omit<ChaseItem, "project" | "part_pn" | "part_desc">) => {
        const k = keyOf(part.supplier);
        const cur = bySupplier.get(k) ?? { supplier: part.supplier.trim(), items: [], owners: new Set<string>(), cc: new Set<string>() };
        cur.items.push({ project: p.name, part_pn: part.part_pn, part_desc: part.part_desc, ...item });
        if (part.sourcer_owner) cur.owners.add(part.sourcer_owner);
        // 副本:這顆料負責的 Sourcer、RD、QA
        for (const role of ["sourcer", "rd", "qa"] as Role[]) for (const m of routeTo(role, part, members)) cur.cc.add(m.user_id);
        bySupplier.set(k, cur);
      };
      const docs = part.ev.docs_received;
      if (docs.light === "red" && part.supplier_notified) {
        add({ need: "docs", overBy: docs.overBy, from: part.supplier_notified, sla: 0 });
      }
      const su = part.ev.supplier_update;
      if (su.light === "red" && su.from) add({ need: "update", overBy: su.overBy, from: su.from, sla: 0 });
    }
  }
  const wanted = new Set([...bySupplier.values()].flatMap((v) => [...v.owners, ...v.cc]));
  const users = await getUsersByIds([...wanted].filter((id) => !isPendingId(id)));
  const emailOf = (id: string) => (isPendingId(id) ? virtual.get(id)?.email : users.get(id)?.email);
  const chases: SupplierChase[] = [];
  const noEmail: { supplier: string; items: number }[] = [];
  for (const [key, v] of bySupplier) {
    const emails = dir.get(key) ?? [];
    v.items.sort((a, b) => b.overBy - a.overBy || a.part_pn.localeCompare(b.part_pn));
    if (!emails.length) {
      noEmail.push({ supplier: v.supplier, items: v.items.length });
      continue;
    }
    const replyTo = [...v.owners].map(emailOf).filter((e): e is string => Boolean(e));
    const sup = new Set(emails.map((e) => e.toLowerCase()));
    // 副本去重、扣掉收件的供應商自己(測試信裡供應商信箱可能就是內部人)
    const cc = [...new Set([...v.cc].map(emailOf).filter((e): e is string => Boolean(e)).map((e) => e.toLowerCase()))].filter((e) => !sup.has(e));
    chases.push({ supplier: v.supplier, key, emails, replyTo, cc, items: v.items });
  }
  chases.sort((a, b) => b.items.length - a.items.length);
  noEmail.sort((a, b) => b.items - a.items);
  return { chases, noEmail };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function renderSupplierChase(c: SupplierChase, today: string, test = false): { subject: string; html: string } {
  const rows = c.items
    .map(
      (i) => `<tr>
  <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:monospace">${esc(i.part_pn)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(i.part_desc)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #eee">${i.need === "docs" ? "承認文件／資料 Approval documents" : "退件後更新資料 Updated documents"}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#c62828;font-weight:600;white-space:nowrap">已逾期 ${i.overBy} 天</td>
</tr>`
    )
    .join("");
  const n = c.items.length;
  return {
    subject: `${test ? "[測試] " : ""}【請盡快提供】零件承認資料：${n} 項已逾期 / ${n} part approval item(s) overdue（${today}）`,
    html: `<div style="font-family:system-ui,'Microsoft JhengHei',sans-serif;color:#222;max-width:860px">
<p>${esc(c.supplier)} 您好，</p>
<p>以下 <b>${n}</b> 項零件的承認資料，已超過約定的提供期限，煩請盡快提供（或回覆預計提供日期）。</p>
<table style="border-collapse:collapse;font-size:13px;width:100%">
<tr style="text-align:left;color:#666"><th style="padding:6px 8px">料號 Part No.</th><th style="padding:6px 8px">品名 Description</th><th style="padding:6px 8px">需要提供 Required</th><th style="padding:6px 8px"></th></tr>
${rows}</table>
<p style="margin-top:16px">提供資料後請直接回覆這封信；如有任何疑問或需要延期，也請回覆告知。謝謝您的配合。</p>
<p style="color:#555">Dear supplier, the part approval documents listed above are overdue. Please provide them as soon as possible, or reply with the expected date. Thank you.</p>
<p style="color:#888;font-size:12px;margin-top:24px">這封信由 PA Tracker 每個台灣上班日自動寄出（逾期期間每天一封）；資料收到後就不會再列入。${test ? `<br><b>（這是測試信，沒有寄給供應商，也沒有副本給同事。）</b><br>正式寄出時，副本會給：${esc(c.cc.join("、") || "（無）")}` : ""}</p>
</div>`,
  };
}

export async function sendSupplierChase(today = todayIn(TIMEZONE)): Promise<{ sent: number; failed: number; skipped: number; noEmail: number }> {
  const result = { sent: 0, failed: 0, skipped: 0, noEmail: 0 };
  if (!smtpReady) return result;
  // 每個台灣上班日寄(逾期每天催);假日、週末不寄
  if (!isTwWorkday(today)) return result;
  const { chases, noEmail } = await buildSupplierChase(today);
  result.noEmail = noEmail.length;
  const transport = mailer();
  for (const c of chases) {
    // 先佔位再寄:兩次觸發撞在一起時第二個會撞主鍵,不會重寄
    try {
      await db.run("insert into pa_supplier_chase_log (day, supplier_key, to_email, sent_at, ok) values (?,?,?,?,0)", [
        today, c.key, c.emails.join(","), now(),
      ]);
    } catch {
      result.skipped++;
      continue;
    }
    const { subject, html } = renderSupplierChase(c, today);
    try {
      await transport.sendMail({ from: MAIL_FROM, to: c.emails, cc: c.cc.length ? c.cc : undefined, replyTo: c.replyTo.length ? c.replyTo : undefined, subject, html });
      await db.run("update pa_supplier_chase_log set ok = 1, sent_at = ? where day = ? and supplier_key = ?", [now(), today, c.key]);
      result.sent++;
    } catch (e) {
      console.error("[pa supplier chase] send failed", c.supplier, e);
      result.failed++;
    }
  }
  return result;
}

/** 測試:把某個供應商(沒指定就挑逾期最多的)的催信寄到指定信箱,不寄給供應商、不寫紀錄。 */
export async function sendSupplierChaseTest(
  to: string,
  supplier?: string,
  today = todayIn(TIMEZONE)
): Promise<{ ok: boolean; supplier?: string; items?: number; error?: string }> {
  if (!smtpReady) return { ok: false, error: "SMTP 尚未設定" };
  const { chases } = await buildSupplierChase(today);
  // 測試時沒填 Email 的供應商也能選(只是借它的逾期清單來試寄)
  let pick = supplier ? chases.find((c) => c.key === keyOf(supplier)) : chases[0];
  if (!pick) pick = await buildAllForTest(today, supplier);
  if (!pick) return { ok: false, error: "目前沒有任何供應商有逾期的料" };
  const { subject, html } = renderSupplierChase(pick, today, true);
  try {
    await mailer().sendMail({ from: MAIL_FROM, to, subject, html });
    return { ok: true, supplier: pick.supplier, items: pick.items.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 測試用:忽略「有沒有填 Email」,回逾期最多(或指定)的供應商 */
async function buildAllForTest(today: string, supplier?: string): Promise<SupplierChase | undefined> {
  const projects = await db.all<{ id: string; name: string }>("select id, name from pa_projects where archived = 0 order by name");
  const m = new Map<string, SupplierChase>();
  for (const p of projects) {
    for (const part of await listParts(p.id, today)) {
      if (part.removed_from_bom || part.excluded || !part.supplier.trim() || part.plm_released || part.plm_upload) continue;
      const k = keyOf(part.supplier);
      const cur = m.get(k) ?? { supplier: part.supplier.trim(), key: k, emails: [], replyTo: [], cc: [], items: [] };
      const docs = part.ev.docs_received;
      if (docs.light === "red" && part.supplier_notified) {
        cur.items.push({ project: p.name, part_pn: part.part_pn, part_desc: part.part_desc, need: "docs", overBy: docs.overBy, from: part.supplier_notified, sla: 0 });
      }
      const su = part.ev.supplier_update;
      if (su.light === "red" && su.from) {
        cur.items.push({ project: p.name, part_pn: part.part_pn, part_desc: part.part_desc, need: "update", overBy: su.overBy, from: su.from, sla: 0 });
      }
      if (cur.items.length) m.set(k, cur);
    }
  }
  const all = [...m.values()].sort((a, b) => b.items.length - a.items.length);
  const pick = supplier ? all.find((c) => c.key === keyOf(supplier)) : all[0];
  pick?.items.sort((a, b) => b.overBy - a.overBy);
  return pick;
}
