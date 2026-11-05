// 料號的讀取、單欄修改(含權限與修改紀錄)、退件紀錄。
// 規則與本機版相同,差別只在資料庫是 Postgres(async)與 pa_ 前綴的表名。

import { db, newId, now, type Db } from "./db";
import { getUsersByIds } from "./auth";
import { HttpError, getSla, requireManage, rolesOf, type Access } from "./projects";
import { pendingForParts, pendingForProject } from "./pending";
import { fieldEvents, issueEvent, type PaEvent } from "./notify";
import {
  DEFAULT_SLA,
  FIELD_BY_KEY,
  ISSUE_EDITOR,
  OWNER_ROLE,
  ROLE_LABEL,
  RESUBMIT_EDITORS,
  PART_TYPES,
  canEditField,
  evalPart,
  isDate,
  todayIn,
  type Issue,
  type IssueLite,
  type Note,
  type Part,
  type PartEval,
  type PhaseKey,
  type Role,
  type Sla,
} from "@/lib/pa";

export interface PartRow extends Part {
  issues: IssueLite[];
  /** 這顆料全部的進度紀錄(新到舊)。表格上那一欄就像原本 Excel 的 remark 一樣一列多行,
   *  2026-10-08 起全部顯示(使用者要看完整歷程);名稱沿用,改名牽動太多地方。 */
  recent_notes: Pick<Note, "date" | "text">[];
  ev: PartEval;
  /** 被邀請、還沒建好帳號的人預約了這顆料的 owner(接受邀請後會變成真的 owner) */
  pending_owner?: Partial<Record<"sourcer_owner" | "rd_owner", { email: string; name: string }>>;
}

/** 每顆料全部的進度,一次查完(不要一列一個查詢)。 */
async function recentNotes(projectId: string): Promise<Map<string, Pick<Note, "date" | "text">[]>> {
  const rows = await db.all<{ part_id: string; date: string; text: string }>(
    `select n.part_id, n.date, n.text
       from pa_part_notes n join pa_parts p on p.id = n.part_id
      where p.project_id = ?
      order by n.part_id, n.date desc, n.created_at desc`,
    [projectId]
  );
  const m = new Map<string, Pick<Note, "date" | "text">[]>();
  for (const r of rows) {
    const list = m.get(r.part_id) ?? [];
    list.push({ date: r.date, text: r.text });
    m.set(r.part_id, list);
  }
  return m;
}

export const TIMEZONE = process.env.REMINDER_TIMEZONE || "Asia/Taipei";

/** 紅黃燈、階段要的退件欄位(表格每一列都帶著,所以只留這三個) */
const lite = (i: Pick<Issue, "dept" | "date" | "resubmitted"> & { created_at?: string }): IssueLite => ({
  dept: i.dept, date: i.date, resubmitted: i.resubmitted ?? null, ...(i.created_at ? { created_at: i.created_at } : {}),
});

export async function issuesByPart(projectId: string): Promise<Map<string, Issue[]>> {
  const rows = await db.all<Issue>(
    `select i.* from pa_review_issues i join pa_parts p on p.id = i.part_id where p.project_id = ? order by i.date, i.created_at`,
    [projectId]
  );
  const m = new Map<string, Issue[]>();
  for (const r of rows) {
    const list = m.get(r.part_id) ?? [];
    list.push(r);
    m.set(r.part_id, list);
  }
  return m;
}

export async function listParts(projectId: string, today = todayIn(TIMEZONE)): Promise<PartRow[]> {
  const [sla, parts, issues, notes, pend] = await Promise.all([
    getSla(projectId),
    db.all<Part>("select * from pa_parts where project_id = ? order by removed_from_bom, sort_order, part_pn", [projectId]),
    issuesByPart(projectId),
    recentNotes(projectId),
    pendingForProject(projectId),
  ]);
  return parts.map((p) => {
    const iss = (issues.get(p.id) ?? []).map(lite);
    const pending_owner = pend.get(p.id);
    // 預約給「被邀請、還沒上線」的 RD 也算有 RD owner(不用 RD 審的判斷要看這個)
    const pp: Part = pending_owner?.rd_owner ? { ...p, rd_owner_pending: true } : p;
    return { ...pp, issues: iss, recent_notes: notes.get(p.id) ?? [], ev: evalPart(pp, iss, sla, today), ...(pending_owner ? { pending_owner } : {}) };
  });
}

export interface ProjectStat {
  total: number;
  approved: number;
  /** 已發起但還沒 RD+QA 都 pass */
  started: number;
  /** 有任何一階紅燈 */
  red: number;
  /** 輪到「我」那幾個角色的 */
  mine: number;
  /** 階段統計(專案列表的 Dashboard):含不追蹤(不需PA)、不含已不在 BOM */
  phases: Partial<Record<PhaseKey, number>>;
  phaseTotal: number;
  /** 「廠商資料更新」(QA 退件)那些料,各被 QA 退件幾次:{ 退件次數: 料數 } */
  reworkQa: Record<number, number>;
}

