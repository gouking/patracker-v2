// 每日逾期信:每人一封,只列「他在該專案負責的角色、已經紅燈」的料號。
//
// 本機版是伺服器常駐時每 10 分鐘看一次時間;這裡沒有常駐的行程,改由
// Vercel Cron 每天叫一次 /api/pa/digest(見 vercel.json)。
// pa_digest_log 以 (day, user) 當主鍵,重複觸發不會重寄。

import { db, now } from "./db";
import { getUsersByIds } from "./auth";
import { isPendingId, virtualMembers, virtualUsers, withPending, type PendingByPart } from "./pending";
import { TIMEZONE, listParts } from "./parts";
import { ROLE_LABEL, STAGES, routeTo, stageDays, stageStart, todayIn, type Role } from "@/lib/pa";
import { getSla, type Project } from "./projects";
import { APP_BASE as APP_URL, MAIL_FROM as SMTP_FROM, mailer, smtpReady } from "./mail";

export { smtpReady };

export interface DigestItem {
  part_id: string;
  part_pn: string;
  part_desc: string;
  stage: string;
  role: Role;
  from: string;
  sla: number;
  overBy: number;
  /** 退件達 ESCALATE_AT 次、要 PM 出面的那一種(沒有 SLA,改顯示退件次數) */
  escalate?: { dept: "RD" | "QA"; count: number };
}

export interface Digest {
  user_id: string;
  name: string;
  email: string;
  projects: { project: Pick<Project, "id" | "name">; items: DigestItem[] }[];
  total: number;
}

