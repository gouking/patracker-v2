// PA 的業務規則：欄位、角色、SLA 紅黃燈、狀態推導。
//
// 全部是純函式、不 import 任何東西——伺服器、瀏覽器、scripts/*.mts（node 直接跑）共用同一份，
// 紅黃燈的判斷只能有一個來源，否則畫面、匯出、每日信三邊會對不上。
//
// 規則照原本的「XT Part approval tracker」Excel 條件格式還原：
//   紅 = 本欄空白，且 今天 − 起算日 > SLA（逾期未完成）
//   黃 = 本欄已填，且 |本欄 − 起算日| > SLA（完成但延遲；Excel 用 ABS，這裡照做）
//   起算日空白 → 不判斷；收齊資料那一步屬性空白 → 不判斷
// 唯一刻意的差異：Excel 的紅燈也套 ABS，起算日填成未來日期會被標紅；這裡未來的起算日不算逾期。

export type Role = "pm" | "sourcer" | "rd" | "qa";
export const ROLES: Role[] = ["pm", "sourcer", "rd", "qa"];
export const ROLE_LABEL: Record<Role, string> = {
  pm: "PM",
  sourcer: "Sourcer",
  rd: "RD",
  qa: "QA",
};

export type PartType = "標準件" | "訂製件";
export const PART_TYPES: PartType[] = ["標準件", "訂製件"];

/** 卡關原因:日期推不出來、要人判斷的兩種。存的就是這兩個字串。 */
export type HoldReason = "待RD圖面進版" | "ISSUE";
export const HOLD_REASONS: HoldReason[] = ["待RD圖面進版", "ISSUE"];
export const HOLD_HINT: Record<HoldReason, string> = {
  待RD圖面進版: "包材圖面待進版（EC）後上 PLM",
  ISSUE: "尚未提交初版文件，需 PM/RD 決議",
};

export interface Sla {
  supplier_notified: number; // L，自 K 起算
  docs_std: number; // M 標準件，自 L 起算
  docs_custom: number; // M 訂製件，自 L 起算
  rd_pass: number; // N，自 M 起算
  qa_pass: number; // O，自 M 起算
  /** 退件給供應商之後,供應商要在幾天內送回更新的資料(自退件日起算) */
  supplier_update: number;
  /** 供應商補件之後,QA/RD 要在幾天內審完(自供應商補件日起算) */
  rereview: number;
}
export const DEFAULT_SLA: Sla = { supplier_notified: 3, docs_std: 7, docs_custom: 21, rd_pass: 7, qa_pass: 7, supplier_update: 7, rereview: 3 };

/** SLA 設定頁與匯出共用的名稱。全公司一套、只有系統管理員能改(/pa/sla)。
 *  「廠商第一次回」與「廠商更新資料」是兩件事:前者是通知之後第一次提供文件,
 *  後者是 RD/QA 退件之後把修正的資料送回來。 */
export const SLA_FIELDS: { key: keyof Sla; label: string; from: string; who: string }[] = [
  { key: "supplier_notified", label: "Sourcer 通知供應商", from: "自 PM/RD 發起 PA", who: "Sourcer" },
  { key: "docs_std", label: "廠商第一次回：提供文件 — 標準件", from: "自 Sourcer 通知供應商", who: "供應商／Sourcer" },
  { key: "docs_custom", label: "廠商第一次回：提供文件 — 訂製件", from: "自 Sourcer 通知供應商", who: "供應商／Sourcer" },
  { key: "rd_pass", label: "RD review pass", from: "自收齊資料", who: "RD" },
  { key: "qa_pass", label: "QA review pass", from: "自收齊資料", who: "QA" },
  { key: "supplier_update", label: "廠商更新資料：退件後送回", from: "自 RD/QA 退件日", who: "供應商／Sourcer" },
  { key: "rereview", label: "補件後複審：供應商補件完，QA／RD 審完", from: "自供應商補件日", who: "QA／RD" },
];