/** 專案卡片與首頁摘要要的數字。
 *
 *  三個刻意的選擇,都是為了第一次進來那一下:
 *   1. 不走 listParts():那會連退件紀錄與進度紀錄一起撈,這裡一個都用不到
 *      (紅黃燈只看日期與屬性)。
 *   2. 只取算得到數字的那幾欄,不是 select *。
 *   3. **一句查完**(SLA 用 join 帶進來、多個專案一起):在 serverless 上每開一條新連線
 *      就是一次 TLS 握手(量到約 400ms),平行查反而會多開連線,比省下的往返還貴。 */
export async function projectStats(
  ids: string[],
  rolesOfProject: (id: string) => Role[],
  today = todayIn(TIMEZONE)
): Promise<Map<string, ProjectStat>> {
  const out = new Map<string, ProjectStat>();
  if (!ids.length) return out;
  type Row = Pick<
    Part,
    | "project_id" | "part_type" | "pa_start" | "supplier_notified" | "docs_received" | "rd_review_start" | "qa_review_start" | "rd_pass" | "qa_pass"
    | "plm_upload" | "plm_released" | "hold_reason" | "excluded" | "supplier_updated" | "supplier_updated_at" | "rd_owner" | "rd_owner_pending" | "drawing_release"
  > & {
    last_rd_issue: string | null; last_qa_issue: string | null; last_rd_resub: string | null; last_qa_resub: string | null;
    last_rd_created: string | null; last_qa_created: string | null; qa_issue_n: string | number | null;
  } &
    Partial<Sla>;
  const rows = await db.all<Row>(
    `select p.project_id, p.part_type, p.pa_start, p.supplier_notified, p.docs_received,
            p.rd_review_start, p.qa_review_start, p.rd_pass, p.qa_pass, p.plm_upload, p.plm_released, p.hold_reason, p.excluded,
            p.supplier_updated, p.supplier_updated_at, p.rd_owner, p.drawing_release,
            exists (select 1 from pa_pending_owners o where o.part_id = p.id and o.field = 'rd_owner') as rd_owner_pending,
            i.last_rd_issue, i.last_qa_issue, i.last_rd_resub, i.last_qa_resub, i.last_rd_created, i.last_qa_created, i.qa_issue_n,
            g.supplier_notified as sla_supplier_notified, g.docs_std, g.docs_custom, g.rd_pass as sla_rd_pass, g.qa_pass as sla_qa_pass,
            g.supplier_update as sla_supplier_update, g.rereview as sla_rereview
       from pa_parts p
       -- SLA 全公司一套(只有一列),跟著同一句查回來,不多一趟
       left join pa_global_sla g on g.id = 1
       -- 階段與「等供應商更新」只需要各部門最後一筆退件:日期與供應商送回的日期
       left join (
         select part_id,
                (json_group_array(date order by date desc, created_at desc) filter (where dept = 'RD')) ->> 0 as last_rd_issue,
                (json_group_array(resubmitted order by date desc, created_at desc) filter (where dept = 'RD')) ->> 0 as last_rd_resub,
                (json_group_array(date order by date desc, created_at desc) filter (where dept = 'QA')) ->> 0 as last_qa_issue,
                (json_group_array(resubmitted order by date desc, created_at desc) filter (where dept = 'QA')) ->> 0 as last_qa_resub,
                (json_group_array(created_at order by date desc, created_at desc) filter (where dept = 'RD')) ->> 0 as last_rd_created,
                (json_group_array(created_at order by date desc, created_at desc) filter (where dept = 'QA')) ->> 0 as last_qa_created,
                count(*) filter (where dept = 'QA') as qa_issue_n
           from pa_review_issues group by part_id
       ) i on i.part_id = p.id
      where p.project_id = any(?::text[]) and p.removed_from_bom = 0`,
    [ids]
  );
  for (const id of ids) out.set(id, { total: 0, approved: 0, started: 0, red: 0, mine: 0, phases: {}, phaseTotal: 0, reworkQa: {} });
  for (const r of rows) {
    const stat = out.get(r.project_id);
    if (!stat) continue;
    const row = r as Row & Record<string, unknown>;
    const sla: Sla = {
      supplier_notified: Number(row.sla_supplier_notified ?? DEFAULT_SLA.supplier_notified),
      docs_std: Number(row.docs_std ?? DEFAULT_SLA.docs_std),
      docs_custom: Number(row.docs_custom ?? DEFAULT_SLA.docs_custom),
      rd_pass: Number(row.sla_rd_pass ?? DEFAULT_SLA.rd_pass),
      qa_pass: Number(row.sla_qa_pass ?? DEFAULT_SLA.qa_pass),
      supplier_update: Number(row.sla_supplier_update ?? DEFAULT_SLA.supplier_update),
      rereview: Number(row.sla_rereview ?? DEFAULT_SLA.rereview),
    };
    // 階段與「等供應商更新」只看各部門最後一筆退件,所以兩筆就夠
    const iss: IssueLite[] = [];
    if (r.last_rd_issue) iss.push({ dept: "RD", date: r.last_rd_issue, resubmitted: r.last_rd_resub, ...(r.last_rd_created ? { created_at: r.last_rd_created } : {}) });
    if (r.last_qa_issue) iss.push({ dept: "QA", date: r.last_qa_issue, resubmitted: r.last_qa_resub, ...(r.last_qa_created ? { created_at: r.last_qa_created } : {}) });
    const ev = evalPart(r as unknown as Part, iss, sla, today);
    stat.phases[ev.phase] = (stat.phases[ev.phase] ?? 0) + 1;
    stat.phaseTotal++;
    if (ev.phase === "rework_qa") {
      const n = Number(r.qa_issue_n ?? 0);
      if (n > 0) stat.reworkQa[n] = (stat.reworkQa[n] ?? 0) + 1;
    }
    if (r.excluded) continue;
    stat.total++;
    if (ev.approved) stat.approved++;
    else if (r.pa_start) stat.started++;
    if (ev.red > 0) stat.red++;
    const mineRoles = rolesOfProject(r.project_id);
    if (mineRoles.length && ev.waitingOn.some((x) => mineRoles.includes(x))) stat.mine++;
  }
  return out;
}

