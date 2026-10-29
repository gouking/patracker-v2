// 填了日期當下就寄的通知——流程圖上的「Auto Inform?」與「Escalate for help if >= 4」。
//
//   發起 PA(pa_start 從空白變有值)          → 這顆料的 Sourcer owner(沒指定就整組 Sourcer)
//   收齊資料(docs_received 從空白變有值)    → 專案的 QA(QA 先審)
//   QA pass(RD 還沒 pass)                 → 專案的 RD(輪到 RD 審了)
//   RD、QA 都 pass(兩個都有值的那一刻)       → Sourcer(可以上傳 PLM 了)
//   某部門退件累積到 ESCALATE_AT 次            → 專案 PM
//
// 每日逾期信(digest.ts)照舊;這裡只管「事情剛發生」。
// 同一顆料同一件事只寄一次(pa_notify_log 主鍵):日期填錯再改,不會再寄一封。
// 自己做的事不寄給自己。一次批次填 50 顆,每個收件人只收一封、裡面列 50 顆。
//
// 由 API route 用 next/server 的 after() 在回應送出之後才跑,存檔不用等寄信。

import { db, now } from "./db";
import { getUsersByIds } from "./auth";
import { isPendingId, pendingForParts, virtualMembers, virtualUsers, withPending } from "./pending";
import { APP_BASE, MAIL_FROM, mailer, smtpReady } from "./mail";
import { ESCALATE_AT, isDate, rdNeeded, routeTo, type Part, type Role } from "@/lib/pa";

export type PaEventKind = "start" | "docs" | "qa_pass" | "approved" | "escalate:RD" | "escalate:QA";

export interface PaEvent {
  kind: PaEventKind;
  partId: string;
}

/** 改一欄之後,比對前後找出該通知的事 */
export function fieldEvents(before: Part, key: string, value: string | null): PaEvent[] {
  const after = { ...before, [key]: value } as Part;
  const became = (k: keyof Part) => !isDate(before[k] as string | null) && isDate(after[k] as string | null);
  const out: PaEvent[] = [];
  if (became("pa_start")) out.push({ kind: "start", partId: before.id });
  if (became("docs_received")) out.push({ kind: "docs", partId: before.id });
  // QA pass 之後輪到 RD 審;沒有 RD owner(不用 RD 審)的料就沒有這一步,直接是「可上 PLM」
  if (became("qa_pass") && !isDate(after.rd_pass) && rdNeeded(after)) out.push({ kind: "qa_pass", partId: before.id });
  const bothBefore = isDate(before.qa_pass) && (isDate(before.rd_pass) || !rdNeeded(before));
  const bothAfter = isDate(after.qa_pass) && (isDate(after.rd_pass) || !rdNeeded(after));
  if (!bothBefore && bothAfter) out.push({ kind: "approved", partId: before.id });
  return out;
}

/** 記完一筆退件之後:剛好達到門檻才通知(之後的第 5、6 次交給每日信) */
export function issueEvent(partId: string, dept: "RD" | "QA", countAfter: number): PaEvent[] {
  return countAfter === ESCALATE_AT ? [{ kind: `escalate:${dept}`, partId }] : [];
}

const TEXT: Record<PaEventKind, { roles: Role[]; title: string; ask: string }> = {
  start: { roles: ["sourcer"], title: "已發起 PA", ask: "請通知供應商提供承認文件／樣品" },
  docs: { roles: ["qa"], title: "供應商資料已收齊", ask: "請開始 review（IMDS 013-01、02、07）" },
  qa_pass: { roles: ["rd"], title: "QA 已 pass", ask: "輪到 RD 審核，請開始 review" },
  approved: { roles: ["sourcer"], title: "RD、QA 皆已 pass", ask: "請把零件承認資料上傳 PLM 送簽" },
  "escalate:RD": { roles: ["pm"], title: `RD 退件已達 ${ESCALATE_AT} 次`, ask: "請協助處理（流程：Escalate for help）" },
  "escalate:QA": { roles: ["pm"], title: `QA 退件已達 ${ESCALATE_AT} 次`, ask: "請協助處理（流程：Escalate for help）" },
};
const ORDER: PaEventKind[] = ["escalate:RD", "escalate:QA", "docs", "qa_pass", "approved", "start"];

export interface Notice {
  user_id: string;
  email: string;
  name: string;
  groups: { kind: PaEventKind; parts: Pick<Part, "id" | "part_pn" | "part_desc">[] }[];
}