export interface Part {
  id: string;
  project_id: string;
  fg_pn: string;
  fg_model: string;
  fg_desc: string;
  main_pn: string;
  part_pn: string;
  lifecycle: string;
  part_desc: string;
  part_type: string; // "" | PartType
  supplier: string;
  pa_start: string | null; // K
  supplier_notified: string | null; // L
  docs_received: string | null; // M
  rd_review_start: string | null;
  qa_review_start: string | null;
  rd_pass: string | null; // N
  qa_pass: string | null; // O
  /** 流程圖最後一步:Sourcer 把「零件承認」資料上傳 PLM 送簽 */
  plm_upload: string | null;
  /** PLM 簽核完成(Part Approved / Released)＝這顆料真正做完 */
  plm_released: string | null;
  /** 卡關原因(手選):"" | HoldReason。日期推不出來的兩種狀況靠它 */
  hold_reason: string;
  /** PLM 開 PA 日:跟收到首件日一樣,使用者說用不到,已從 FIELDS 拿掉;資料庫欄位還在 */
  plm_pa_start: string | null; // P
  /** 收到首件日:使用者說用不到,已從 FIELDS 拿掉(不顯示、不匯入、不匯出);
   *  資料庫那一欄還在,舊資料沒有被刪 */
  first_article: string | null; // Q
  /** 這顆料由哪一位 Sourcer 在跟（profiles.id；空字串＝沒指定，全專案的 Sourcer 一起負責） */
  sourcer_owner: string;
  /** 這顆料由哪一位 RD 在跟（同上；指定之後 RD 那一階的提醒只給他） */
  rd_owner: string;
  /** 已預約給「被邀請、還沒建好帳號」的 RD(算有 RD owner;由 parts.ts 帶入,不是資料庫欄位) */
  rd_owner_pending?: boolean;
  /** 承認樣品收到日（Sourcer／採購填） */
  sample_received: string | null;
  /** 供應商最近一次更新（補）資料的日期,Sourcer 回填。有退件時等於「供應商已送回」,
   *  QA/RD 的 review pass 期限從這天重新算(天數用 sla.rereview) */
  supplier_updated: string | null;
  /** 上面那個日期是什麼時候填的(時間戳):同一天內判斷「更新」與「退件」誰先誰後 */
  supplier_updated_at?: string | null;
  /** 圖面 Release 日（RD 填） */
  drawing_release: string | null;
  removed_from_bom: number;
  /** 不列入 PA 追蹤：母階組件（匯入時自動判斷）或人工排除 */
  excluded: number;
  excluded_note: string;
  // 只有 PLM BOM PDF 匯入才有的欄位
  bom_level: string;
  parent_pn: string;
  find_num: string;
  alt_of_pn: string;
  qty: string;
  ref_des: string;
  sort_order: number;
  updated_at: string;
}

/** 進度紀錄：誰在哪一天寫了一行「現在到哪了」。
 *  對應原本 Excel 的 remark 欄（1/19 廠商提供、4/13 已審，廠商修正中…），
 *  只是拆成一筆一條，才知道最後一次更新是什麼時候。 */
export interface Note {
  id: string;
  part_id: string;
  date: string;
  text: string;
  created_by: string;
  created_at: string;
}

export interface Issue {
  id: string;
  part_id: string;
  dept: "RD" | "QA";
  date: string;
  /** 供應商哪一天送回更新的資料；空白＝還在等供應商（流程圖的 Push supplier and get improved document） */
  resubmitted: string | null;
  note: string;
  created_by: string;
  created_at: string;
}

// ---------- 欄位 ----------

export type FieldKind = "text" | "date" | "type" | "user" | "hold";

export interface FieldDef {
  key: keyof Part;
  label: string;
  kind: FieldKind;
  /** 誰可以改。BOM 欄位（空陣列）只能靠匯入。admin 一律可以改。 */
  editors: Role[];
  /** Excel 表頭關鍵字，匯入時比對用（去掉空白換行、不分大小寫，全部包含才算） */
  headers: string[][];
  /** 只接受表頭完全等於關鍵字（例如「供應商」不能配到「Sourcer 通知供應商日期」） */
  exact?: boolean;
}