/** 表格要的那一列(含 Status 與紅黃燈)。改完一格之後回這個就夠,
 *  不必像側欄那樣再查退件紀錄、修改紀錄與帳號名稱。 */
export async function partRow(a: Access, partId: string, today = todayIn(TIMEZONE)): Promise<PartRow> {
  // 四個查詢彼此不相干,一起送出去等一次就好
  const [p, issues, sla, notes, pend] = await Promise.all([
    getPartIn(a, partId),
    db.all<Pick<Issue, "dept" | "date" | "resubmitted" | "created_at">>(
      "select dept, date, resubmitted, created_at from pa_review_issues where part_id = ? order by date, created_at",
      [partId]
    ),
    getSla(a.project.id),
    db.all<Pick<Note, "date" | "text">>(
      "select date, text from pa_part_notes where part_id = ? order by date desc, created_at desc",
      [partId]
    ),
    pendingForParts([partId]),
  ]);
  const iss = issues.map(lite);
  const pending_owner = pend.get(partId);
  const pp: Part = pending_owner?.rd_owner ? { ...p, rd_owner_pending: true } : p;
  return { ...pp, issues: iss, recent_notes: notes, ev: evalPart(pp, iss, sla, today), ...(pending_owner ? { pending_owner } : {}) };
}

async function getPartIn(a: Access, partId: string): Promise<Part> {
  const p = await db.get<Part>("select * from pa_parts where id = ? and project_id = ?", [partId, a.project.id]);
  if (!p) throw new HttpError(404, "找不到這個料號");
  return p;
}

function touch(t: Db, projectId: string) {
  return t.run("update pa_projects set updated_at = ? where id = ?", [now(), projectId]);
}

export function normalizeValue(key: string, raw: unknown): string | null {
  const f = FIELD_BY_KEY[key];
  if (!f) throw new HttpError(400, "未知的欄位");
  const s = raw === null || raw === undefined ? "" : String(raw).trim();
  if (f.kind === "date") {
    if (!s) return null;
    if (!isDate(s)) throw new HttpError(400, "日期格式要是 YYYY-MM-DD");
    return s;
  }
  if (f.kind === "type") {
    if (s && !PART_TYPES.includes(s as never)) throw new HttpError(400, "屬性只能是標準件或訂製件");
    return s;
  }
  if (f.kind === "hold") {
    if (s.length > 40) throw new HttpError(400, "卡關原因太長（最多 40 字）");
    return s;
  }
  if (f.kind === "user") {
    // 空字串 = 沒指定;有值就必須是帳號 id(是不是這個專案的成員由呼叫端再查一次)
    // invite:<id> = 已發邀請、還沒建好帳號的人(預約成為 owner,見 setPendingOwner)
    if (s && !/^(invite:)?[0-9a-f-]{36}$/i.test(s)) throw new HttpError(400, "請從成員清單裡選一個人");
    return s;
  }
  if (s.length > 500) throw new HttpError(400, "內容太長");
  return s;
}

/** 改一欄。呼叫端要的是改完之後的樣子,自己用 partRow()／partDetail() 拿 ——
 *  這裡不順手再讀一次,雲端上那是一趟白跑的往返。
 *  回傳這次改動該寄的即時通知(交給 notify.ts 的 sendNotices,在回應送出之後才寄)。 */