/** 決定誰收到什麼(不寄、不寫紀錄;檢查腳本直接測這支) */
export async function planNotices(projectId: string, actorId: string, events: PaEvent[]): Promise<Notice[]> {
  if (!events.length) return [];
  const members = await db.all<{ user_id: string; role: string }>(
    "select user_id, role from pa_project_members where project_id = ?",
    [projectId]
  );
  const ids = [...new Set(events.map((e) => e.partId))];
  const parts = await db.all<Pick<Part, "id" | "part_pn" | "part_desc" | "sourcer_owner" | "rd_owner">>(
    "select id, part_pn, part_desc, sourcer_owner, rd_owner from pa_parts where project_id = ? and id = any(?::text[])",
    [projectId, ids]
  );
  // 被邀請、還沒建好帳號的 owner 預約:當成虛擬成員,通知直接寄到邀請的信箱
  const pend = await pendingForParts(ids);
  members.push(...virtualMembers(pend));
  const partById = new Map(parts.map((p) => [p.id, withPending(p, pend)]));
  // user → kind → parts
  const byUser = new Map<string, Map<PaEventKind, Pick<Part, "id" | "part_pn" | "part_desc">[]>>();
  for (const e of events) {
    const part = partById.get(e.partId);
    if (!part) continue;
    // 指定了 Sourcer owner／RD owner 的料,那個角色只寄給他(跟每日信同一條規則)
    const to = TEXT[e.kind].roles.flatMap((r: Role) => routeTo(r, part, members));
    for (const uid of new Set(to.map((m) => m.user_id))) {
      if (uid === actorId) continue;
      const kinds = byUser.get(uid) ?? new Map();
      const list = kinds.get(e.kind) ?? [];
      if (!list.some((p: { id: string }) => p.id === part.id)) list.push({ id: part.id, part_pn: part.part_pn, part_desc: part.part_desc });
      kinds.set(e.kind, list);
      byUser.set(uid, kinds);
    }
  }
  const users = await getUsersByIds([...byUser.keys()].filter((id) => !isPendingId(id)));
  for (const [id, u] of virtualUsers(pend)) if (byUser.has(id)) users.set(id, u as never);
  const out: Notice[] = [];
  for (const [uid, kinds] of byUser) {
    const u = users.get(uid);
    if (!u?.email) continue;
    out.push({
      user_id: uid,
      email: u.email,
      name: u.name,
      groups: ORDER.filter((k) => kinds.has(k)).map((k) => ({ kind: k, parts: kinds.get(k)! })),
    });
  }
  return out;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function renderNotice(n: Notice, project: { id: string; name: string }): { subject: string; html: string } {
  const total = n.groups.reduce((x, g) => x + g.parts.length, 0);
  const first = n.groups[0];
  const subject =
    n.groups.length === 1
      ? `[PA Tracker] ${project.name}：${TEXT[first.kind].title}（${total} 顆）`
      : `[PA Tracker] ${project.name}：${total} 顆料有新進度`;
  const sections = n.groups
    .map((g) => {
      const rows = g.parts
        .map(
          (p) => `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;font-family:monospace">${esc(p.part_pn)}</td>
<td style="padding:4px 8px;border-bottom:1px solid #eee">${esc(p.part_desc)}</td></tr>`
        )
        .join("");
      return `<h3 style="margin:20px 0 4px">${esc(TEXT[g.kind].title)}（${g.parts.length}）</h3>
<p style="margin:0 0 8px;color:#444">${esc(TEXT[g.kind].ask)}</p>
<table style="border-collapse:collapse;font-size:13px">${rows}</table>`;
    })
    .join("");
  return {
    subject,
    html: `<div style="font-family:system-ui,sans-serif;color:#222;max-width:760px">
<p>${esc(n.name)} 你好，</p>
${sections}
<p style="margin-top:20px"><a href="${APP_BASE}/pa/p/${project.id}?mine=1">打開 ${esc(project.name)} →</a></p>
<p style="color:#888;font-size:12px;margin-top:24px">這封信是有人在 PA Tracker 填了日期時自動寄出的；同一顆料同一件事只會通知一次。</p>
</div>`,
  };
}

/** 先寫紀錄佔位(撞主鍵的就是寄過了、略過),再依收件人寄。 */
export async function sendNotices(projectId: string, actorId: string, events: PaEvent[]): Promise<{ sent: number; failed: number }> {
  const result = { sent: 0, failed: 0 };
  if (!events.length) return result;
  try {
    const fresh: PaEvent[] = [];
    const ts = now();
    for (const e of events) {
      const r = await db.all("insert into pa_notify_log (part_id, event, sent_at) values (?,?,?) on conflict do nothing returning part_id", [
        e.partId, e.kind, ts,
      ]);
      if (r.length) fresh.push(e);
    }
    if (!fresh.length || !smtpReady) return result;
    const project = await db.get<{ id: string; name: string }>("select id, name from pa_projects where id = ?", [projectId]);
    if (!project) return result;
    const transport = mailer();
    for (const n of await planNotices(projectId, actorId, fresh)) {
      const { subject, html } = renderNotice(n, project);
      try {
        await transport.sendMail({ from: MAIL_FROM, to: n.email, subject, html });
        result.sent++;
      } catch (e) {
        console.error("[pa notify] send failed", n.email, e);
        result.failed++;
      }
    }
  } catch (e) {
    // 通知失敗不能影響存檔(這時回應早就送出去了),記下來就好
    console.error("[pa notify] failed", e);
  }
  return result;
}