export const FIELDS: FieldDef[] = [
  { key: "fg_pn", label: "成品料號", kind: "text", editors: [], headers: [["成品料號"]] },
  { key: "fg_model", label: "成品機種", kind: "text", editors: [], headers: [["成品機種"], ["model"]], exact: true },
  { key: "fg_desc", label: "成品機種材料品名", kind: "text", editors: [], headers: [["成品機種材料品名"]] },
  { key: "main_pn", label: "主料料號", kind: "text", editors: [], headers: [["主料料號"]] },
  { key: "part_pn", label: "材料料號", kind: "text", editors: [], headers: [["材料料號"]] },
  { key: "lifecycle", label: "LIFECYCLE", kind: "text", editors: [], headers: [["lifecycle"]] },
  { key: "part_desc", label: "材料品名", kind: "text", editors: [], headers: [["材料品名"], ["description"]], exact: true },
  { key: "part_type", label: "屬性", kind: "type", editors: ["pm", "rd"], headers: [["屬性"]] },
  { key: "supplier", label: "供應商", kind: "text", editors: ["sourcer"], headers: [["供應商"], ["supplier"]], exact: true },
  { key: "sourcer_owner", label: "Sourcer owner", kind: "user", editors: ["pm", "sourcer", "rd", "qa"], headers: [["sourcerowner"], ["sourcer", "owner"]] },
  { key: "rd_owner", label: "RD owner", kind: "user", editors: ["pm", "sourcer", "rd", "qa"], headers: [["rdowner"], ["rd", "owner"]] },
  { key: "pa_start", label: "PM/RD 發起 PA", kind: "date", editors: ["pm", "rd"], headers: [["發起"]] },
  { key: "supplier_notified", label: "Sourcer 通知供應商", kind: "date", editors: ["sourcer"], headers: [["sourcer", "通知供應商"]] },
  { key: "docs_received", label: "收齊資料通知 QA", kind: "date", editors: ["sourcer"], headers: [["通知rd/qa"], ["通知qa"]] },
  { key: "rd_review_start", label: "RD 開始 review", kind: "date", editors: ["rd"], headers: [["rd", "reviewstart"]] },
  { key: "rd_pass", label: "RD review pass", kind: "date", editors: ["rd"], headers: [["rdreview", "pass"]] },
  { key: "qa_review_start", label: "QA 開始 review", kind: "date", editors: ["qa"], headers: [["qa", "reviewstart"]] },
  { key: "qa_pass", label: "QA review pass", kind: "date", editors: ["qa"], headers: [["qareview", "pass"]] },
  { key: "sample_received", label: "承認樣品", kind: "date", editors: ["sourcer"], headers: [["承認樣品"]] },
  { key: "supplier_updated", label: "供應商更新資料日期", kind: "date", editors: ["sourcer"], headers: [["供應商更新"], ["廠商更新"]] },
  { key: "drawing_release", label: "圖面 Release", kind: "date", editors: ["rd"], headers: [["圖面release"], ["圖面", "release"]] },
  { key: "plm_upload", label: "上傳 PLM 送簽", kind: "date", editors: ["sourcer"], headers: [["上傳plm"], ["plm", "送簽"]] },
  { key: "plm_released", label: "PLM Released", kind: "date", editors: ["sourcer"], headers: [["plmreleased"], ["plm", "released"]] },
  { key: "hold_reason", label: "卡關原因", kind: "hold", editors: ["pm", "rd"], headers: [["卡關原因"]] },
  // BOM PDF 帶進來的結構資訊，沒有人能手改，headers 留空所以 Excel 匯入不會對到
  { key: "bom_level", label: "BOM 階層", kind: "text", editors: [], headers: [] },
  { key: "parent_pn", label: "上一階料號", kind: "text", editors: [], headers: [] },
  { key: "find_num", label: "Find Num", kind: "text", editors: [], headers: [] },
  { key: "alt_of_pn", label: "替代料（替代誰）", kind: "text", editors: [], headers: [] },
  { key: "qty", label: "用量", kind: "text", editors: [], headers: [] },
  { key: "ref_des", label: "Ref Des（位置）", kind: "text", editors: [], headers: [] },
];

/** kind: "user" 的欄位可以指定給哪個角色的成員 */
export const OWNER_ROLE: Record<string, Role> = { sourcer_owner: "sourcer", rd_owner: "rd" };

/** 某個角色的事要通知誰:這顆料指定了那個角色的負責人(Sourcer owner／RD owner),
 *  而且他還是這個角色的成員,就只給他;否則整組一起。每日信與即時通知共用這條規則。 */
export function routeTo<M extends { user_id: string; role: string }>(
  role: Role, part: Pick<Part, "sourcer_owner" | "rd_owner">, members: M[]
): M[] {
  const all = members.filter((m) => m.role === role);
  const key = (Object.keys(OWNER_ROLE) as (keyof typeof OWNER_ROLE)[]).find((k) => OWNER_ROLE[k] === role);
  const owner = key ? (part as Record<string, string>)[key] : "";
  if (!owner) return all;
  const picked = all.filter((m) => m.user_id === owner);
  return picked.length ? picked : all;
}

/** 退件紀錄「供應商已更新」那一格誰能填:Sourcer(他去催供應商、收到資料)和退件的那個部門 */
export const RESUBMIT_EDITORS: Record<Issue["dept"], Role[]> = { RD: ["sourcer", "rd"], QA: ["sourcer", "qa"] };

export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map((f) => [f.key, f])) as Record<string, FieldDef>;

/** 退件紀錄（取代 Excel 的 R/S 欄）：RD 退件只有 RD 能記，QA 同理。 */
export const ISSUE_EDITOR: Record<Issue["dept"], Role> = { RD: "rd", QA: "qa" };

export function canEditField(key: string, roles: Role[], isAdmin: boolean): boolean {
  const f = FIELD_BY_KEY[key];
  if (!f) return false;
  if (isAdmin) return true;
  return f.editors.some((r) => roles.includes(r));
}

// ---------- 日期 ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s: unknown): s is string => typeof s === "string" && DATE_RE.test(s) && !Number.isNaN(Date.parse(s));