export async function updatePartField(a: Access, userId: string, partId: string, key: string, raw: unknown): Promise<PaEvent[]> {
  if (!canEditField(key, a.roles, a.isAdmin)) {
    throw new HttpError(403, "這個欄位不是你的角色負責的");
  }
  const part = await getPartIn(a, partId);
  const value = normalizeValue(key, raw);
  if (FIELD_BY_KEY[key]?.kind === "user") {
    if (value?.startsWith("invite:")) return setPendingOwner(a, userId, part, key, value);
    // 改回真的帳號(或清空)→ 先前的預約作廢
    await db.run("delete from pa_pending_owners where part_id = ? and field = ?", [partId, key]);
  }
  await assertAssignable(a, key, value);
  const old = part[key as keyof Part] as string | null;
  if ((old ?? "") === (value ?? "")) return [];
  const ts = now();
  // 改值、寫修改紀錄、更新專案時間要同生共死 → 一個交易(SQLite 在本機,沒有網路往返的顧慮)。
  // key 已經由 canEditField 確認在白名單 FIELDS 裡,才能安全地組進 SQL
  await db.tx(async (t) => {
    const r = await t.run(`update pa_parts set ${key} = ?, updated_at = ? where id = ?`, [value, ts, partId]);
    if (!r.changes) return;
    await t.run("insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,?,?,?,?)", [
      partId, userId, key, old, value, ts,
    ]);
    await t.run("update pa_projects set updated_at = ? where id = ?", [ts, a.project.id]);
  });
  if (key === "supplier_updated") {
    await db.run("update pa_parts set supplier_updated_at = ? where id = ?", [value ? ts : null, partId]);
  }
  // 表格上直接改「卡關原因」:卡關日期 = 今天,舊的那筆結案
  if (key === "hold_reason") await syncHold(db, part, value ?? "", userId, todayIn(TIMEZONE));
  // 上傳 PLM 送簽了,卡關原因自動清掉(完成日期 = 上傳日)
  if (clearsHold(key, value, part.hold_reason)) {
    await endHold(db, part, userId, value!, ts);
  }
  // Sourcer 回填「供應商更新資料日期」= 供應商把資料送來了:已通知供應商、還沒填「收齊資料」的料,
  // 一併把收齊資料填成同一天 —— 階段才會進到「待QA審核」、QA 才會收到通知、QA 期限從這天算
  if (key === "supplier_updated" && value && isDate(part.supplier_notified) && !isDate(part.docs_received)) {
    await db.tx(async (t) => {
      const r = await t.run("update pa_parts set docs_received = ?, updated_at = ? where id = ? and docs_received is null", [value, ts, partId]);
      if (!r.changes) return;
      await t.run(
        "insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,'docs_received',null,?,?)",
        [partId, userId, value, ts]
      );
    });
    return [...fieldEvents(part, key, value), ...fieldEvents(part, "docs_received", value)];
  }
  return fieldEvents(part, key, value);
}

/** 把某顆料的 owner 預約給「已發邀請、還沒建好帳號」的人:真正的 owner 欄先清空,
 *  預約存在 pa_pending_owners,他接受邀請那一刻自動換成真的(src/server/invite.ts)。
 *  在那之前,逾期信與即時通知直接寄到邀請的信箱(pending.ts)。 */
async function setPendingOwner(a: Access, userId: string, part: Part, key: string, value: string): Promise<PaEvent[]> {
  const inv = await db.get<{ email: string; pa_roles: string }>(
    "select email, pa_roles from app_invites where id = ?::uuid and pa_project_id = ? and used_at is null and expires_at > now()",
    [value.slice("invite:".length), a.project.id]
  );
  if (!inv) throw new HttpError(400, "這個邀請已經失效，請重新邀請");
  const need = OWNER_ROLE[key as keyof typeof OWNER_ROLE];
  if (need && !inv.pa_roles.split(",").includes(need)) throw new HttpError(400, `${key === "rd_owner" ? "RD owner" : "Sourcer owner"} 要是這個專案的 ${ROLE_LABEL[need]}`);
  const ts = now();
  const old = (part[key as keyof Part] as string | null) ?? "";
  await db.tx(async (t) => {
    await t.run(
      `insert into pa_pending_owners (part_id, field, email) values (?,?,?)
       on conflict (part_id, field) do update set email = excluded.email`,
      [part.id, key, inv.email]
    );
    if (old) {
      await t.run(`update pa_parts set ${key} = '', updated_at = ? where id = ?`, [ts, part.id]);
      await t.run("insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,?,?,?,?)", [
        part.id, userId, key, old, `pending:${inv.email}`, ts,
      ]);
    }
    await touch(t, a.project.id);
  });
  return [];
}

/** 負責人只能指定給這個專案的成員 —— 不然逾期信會寄給一個根本看不到這個專案的人。
 *  RD owner 還要是這個專案的 RD(Sourcer owner 維持舊規則,只要是成員就行,舊資料才不會失效)。 */