export async function buildDigests(today = todayIn(TIMEZONE)): Promise<Digest[]> {
  const projects = await db.all<Project>("select * from pa_projects where archived = 0 order by name");
  const byUser = new Map<string, Map<string, DigestItem[]>>();
  const virtual = new Map<string, { id: string; email: string; name: string }>();
  const projectById = new Map(projects.map((p) => [p.id, p]));

  for (const p of projects) {
    const sla = await getSla(p.id);
    const members = await db.all<{ user_id: string; role: string }>(
      "select user_id, role from pa_project_members where project_id = ?",
      [p.id]
    );
    const listed = (await listParts(p.id, today)).filter((x) => !x.removed_from_bom && !x.excluded);
    // 被邀請、還沒建好帳號的 owner 預約:當成虛擬成員,信直接寄到邀請的信箱
    const pend: PendingByPart = new Map(listed.filter((x) => x.pending_owner).map((x) => [x.id, x.pending_owner!]));
    members.push(...virtualMembers(pend));
    for (const [id, u] of virtualUsers(pend)) virtual.set(id, u);
    const parts = listed.map((x) => withPending(x, pend));
    const push = (uid: string, item: DigestItem) => {
      const projMap = byUser.get(uid) ?? new Map<string, DigestItem[]>();
      const list = projMap.get(p.id) ?? [];
      list.push(item);
      projMap.set(p.id, list);
      byUser.set(uid, projMap);
    };
    for (const part of parts) {
      // 流程圖:退件 >= 4 次要往上報 → 專案 PM 每天都會看到,直到那個部門 pass
      for (const dept of part.ev.escalated) {
        const count = part.issues.filter((i) => i.dept === dept).length;
        const item: DigestItem = {
          part_id: part.id, part_pn: part.part_pn, part_desc: part.part_desc,
          stage: `${dept} 退件 ${count} 次，需協助`, role: "pm", from: "", sla: 0, overBy: 0,
          escalate: { dept, count },
        };
        for (const m of members.filter((x) => x.role === "pm")) push(m.user_id, item);
      }
      for (const s of STAGES) {
        const e = part.ev[s.key];
        if (e.light !== "red") continue;
        const item: DigestItem = {
          part_id: part.id,
          part_pn: part.part_pn,
          part_desc: part.part_desc,
          stage: s.label,
          role: s.owner,
          from: stageStart(part, s, part.issues) as string,
          sla: stageDays(part, s, sla, part.issues) ?? 0,
          overBy: e.overBy,
        };
        // 這顆料指定了 Sourcer owner／RD owner 就只寄給他;沒指定才整組一起收
        // 同一人身兼 RD+QA 時同一顆料可能出現兩次(兩個階段),那是兩件事,保留
        for (const m of routeTo(s.owner, part, members)) push(m.user_id, item);
      }
      // 退件後供應商遲遲沒送回更新資料 → Sourcer 去催
      const su = part.ev.supplier_update;
      if (su.light === "red" && su.from) {
        const item: DigestItem = {
          part_id: part.id, part_pn: part.part_pn, part_desc: part.part_desc,
          stage: `供應商更新資料（${su.dept} 退件）`, role: "sourcer", from: su.from, sla: sla.supplier_update, overBy: su.overBy,
        };
        for (const m of routeTo("sourcer", part, members)) push(m.user_id, item);
      }
    }
  }

  const users = await getUsersByIds([...byUser.keys()].filter((id) => !isPendingId(id)));
  for (const [id, u] of virtual) if (byUser.has(id)) users.set(id, u as never);
  const out: Digest[] = [];
  for (const [uid, projMap] of byUser) {
    const u = users.get(uid);
    if (!u) continue;
    const ps = [...projMap].map(([pid, items]) => ({
      project: { id: pid, name: projectById.get(pid)!.name },
      // 要 PM 出面的排最前面,其餘照逾期天數
      items: items.sort((a, b) => Number(Boolean(b.escalate)) - Number(Boolean(a.escalate)) || b.overBy - a.overBy),
    }));
    out.push({ user_id: uid, name: u.name, email: u.email, projects: ps, total: ps.reduce((n, x) => n + x.items.length, 0) });
  }
  return out.sort((a, b) => b.total - a.total);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function renderDigest(d: Digest, today: string): { subject: string; html: string } {
  const sections = d.projects
    .map(({ project, items }) => {
      const rows = items
        .map(
          (i) => `<tr>
  <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:monospace">${esc(i.part_pn)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(i.part_desc)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(ROLE_LABEL[i.role])}：${esc(i.stage)}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #eee;white-space:nowrap">${i.escalate ? "—" : `${i.from} 起 ${i.sla} 天`}</td>
  <td style="padding:6px 8px;border-bottom:1px solid #eee;color:#c62828;font-weight:600;white-space:nowrap">${i.escalate ? "請協助" : `逾期 ${i.overBy} 天`}</td>
</tr>`
        )
        .join("");
      return `<h3 style="margin:24px 0 8px">${esc(project.name)}（${items.length}）</h3>
<table style="border-collapse:collapse;font-size:13px;width:100%">
<tr style="text-align:left;color:#666"><th style="padding:6px 8px">材料料號</th><th style="padding:6px 8px">品名</th><th style="padding:6px 8px">待辦</th><th style="padding:6px 8px">期限</th><th style="padding:6px 8px"></th></tr>
${rows}</table>
<p><a href="${APP_URL}/pa/p/${project.id}?mine=1&overdue=1">打開 ${esc(project.name)} 的逾期清單 →</a></p>`;
    })
    .join("");
  return {
    subject: `[PA Tracker] 你有 ${d.total} 項零件承認${d.projects.some((x) => x.items.some((i) => i.escalate)) ? "逾期或需協助" : "已逾期"}（${today}）`,
    html: `<div style="font-family:system-ui,sans-serif;color:#222;max-width:860px">
<p>${esc(d.name)} 你好，</p>
<p>以下是 ${today} 由你負責、已超過 SLA 天數還沒完成（或退件過多需要協助）的 PA 步驟：</p>
${sections}
<p style="color:#888;font-size:12px;margin-top:32px">這封信由 PA Tracker 每天自動寄出；步驟完成後填上日期就不會再出現。</p>
</div>`,
  };
}

export async function sendDigests(today = todayIn(TIMEZONE)): Promise<{ sent: number; failed: number; skipped: number }> {
  const result = { sent: 0, failed: 0, skipped: 0 };
  if (!smtpReady) return result;
  const transport = mailer();
  for (const d of await buildDigests(today)) {
    if (await db.get("select 1 from pa_digest_log where day = ? and user_id = ?", [today, d.user_id])) {
      result.skipped++;
      continue;
    }
    // 先佔位再寄:兩次觸發撞在一起時第二個會撞主鍵,不會重寄
    try {
      await db.run("insert into pa_digest_log (day, user_id, sent_at, ok) values (?,?,?,0)", [today, d.user_id, now()]);
    } catch {
      result.skipped++;
      continue;
    }
    const { subject, html } = renderDigest(d, today);
    try {
      await transport.sendMail({ from: SMTP_FROM, to: d.email, subject, html });
      await db.run("update pa_digest_log set ok = 1, sent_at = ? where day = ? and user_id = ?", [now(), today, d.user_id]);
      result.sent++;
    } catch (e) {
      console.error("[pa digest] send failed", d.email, e);
      result.failed++;
    }
  }
  return result;
}