/** b − a 的天數（日曆天，與 Excel 相同，不扣假日）。 */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** 某時區的今天，YYYY-MM-DD。 */
export function todayIn(timeZone = "Asia/Taipei", at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

// ---------- SLA 階段 ----------

export type StageKey = "supplier_notified" | "docs_received" | "rd_pass" | "qa_pass";

export interface Stage {
  key: StageKey;
  from: keyof Part;
  owner: Role;
  label: string;
}

export const STAGES: Stage[] = [
  { key: "supplier_notified", from: "pa_start", owner: "sourcer", label: "通知供應商" },
  { key: "docs_received", from: "supplier_notified", owner: "sourcer", label: "收齊資料" },
  { key: "qa_pass", from: "docs_received", owner: "qa", label: "QA pass" },
  // RD 在 QA pass 之後才審(2026-10-13 流程修改),期限從 QA pass 起算,見 stageStart()
  { key: "rd_pass", from: "qa_pass", owner: "rd", label: "RD pass" },
];

/** 這一階的起算日。RD 從 QA pass 起算;舊資料若 RD 比 QA 早 pass(當時是並行審),
 *  就沿用收齊資料當起點,免得被判成「完成日早於起算日」。 */
/** 這顆料要不要 RD 審。沒有指定 RD owner(也沒預約)、RD 也沒動過(沒開始審、沒 pass、沒退件),
 *  就當 RD 不用參與:QA review pass 之後直接進「可上PLM」,不再等 RD。
 *  之後才指定 RD owner,就變回需要 RD 審。 */
export function rdNeeded(part: Part, issues: IssueLite[] = []): boolean {
  return (
    Boolean(part.rd_owner) ||
    Boolean(part.rd_owner_pending) ||
    isDate(part.rd_review_start) ||
    isDate(part.rd_pass) ||
    issues.some((i) => i.dept === "RD")
  );
}

export function stageStart(part: Part, stage: Stage, issues: IssueLite[] = []): string | null {
  // 不用 RD 審的料,RD pass 這一階不存在:沒有起算日、不會逾期
  if (stage.key === "rd_pass" && !rdNeeded(part, issues)) return null;
  let base: string | null;
  if (stage.key === "rd_pass") {
    const qa = part.qa_pass;
    const rd = part.rd_pass;
    base = isDate(qa) && (!isDate(rd) || rd >= qa) ? qa : isDate(rd) ? part.docs_received : null;
  } else {
    base = part[stage.from] as string | null;
  }
  if (!isDate(base)) return base;
  // 退件之後還在等供應商補件 → 這段時間不算 QA/RD 的逾期(球在供應商手上,看「供應商更新資料」那欄)
  const dept = reviewDept(stage);
  if (dept && pendingResubmit(part, issues, dept)) return null;
  // 補件之後,review pass 的期限從「供應商更新資料」那天重新算
  return resubmitStart(part, stage, issues, base) ?? base;
}

function reviewDept(stage: Stage): Issue["dept"] | null {
  return stage.key === "rd_pass" ? "RD" : stage.key === "qa_pass" ? "QA" : null;
}

/** 供應商補件的日期(= 這一階重新起算的日子);沒有補件、或補件日比 pass 日還晚的舊資料 → null */
/** 某部門最後一筆退件之後,供應商把資料送回來的日期(沒有 → null)。算作送回的有:
 *  退件紀錄上的「供應商已更新」、舊資料「退件後 RD/QA 重新開始 review」、Sourcer 回填的
 *  「供應商更新資料日期」、以及退件之後又填了「收齊資料」(= 資料重新收齊、再通知 QA)。取最晚的。 */
function resubmittedOn(part: Part, last: IssueLite, dept: Issue["dept"]): string | null {
  const restart = dept === "RD" ? part.rd_review_start : part.qa_review_start;
  const c: string[] = [];
  if (isDate(last.resubmitted)) c.push(last.resubmitted);
  else if (isDate(restart) && restart > last.date) c.push(restart);
  if (isDate(part.supplier_updated)) {
    // 更新日在退件日之後才算;同一天的話,要看是誰後記的:更新比退件晚填才算送回,
    // 退件是更新之後才記的(例如先填「廠商更新」、之後 QA 看了又退件)就還在等供應商
    const su = part.supplier_updated;
    const sameDayAfter = su === last.date && Boolean(part.supplier_updated_at) && Boolean(last.created_at) && part.supplier_updated_at! > last.created_at!;
    if (su > last.date || sameDayAfter) c.push(su);
  }
  if (isDate(part.docs_received) && part.docs_received > last.date) c.push(part.docs_received);
  return c.sort().pop() ?? null;
}

function resubmitStart(part: Part, stage: Stage, issues: IssueLite[], base: string): string | null {
  const dept = reviewDept(stage);
  if (!dept) return null;
  let last: IssueLite | null = null;
  for (const i of issues) if (i.dept === dept && (!last || i.date >= last.date)) last = i;
  // 沒有退件紀錄時,Sourcer 回填的「供應商更新資料日期」也算(E3 這類退件只寫在 remark 的料)
  const back = last ? resubmittedOn(part, last, dept) : isDate(part.supplier_updated) ? part.supplier_updated : null;
  if (!back || back <= base) return null;
  const done = part[stage.key];
  if (isDate(done) && done < back) return null;
  return back;
}

/** 這一階實際用的 SLA 天數。QA/RD 在供應商補件之後,期限是「補件後複審」的天數(sla.rereview),
 *  不是原本的 review pass 天數;其餘照 slaDays。 */
export function stageDays(part: Part, stage: Stage, sla: Sla, issues: IssueLite[] = []): number | null {
  const start = stageStart(part, stage, issues);
  if (isDate(start) && resubmitStart(part, stage, issues, "0000-00-00") === start) {
    return Number.isFinite(sla.rereview) ? sla.rereview : DEFAULT_SLA.rereview;
  }
  return slaDays(stage.key, part, sla);
}

/** RD/QA pass 那兩階對應的「開始 review」欄 */
export const REVIEW_START: Partial<Record<StageKey, keyof Part>> = { rd_pass: "rd_review_start", qa_pass: "qa_review_start" };
export const STAGE_OF_START: Partial<Record<keyof Part, StageKey>> = { rd_review_start: "rd_pass", qa_review_start: "qa_pass" };

/** 這一階的燈號／倒數要顯示在哪一欄(畫面與匯出共用)。
 *  RD/QA 還沒開始 review 時掛在「開始 review」那格——卡住的是「還沒開始」,不是「還沒 pass」;
 *  開始了(或已經 pass)才回到 pass 那格。期限本身不變,一樣從收齊資料起算。
 *  startShown=false(那一欄被收起來)就照舊顯示在 pass 那格,免得紅燈整個看不到。 */
export function slaColumn(part: Part, stage: StageKey, startShown = true): keyof Part {
  const start = REVIEW_START[stage];
  if (start && startShown && !isDate(part[stage] as string | null) && !isDate(part[start] as string | null)) return start;
  return stage;
}

export function slaDays(stage: StageKey, part: Pick<Part, "part_type">, sla: Sla): number | null {
  switch (stage) {
    case "supplier_notified":
      return sla.supplier_notified;
    case "docs_received":
      return part.part_type === "標準件" ? sla.docs_std : part.part_type === "訂製件" ? sla.docs_custom : null;
    case "rd_pass":
      return sla.rd_pass;
    case "qa_pass":
      return sla.qa_pass;
  }
}

export type Light = "red" | "yellow" | null;

export interface StageEval {
  light: Light;
  /** 紅燈：已逾期幾天；黃燈：超出 SLA 幾天 */
  overBy: number;
  /** 還剩幾天到期（只有進行中、還沒逾期時有值） */
  dueIn: number | null;
  /** 完成日早於起算日 */
  orderError: boolean;
}

export function evalStage(part: Part, stage: Stage, sla: Sla, today: string, issues: IssueLite[] = []): StageEval {
  const none: StageEval = { light: null, overBy: 0, dueIn: null, orderError: false };
  const from = stageStart(part, stage, issues);
  if (!isDate(from)) return none;
  const days = stageDays(part, stage, sla, issues);
  if (days === null) return none;
  const done = part[stage.key];
  if (isDate(done)) {
    const took = daysBetween(from, done);
    const orderError = took < 0;
    const over = Math.abs(took) - days;
    return { light: over > 0 ? "yellow" : null, overBy: Math.max(0, over), dueIn: null, orderError };
  }
  const elapsed = daysBetween(from, today);
  const over = elapsed - days;
  if (over > 0) return { light: "red", overBy: over, dueIn: null, orderError: false };
  return { ...none, dueIn: -over };
}

/** 判斷紅黃燈與階段要用到的退件資料 */
export type IssueLite = Pick<Issue, "dept" | "date"> & { resubmitted?: string | null; created_at?: string };

/** 退件後等供應商送回更新資料的那一段(每個部門各算各的,取最緊的那個) */
export interface SupplierUpdateEval extends StageEval {
  /** 等的是哪個部門的退件;沒有在等就是 null */
  dept: Issue["dept"] | null;
  /** 從哪一天(退件日)起算 */
  from: string | null;
}

/** 某部門最後一筆退件,還沒 pass、供應商也還沒送回更新 → 正在等供應商 */
export function pendingResubmit(part: Part, issues: IssueLite[], dept: Issue["dept"]): IssueLite | null {
  if (isDate(dept === "RD" ? part.rd_pass : part.qa_pass)) return null;
  let last: IssueLite | null = null;
  for (const i of issues) if (i.dept === dept && (!last || i.date >= last.date)) last = i;
  if (!last || resubmittedOn(part, last, dept)) return null;
  return last;
}

/** only 指定就只看那個部門(追蹤表 QA、RD 各一欄);不指定 = 兩個部門取最緊的 */
export function evalSupplierUpdate(
  part: Part, issues: IssueLite[], sla: Sla, today: string, only?: Issue["dept"]
): SupplierUpdateEval {
  let worst: SupplierUpdateEval = { light: null, overBy: 0, dueIn: null, orderError: false, dept: null, from: null };
  for (const dept of (only ? [only] : ["QA", "RD"]) as Issue["dept"][]) {
    const i = pendingResubmit(part, issues, dept);
    if (!i) continue;
    const days = Number.isFinite(sla.supplier_update) ? sla.supplier_update : DEFAULT_SLA.supplier_update;
    const over = daysBetween(i.date, today) - days;
    const e: SupplierUpdateEval =
      over > 0
        ? { light: "red", overBy: over, dueIn: null, orderError: false, dept, from: i.date }
        : { light: null, overBy: 0, dueIn: -over, orderError: false, dept, from: i.date };
    // 紅燈優先,其次剩下天數最少的
    if (!worst.dept || (e.light === "red" && (worst.light !== "red" || e.overBy > worst.overBy)) ||
        (!e.light && !worst.light && (e.dueIn ?? 0) < (worst.dueIn ?? 0))) worst = e;
  }
  return worst;
}

/** 供應商補件完之後,QA/RD 複審的那一段(sla.rereview);補件日 = 退件紀錄的「供應商已更新」,
 *  舊資料沒填的話用「退件之後重新開始 review」那天。審完(pass)或又被退件就結束。 */
export function evalRereview(
  part: Part, issues: IssueLite[], sla: Sla, today: string, only?: Issue["dept"]
): SupplierUpdateEval {
  let worst: SupplierUpdateEval = { light: null, overBy: 0, dueIn: null, orderError: false, dept: null, from: null };
  const days = Number.isFinite(sla.rereview) ? sla.rereview : DEFAULT_SLA.rereview;
  // 已送 PLM、已完成、不追蹤、卡在圖面進版的料,審核早就結束了,不會還在等複審
  if (part.excluded || isDate(part.plm_upload) || isDate(part.plm_released) || part.hold_reason === "待RD圖面進版") return worst;
  for (const dept of (only ? [only] : ["QA", "RD"]) as Issue["dept"][]) {
    if (isDate(dept === "RD" ? part.rd_pass : part.qa_pass)) continue;
    if (dept === "RD" && !rdNeeded(part, issues)) continue;
    let last: IssueLite | null = null;
    for (const i of issues) if (i.dept === dept && (!last || i.date >= last.date)) last = i;
    if (!last || pendingResubmit(part, issues, dept)) continue;
    const from = resubmittedOn(part, last, dept);
    if (!from) continue;
    const over = daysBetween(from, today) - days;
    const e: SupplierUpdateEval =
      over > 0
        ? { light: "red", overBy: over, dueIn: null, orderError: false, dept, from }
        : { light: null, overBy: 0, dueIn: -over, orderError: false, dept, from };
    if (!worst.dept || (e.light === "red" && (worst.light !== "red" || e.overBy > worst.overBy)) ||
        (!e.light && !worst.light && (e.dueIn ?? 0) < (worst.dueIn ?? 0))) worst = e;
  }
  return worst;
}

export type PartEval = Record<StageKey, StageEval> & {
  /** 供應商補件後等 QA/RD 複審(sla.rereview);沒有在複審就是 dept=null */
  rereview: SupplierUpdateEval;
  rereview_qa: SupplierUpdateEval;
  rereview_rd: SupplierUpdateEval;
  /** 退件後等供應商送回更新資料(有自己的 SLA:sla.supplier_update) */
  supplier_update: SupplierUpdateEval;
  /** 同上,但分部門各算各的(追蹤表「供應商更新資料」QA、RD 兩欄) */
  supplier_update_qa: SupplierUpdateEval;
  supplier_update_rd: SupplierUpdateEval;
  status: string;
  approved: boolean;
  missingType: boolean;
  red: number;
  /** 目前輪到哪些角色動作 */
  waitingOn: Role[];
  /** 這顆料現在在哪個階段(Dashboard 那張表) */
  phase: PhaseKey;
  /** 退件已達 ESCALATE_AT 次、而且還沒 pass 的部門:流程圖的「Escalate for help if >= 4」 */
  escalated: Issue["dept"][];
};

// ---------- 階段(Dashboard) ----------
// 對應原本手工維護的那張階段統計表。除了「卡關原因」兩種要人判斷,其餘全部由日期推出來,
// 所以不會有「表上說待 QA、其實 QA 早就 pass」的情形。

export type PhaseKey =
  | "done"
  | "plm_signing"
  | "plm_ready"
  | "hold_ec"
  | "review_rd"
  | "review_qa"
  | "rework_qa"
  | "rework_rd"
  | "supplier"
  | "to_notify"
  | "hold_issue"
  | "not_started"
  | "na";

export interface PhaseDef {
  key: PhaseKey;
  label: string;
  /** 負責單位(顯示用) */
  owner: string;
  desc: string;
  tone?: "good" | "bad" | "muted";
}

/** 照流程順序(2026-10-13 使用者要求):最上面未發起、往下走到已完成。
 *  Dashboard 的表格與比例條、表格依階段排序、匯出的階段統計都照這個順序。
 *  「不需PA」不在流程裡,放最後(畫面上用分隔線隔開)。 */
export const PHASES: PhaseDef[] = [
  { key: "not_started", label: "未發起", owner: "PM、RD", desc: "還沒發起 PA" },
  { key: "to_notify", label: "待通知廠商", owner: "Sourcer", desc: "已發起 PA，Sourcer 還沒通知供應商" },
  { key: "supplier", label: "廠商準備資料", owner: "Sourcer", desc: "廠商準備文件中（已通知、還沒收齊）" },
  { key: "hold_issue", label: "ISSUE", owner: "RD、PM", desc: HOLD_HINT.ISSUE, tone: "bad" },
  { key: "review_qa", label: "待QA審核", owner: "QA", desc: "廠商已提供文件，待 QA 審核（QA 先審）" },
  { key: "rework_qa", label: "廠商資料更新", owner: "QA", desc: "被 QA 退件，廠商更新資料中（QA 追蹤，補件後 QA 複審）" },
  { key: "review_rd", label: "待RD審核", owner: "RD", desc: "QA 已 pass，待 RD 審核（QA 審完才換 RD）" },
  { key: "rework_rd", label: "廠商資料更新（RD）", owner: "RD", desc: "被 RD 退件，廠商更新資料中（RD 追蹤，補件後 RD 複審）" },
  { key: "hold_ec", label: "待RD圖面進版", owner: "RD", desc: HOLD_HINT["待RD圖面進版"] },
  { key: "plm_ready", label: "可上PLM", owner: "Sourcer", desc: "QA、RD 皆 pass（沒有 RD owner 的料只看 QA pass），待上傳 PLM" },
  { key: "plm_signing", label: "PLM簽核", owner: "Sourcer", desc: "已上傳 PLM，簽核中" },
  { key: "done", label: "已完成", owner: "—", desc: "PLM Released（Part Approved）", tone: "good" },
  { key: "na", label: "不需PA", owner: "RD、PM", desc: "不追蹤（母階組件、預計移除 BOM / EOL / F/W）", tone: "muted" },
];
export const PHASE_BY_KEY = Object.fromEntries(PHASES.map((p) => [p.key, p])) as Record<PhaseKey, PhaseDef>;

/** 退件幾次要往上報(流程圖:Escalate for help if >= 4) */
export const ESCALATE_AT = 4;

/** 某部門是不是「退回廠商修正中」:最後一筆退件還沒 pass、供應商也還沒送回更新的資料。
 *  在退件紀錄填上「供應商已更新」日期(或 RD/QA 在退件之後重新開始 review),就算回到待審。 */
function inRework(part: Part, issues: IssueLite[], dept: Issue["dept"]): boolean {
  return pendingResubmit(part, issues, dept) !== null;
}

export function derivePhase(part: Part, issues: IssueLite[]): PhaseKey {
  if (part.excluded) return "na";
  if (isDate(part.plm_released)) return "done";
  if (part.hold_reason === "ISSUE") return "hold_issue";
  if (part.hold_reason === "待RD圖面進版") return "hold_ec";
  if (isDate(part.plm_upload)) return "plm_signing";
  const rdOk = isDate(part.rd_pass);
  const qaOk = isDate(part.qa_pass);
  // QA pass 了,而且 RD 也 pass 了、或這顆料不用 RD 審(沒有 RD owner)→ 可上 PLM
  if (qaOk && (rdOk || !rdNeeded(part, issues))) return "plm_ready";
  // 被退件、等廠商補件:負責追蹤的是退件的那個部門(QA／RD),不是 Sourcer。
  // 流程是 QA 先審、QA pass 之後才換 RD。有退件就代表資料收過了,就算「收齊資料」那格沒填也一樣
  if (!qaOk && inRework(part, issues, "QA")) return "rework_qa";
  if (qaOk && !rdOk && inRework(part, issues, "RD")) return "rework_rd";
  if (isDate(part.docs_received)) return !qaOk ? "review_qa" : "review_rd";
  if (isDate(part.supplier_notified)) return "supplier";
  if (isDate(part.pa_start)) return "to_notify";
  return "not_started";
}

export function escalatedDepts(part: Part, issues: IssueLite[]): Issue["dept"][] {
  return (["RD", "QA"] as const).filter(
    (d) => !isDate(d === "RD" ? part.rd_pass : part.qa_pass) && issues.filter((i) => i.dept === d).length >= ESCALATE_AT
  );
}

// ---------- 狀態 ----------
// 原本 Excel 的 Status 是手選的下拉，常跟日期對不上（還有 RD/Q、RD/QA 兩種拼法）。
// 改成推導：取「最近發生的那個事件」，同一天以流程順序較後者為準。

export const STATUS_NOT_STARTED = "Not started";
export const STATUS_LIST = [
  STATUS_NOT_STARTED,
  "PM/RD informed Sourcer to Start PA",
  "Sourcer requested Supplier to provide doc./material",
  "Sourcer informed RD/QA that 1st doc/material received",
  "RD informed review started",
  "QA informed review started",
  "RD informed Supplier to improve",
  "QA informed Supplier to improve",
  "RD review : Pass",
  "QA review : Pass",
  "Uploaded to PLM for approval",
  "PLM Released",
];

export function deriveStatus(part: Part, issues: IssueLite[]): string {
  const events: [string | null, number][] = [
    [part.pa_start, 1],
    [part.supplier_notified, 2],
    [part.docs_received, 3],
    [part.rd_review_start, 4],
    [part.qa_review_start, 5],
    [part.rd_pass, 8],
    [part.qa_pass, 9],
    [part.plm_upload, 10],
    [part.plm_released, 11],
  ];
  for (const i of issues) events.push([i.date, i.dept === "RD" ? 6 : 7]);
  let best: [string, number] | null = null;
  for (const [d, idx] of events) {
    if (!isDate(d)) continue;
    if (!best || d > best[0] || (d === best[0] && idx > best[1])) best = [d, idx];
  }
  return STATUS_LIST[best ? best[1] : 0];
}

export function evalPart(part: Part, issues: IssueLite[], sla: Sla, today: string): PartEval {
  const out = {} as PartEval;
  let red = 0;
  for (const s of STAGES) {
    const e = evalStage(part, s, sla, today, issues);
    out[s.key] = e;
    if (e.light === "red") red++;
  }
  const waitingOn = new Set<Role>();
  if (!isDate(part.pa_start)) waitingOn.add("pm");
  for (const s of STAGES) {
    if (isDate(stageStart(part, s, issues)) && !isDate(part[s.key])) waitingOn.add(s.owner);
  }
  // 還沒填屬性，收齊資料那一步算不出期限——要請 PM/RD 補
  const missingType = !part.part_type && isDate(part.supplier_notified);
  if (missingType) waitingOn.add("pm");
  const approved = isDate(part.qa_pass) && (isDate(part.rd_pass) || !rdNeeded(part, issues));
  // PLM 那一段沒有 SLA,但一樣算「輪到 Sourcer」
  if (approved && !isDate(part.plm_released)) waitingOn.add("sourcer");
  if (part.hold_reason === "ISSUE") { waitingOn.add("pm"); waitingOn.add("rd"); }
  if (part.hold_reason === "待RD圖面進版") waitingOn.add("rd");
  const escalated = escalatedDepts(part, issues);
  if (escalated.length) waitingOn.add("pm");
  // 退件後等供應商送回更新資料:Sourcer 要去催
  const su = evalSupplierUpdate(part, issues, sla, today);
  out.supplier_update = su;
  out.supplier_update_qa = evalSupplierUpdate(part, issues, sla, today, "QA");
  out.supplier_update_rd = evalSupplierUpdate(part, issues, sla, today, "RD");
  // 補件後複審:輪到審的那個部門要動作;超過天數算逾期
  const rr = evalRereview(part, issues, sla, today);
  out.rereview = rr;
  out.rereview_qa = evalRereview(part, issues, sla, today, "QA");
  out.rereview_rd = evalRereview(part, issues, sla, today, "RD");
  if (rr.dept) waitingOn.add(rr.dept === "QA" ? "qa" : "rd");
  if (su.dept) {
    waitingOn.add("sourcer"); // 去催供應商、回填補件日
    waitingOn.add(su.dept === "QA" ? "qa" : "rd"); // 退件的部門也要盯著(階段表的負責單位)
  }
  if (su.light === "red") red++;
  out.status = deriveStatus(part, issues);
  out.approved = approved;
  out.missingType = missingType;
  out.red = red;
  out.waitingOn = [...waitingOn];
  out.phase = derivePhase(part, issues);
  out.escalated = escalated;
  return out;
}