async function assertAssignable(a: Access, key: string, value: string | null) {
  if (FIELD_BY_KEY[key]?.kind !== "user" || !value) return;
  const roles = await rolesOf(a.project.id, value);
  if (!roles.length) throw new HttpError(400, "這個人不是這個專案的成員");
  if (key === "rd_owner" && !roles.includes(OWNER_ROLE.rd_owner)) throw new HttpError(400, "RD owner 要是這個專案的 RD");
}

// ---------- 進度紀錄(原本 Excel 的 remark) ----------

/** 專案成員都可以記一筆進度:日期＋一行字。誰記的會留下來。 */
export async function addNote(a: Access, userId: string, partId: string, date: string, text: string): Promise<Note> {
  if (!isDate(date)) throw new HttpError(400, "日期格式要是 YYYY-MM-DD");
  const body = String(text ?? "").trim().slice(0, 2000);
  if (!body) throw new HttpError(400, "請寫一行進度");
  const id = newId();
  const ts = now();
  // 一句做完:確認料號屬於這個專案、寫進度、寫修改紀錄、更新專案時間,並把新的那筆帶回來。
  // 原本是「先查料號 → 寫入 → 再讀回來」三趟,雲端上每一趟使用者都等得到。
  const row = await db.tx(async (t) => {
    const part = await t.get<{ id: string }>("select id from pa_parts where id = ? and project_id = ?", [partId, a.project.id]);
    if (!part) return undefined;
    await t.run("insert into pa_part_notes (id, part_id, date, text, created_by, created_at) values (?,?,?,?,?,?)", [
      id, partId, date, body, userId, ts,
    ]);
    await t.run("insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,'note',null,?,?)", [
      partId, userId, `${date} ${body}`, ts,
    ]);
    await t.run("update pa_projects set updated_at = ? where id = ?", [ts, a.project.id]);
    return t.get<Note>("select * from pa_part_notes where id = ?", [id]);
  });
  if (!row) throw new HttpError(404, "找不到這個料號");
  return row;
}

/** 只能刪自己記的(專案 PM 與系統管理員例外)。 */
export async function deleteNote(a: Access, userId: string, noteId: string): Promise<string> {
  const n = await db.get<Note & { project_id: string }>(
    "select n.*, p.project_id from pa_part_notes n join pa_parts p on p.id = n.part_id where n.id = ?",
    [noteId]
  );
  if (!n || n.project_id !== a.project.id) throw new HttpError(404, "找不到這筆進度紀錄");
  if (!a.canManage && n.created_by !== userId) throw new HttpError(403, "只能刪除自己記的進度紀錄");
  const ts = now();
  await db.tx(async (t) => {
    const r = await t.run("delete from pa_part_notes where id = ?", [noteId]);
    if (!r.changes) return;
    await t.run("insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,'note',?,null,?)", [
      n.part_id, userId, `${n.date} ${n.text}`, ts,
    ]);
    await t.run("update pa_projects set updated_at = ? where id = ?", [ts, a.project.id]);
  });
  return n.part_id;
}

export async function addIssue(
  a: Access, userId: string, partId: string, dept: string, date: string, note: string, events: PaEvent[] = []
): Promise<Issue> {
  if (dept !== "RD" && dept !== "QA") throw new HttpError(400, "部門只能是 RD 或 QA");
  if (!a.isAdmin && !a.roles.includes(ISSUE_EDITOR[dept])) throw new HttpError(403, `只有 ${dept} 可以記錄 ${dept} 的退件`);
  if (!isDate(date)) throw new HttpError(400, "日期格式要是 YYYY-MM-DD");
  const id = newId();
  const ts = now();
  const text = String(note ?? "").trim().slice(0, 2000);
  // 一句做完(原本是查料號、BEGIN、三句寫入、COMMIT、數次數、讀回來,共八趟):
  // 同一句裡的 select 看不到這次 insert 的列,所以「這次之後共幾次」= 原本的次數 + 1
  const row = await db.tx(async (t) => {
    const part = await t.get<{ id: string }>("select id from pa_parts where id = ? and project_id = ?", [partId, a.project.id]);
    if (!part) return undefined;
    await t.run("insert into pa_review_issues (id, part_id, dept, date, note, created_by, created_at) values (?,?,?,?,?,?,?)", [
      id, partId, dept, date, text, userId, ts,
    ]);
    await t.run("insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,?,null,?,?)", [
      partId, userId, `issue:${dept}`, `${date}${text ? ` ${text}` : ""}`, ts,
    ]);
    await t.run("update pa_projects set updated_at = ? where id = ?", [ts, a.project.id]);
    // 這次寫進去之後該部門共幾次(含這一筆)
    return t.get<Issue & { n_after: string }>(
      `select i.*, (select count(*) from pa_review_issues r where r.part_id = i.part_id and r.dept = i.dept) as n_after
         from pa_review_issues i where i.id = ?`,
      [id]
    );
  });
  if (!row) throw new HttpError(404, "找不到這個料號");
  events.push(...issueEvent(partId, dept, Number(row.n_after)));
  const issue: Issue & { n_after?: string } = { ...row };
  delete issue.n_after;
  return issue;
}

/** 退件之後供應商送回更新資料的日期(空值＝改回「還在等供應商」)。
 *  Sourcer 與退件的那個部門可以填;系統管理員一律可以。 */
export async function setIssueResubmitted(a: Access, userId: string, issueId: string, raw: unknown): Promise<string> {
  const iss = await db.get<Issue & { project_id: string }>(
    "select i.*, p.project_id from pa_review_issues i join pa_parts p on p.id = i.part_id where i.id = ?",
    [issueId]
  );
  if (!iss || iss.project_id !== a.project.id) throw new HttpError(404, "找不到這筆退件紀錄");
  if (!a.isAdmin && !RESUBMIT_EDITORS[iss.dept].some((r) => a.roles.includes(r))) {
    throw new HttpError(403, `只有 Sourcer 或 ${iss.dept} 可以填供應商更新日期`);
  }
  const v = raw === null || raw === undefined || raw === "" ? null : String(raw);
  if (v !== null && !isDate(v)) throw new HttpError(400, "日期格式要是 YYYY-MM-DD");
  if (v !== null && v < iss.date) throw new HttpError(400, "供應商更新日不能早於退件日");
  if ((iss.resubmitted ?? null) === v) return iss.part_id;
  const ts = now();
  await db.tx(async (t) => {
    const r = await t.run("update pa_review_issues set resubmitted = ? where id = ?", [v, issueId]);
    if (!r.changes) return;
    await t.run("insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,?,?,?,?)", [
      iss.part_id, userId, `issue_resubmitted:${iss.dept}`, `${iss.date}→${iss.resubmitted ?? ""}`, `${iss.date}→${v ?? ""}`, ts,
    ]);
    await t.run("update pa_projects set updated_at = ? where id = ?", [ts, a.project.id]);
  });
  return iss.part_id;
}

export async function deleteIssue(a: Access, userId: string, issueId: string): Promise<string> {
  const iss = await db.get<Issue & { project_id: string }>(
    "select i.*, p.project_id from pa_review_issues i join pa_parts p on p.id = i.part_id where i.id = ?",
    [issueId]
  );
  if (!iss || iss.project_id !== a.project.id) throw new HttpError(404, "找不到這筆退件紀錄");
  if (!a.isAdmin && iss.created_by !== userId) throw new HttpError(403, "只能刪除自己記的退件紀錄");
  // 刪除、寫修改紀錄、更新專案時間一句做完(原本是一個五趟往返的交易)
  const ts = now();
  await db.tx(async (t) => {
    const r = await t.run("delete from pa_review_issues where id = ?", [issueId]);
    if (!r.changes) return;
    await t.run("insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,?,?,null,?)", [
      iss.part_id, userId, `issue:${iss.dept}`, `${iss.date}${iss.note ? ` ${iss.note}` : ""}`, ts,
    ]);
    await t.run("update pa_projects set updated_at = ? where id = ?", [ts, a.project.id]);
  });
  return iss.part_id;
}

/** 批次填同一個欄位(屬性、日期…)。權限跟單筆一樣逐欄檢查,每一筆都留修改紀錄。
 *  值跟原本一樣的那幾筆會跳過,不會灌一堆沒意義的紀錄。該寄的即時通知放進 events。 */
// ---------- 卡關(原因、日期、負責人、完成日期) ----------

type Runner = Pick<Db, "run">;

/** 把目前進行中的卡關存進歷史(pa_part_holds):原因、起始日、負責人、備註、完成日期 */
async function archiveHold(t: Runner, part: Part, userId: string, resolved: string, ts: string) {
  if (!part.hold_reason) return;
  await t.run(
    `insert into pa_part_holds (id, part_id, reason, started, owner, note, resolved, resolved_by, created_at)
     values (?,?,?,?,?,?,?,?,?)`,
    [newId(), part.id, part.hold_reason, part.hold_since ?? resolved, part.hold_owner ?? "", part.hold_note ?? "", resolved, userId, ts]
  );
}

/** 結束進行中的卡關:歷史留一筆、料上的卡關欄位清空,階段就回到日期推得出來的樣子 */
async function endHold(t: Runner, part: Part, userId: string, resolved: string, ts: string) {
  if (!part.hold_reason) return;
  await archiveHold(t, part, userId, resolved, ts);
  await t.run("update pa_parts set hold_reason = '', hold_since = null, hold_owner = '', hold_note = '', updated_at = ? where id = ?", [ts, part.id]);
  await t.run("insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,?,?,?,?)", [
    part.id, userId, "hold_reason", part.hold_reason, "", ts,
  ]);
}

/** 卡關原因被改了(表格直接改、批次改):舊的那筆結案,新的原因從 today 起算。
 *  這時 pa_parts.hold_reason 已經是新值,part 是改之前的樣子。 */
async function syncHold(t: Runner, part: Part, next: string, userId: string, today: string) {
  if ((part.hold_reason ?? "") === next) return;
  await archiveHold(t, part, userId, today, now());
  await t.run("update pa_parts set hold_since = ?, hold_owner = '', hold_note = '' where id = ?", [next ? today : null, part.id]);
}

export interface HoldInput {
  reason: string;
  since?: string | null;
  owner?: string | null;
  note?: string | null;
}

/** 開始(或改)一筆卡關:原因自由填、卡關日期(預設今天)、負責人(專案成員,誰都可以)、備註。
 *  原因換了 → 舊的那筆以新卡關日期結案,新的開始;同一個原因 = 改細節。 */
export async function setHold(a: Access, userId: string, partId: string, input: HoldInput): Promise<void> {
  if (!canEditField("hold_reason", a.roles, a.isAdmin)) throw new HttpError(403, "你在這個專案是唯讀，不能設定卡關");
  const part = await getPartIn(a, partId);
  const reason = String(input.reason ?? "").trim();
  if (!reason) throw new HttpError(400, "請填卡關原因");
  if (reason.length > 40) throw new HttpError(400, "卡關原因太長（最多 40 字）");
  const since = input.since ? String(input.since) : todayIn(TIMEZONE);
  if (!isDate(since)) throw new HttpError(400, "卡關日期格式要是 YYYY-MM-DD");
  const owner = String(input.owner ?? "").trim();
  if (owner && !(await rolesOf(a.project.id, owner)).length) throw new HttpError(400, "負責人要是這個專案的成員");
  const note = String(input.note ?? "").trim().slice(0, 300);
  const ts = now();
  await db.tx(async (t) => {
    const changed = (part.hold_reason ?? "") !== reason;
    if (changed) await archiveHold(t, part, userId, since, ts);
    await t.run(
      "update pa_parts set hold_reason = ?, hold_since = ?, hold_owner = ?, hold_note = ?, updated_at = ? where id = ?",
      [reason, since, owner, note, ts, partId]
    );
    if (changed) {
      await t.run("insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,?,?,?,?)", [
        partId, userId, "hold_reason", part.hold_reason ?? "", reason, ts,
      ]);
    }
    await touch(t, a.project.id);
  });
}

/** 解除卡關:填完成日期(預設今天),料回到原本的階段 */
export async function resolveHold(a: Access, userId: string, partId: string, resolved?: string | null): Promise<void> {
  if (!canEditField("hold_reason", a.roles, a.isAdmin)) throw new HttpError(403, "你在這個專案是唯讀，不能解除卡關");
  const part = await getPartIn(a, partId);
  if (!part.hold_reason) throw new HttpError(400, "這顆料沒有在卡關");
  const day = resolved ? String(resolved) : todayIn(TIMEZONE);
  if (!isDate(day)) throw new HttpError(400, "完成日期格式要是 YYYY-MM-DD");
  if (part.hold_since && day < part.hold_since) throw new HttpError(400, "完成日期不能早於卡關日期");
  await db.tx(async (t) => {
    await endHold(t, part, userId, day, now());
    await touch(t, a.project.id);
  });
}

/** 填了「上傳 PLM 送簽」,卡關就算解掉了。圖面 Release 不清:「待RD圖面進版」要留著,階段才會是待上傳 PLM、SLA 才會略過這顆 */
function clearsHold(key: string, value: string | null, hold: string | null | undefined): boolean {
  if (!value || !hold) return false;
  return key === "plm_upload";
}

export async function updatePartsField(
  a: Access, userId: string, partIds: string[], key: string, raw: unknown, events: PaEvent[] = []
): Promise<number> {
  if (!canEditField(key, a.roles, a.isAdmin)) throw new HttpError(403, "這個欄位不是你的角色負責的");
  const ids = [...new Set(partIds)].filter(Boolean);
  if (!ids.length) throw new HttpError(400, "沒有選到料號");
  if (ids.length > 5000) throw new HttpError(400, "一次最多 5000 筆");
  const value = normalizeValue(key, raw);
  if (FIELD_BY_KEY[key]?.kind === "user") {
    if (value?.startsWith("invite:")) {
      let n = 0;
      for (const id of ids) {
        const p = await db.get<Part>("select * from pa_parts where id = ? and project_id = ?", [id, a.project.id]);
        if (!p || p.removed_from_bom || p.excluded) continue;
        await setPendingOwner(a, userId, p, key, value);
        n++;
      }
      return n;
    }
    await db.run("delete from pa_pending_owners where part_id = any(?::text[]) and field = ?", [ids, key]);
  }
  await assertAssignable(a, key, value);
  let changed = 0;
  await db.tx(async (t) => {
    const ts = now();
    for (const id of ids) {
      const p = await t.get<Part>("select * from pa_parts where id = ? and project_id = ?", [id, a.project.id]);
      if (!p || p.removed_from_bom || p.excluded) continue;
      const old = (p[key as keyof Part] as string | null) ?? null;
      if ((old ?? "") === (value ?? "")) continue;
      // key 已由 canEditField 確認在白名單 FIELDS 裡,才能組進 SQL
      await t.run(`update pa_parts set ${key} = ?, updated_at = ? where id = ?`, [value, ts, id]);
      await t.run("insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,?,?,?,?)", [
        id, userId, key, old, value, ts,
      ]);
      if (key === "hold_reason") await syncHold(t, p, value ?? "", userId, todayIn(TIMEZONE));
      if (clearsHold(key, value, p.hold_reason)) await endHold(t, p, userId, value!, ts);
      events.push(...fieldEvents(p, key, value));
      changed++;
    }
    if (changed) await touch(t, a.project.id);
  });
  return changed;
}

/** 把料號排除在 PA 追蹤之外(或恢復)。母階組件、樣品件之類本來就不用做 PA。
 *  只是標記:修改紀錄、退件紀錄都留著,重新匯入 BOM 也不會把它們倒回追蹤清單。 */
export async function setExcluded(a: Access, userId: string, partIds: string[], excluded: boolean, note = "手動排除"): Promise<number> {
  // 專案成員都能排除／恢復追蹤(PM Head 這種沒有專案角色的唯讀帳號不行)
  if (!a.isAdmin && a.roles.length === 0) throw new HttpError(403, "你在這個專案是唯讀，不能改");
  const ids = [...new Set(partIds)].filter(Boolean);
  if (!ids.length) throw new HttpError(400, "沒有選到料號");
  if (ids.length > 5000) throw new HttpError(400, "一次最多 5000 筆");
  let changed = 0;
  await db.tx(async (t) => {
    const ts = now();
    for (const id of ids) {
      const p = await t.get<Part>("select * from pa_parts where id = ? and project_id = ?", [id, a.project.id]);
      if (!p || Boolean(p.excluded) === excluded) continue;
      await t.run("update pa_parts set excluded = ?, excluded_note = ?, updated_at = ? where id = ?", [
        excluded ? 1 : 0, excluded ? note : "", ts, id,
      ]);
      await t.run("insert into pa_part_history (part_id, user_id, field, old_value, new_value, at) values (?,?,?,?,?,?)", [
        id, userId, "excluded", p.excluded ? (p.excluded_note || "不追蹤") : "追蹤中", excluded ? note : "追蹤中", ts,
      ]);
      changed++;
    }
    if (changed) await touch(t, a.project.id);
  });
  return changed;
}

export interface HoldRecord {
  id: string;
  reason: string;
  started: string;
  owner: string;
  owner_name: string;
  note: string;
  resolved: string;
  resolved_by_name: string;
}

export interface PartDetail {
  part: PartRow;
  /** 這顆料以前卡關過的歷史(新的在前);進行中的那筆在 part.hold_* */
  holds: HoldRecord[];
  notes: (Note & { created_by_name: string })[];
  issues: (Issue & { created_by_name: string })[];
}

export async function partDetail(a: Access, partId: string): Promise<PartDetail> {
  // 修改紀錄照樣寫(誰在何時改了什麼是要留的),只是側欄不再顯示,所以這裡不查、也不回傳
  const [p, notes, issues, sla, holdRows] = await Promise.all([
    getPartIn(a, partId),
    db.all<Note>("select * from pa_part_notes where part_id = ? order by date desc, created_at desc", [partId]),
    db.all<Issue>("select * from pa_review_issues where part_id = ? order by date, created_at", [partId]),
    getSla(a.project.id),
    db.all<Omit<HoldRecord, "owner_name" | "resolved_by_name"> & { resolved_by: string }>(
      "select id, reason, started, owner, note, resolved, resolved_by from pa_part_holds where part_id = ? order by resolved desc, started desc",
      [partId]
    ),
  ]);
  const users = await getUsersByIds([
    ...notes.map((n) => n.created_by), ...issues.map((i) => i.created_by),
    ...holdRows.flatMap((h) => [h.owner, h.resolved_by]).filter(Boolean),
  ]);
  const name = (id: string) => (id === "import" ? "BOM 匯入" : users.get(id)?.name ?? "(已刪除的帳號)");
  const iss = issues.map(lite);
  const recent = notes.map((n) => ({ date: n.date, text: n.text }));
  return {
    part: { ...p, issues: iss, recent_notes: recent, ev: evalPart(p, iss, sla, todayIn(TIMEZONE)) },
    notes: notes.map((n) => ({ ...n, created_by_name: name(n.created_by) })),
    issues: issues.map((i) => ({ ...i, created_by_name: name(i.created_by) })),
    holds: holdRows.map(({ resolved_by, ...h }) => ({
      ...h,
      owner_name: h.owner ? users.get(h.owner)?.name ?? "(已不是成員)" : "",
      resolved_by_name: name(resolved_by),
    })),
  };
}
