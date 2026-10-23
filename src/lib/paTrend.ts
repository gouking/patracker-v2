// 進度趨勢:用各欄日期「回推」每一天的狀態,不另外存快照。
//
// 里程碑日期(發起、收齊、RD/QA pass、Released)本身就是時間序列:某天的累計數＝日期 <= 那天的料數。
// 逾期數則是把「晚於那天」的日期與退件資料遮掉,再用 evalPart 在那一天重算一次紅燈。
// 取捨:SLA 用的是現在的設定;日期事後被改掉,過去的數字會跟著變(沒有每日快照)。
// 純函式、只 import 同層的 pa.ts,瀏覽器與 scripts 共用。

import { derivePhase, evalPart, isDate, type IssueLite, type Part, type PhaseKey, type Sla } from "./pa";

export interface TrendInput extends Part {
  issues: IssueLite[];
}

export interface TrendDay {
  date: string;
  /** 已發起 PA */
  started: number;
  /** 供應商資料收齊 */
  docs: number;
  rd_pass: number;
  qa_pass: number;
  /** PLM Released(真正做完) */
  released: number;
  /** 當天有紅燈的料數 */
  overdue: number;
  /** 退件累計次數(RD+QA) */
  rejects: number;
}

export interface Trend {
  /** 追蹤中的料數(不含不追蹤、已不在 BOM) */
  total: number;
  days: TrendDay[];
}

const DATE_KEYS = [
  "pa_start", "supplier_notified", "docs_received", "rd_review_start", "qa_review_start",
  "rd_pass", "qa_pass", "plm_upload", "plm_released", "sample_received", "drawing_release",
] as const satisfies readonly (keyof Part)[];

/** YYYY-MM-DD 加減天數(用 UTC 算,避開夏令時間)。 */
export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 把「晚於 day」的資料遮掉,等於那一天的樣子。 */
function asOf(p: TrendInput, day: string): { part: Part; issues: IssueLite[] } {
  const part: Part = { ...p };
  for (const k of DATE_KEYS) {
    const v = part[k];
    if (isDate(v) && v > day) (part as unknown as Record<string, unknown>)[k] = null;
  }
  const issues = p.issues
    .filter((i) => i.date <= day)
    .map((i) => (i.resubmitted && i.resubmitted > day ? { ...i, resubmitted: null } : i));
  return { part, issues };
}

const on = (v: string | null, day: string) => isDate(v) && v <= day;

/** 最早的里程碑日期(沒有任何日期回 null)。 */
export function earliestDate(parts: TrendInput[]): string | null {
  let min: string | null = null;
  for (const p of parts) {
    if (p.excluded || p.removed_from_bom) continue;
    if (isDate(p.pa_start) && (!min || p.pa_start < min)) min = p.pa_start;
  }
  return min;
}

export function buildTrend(parts: TrendInput[], sla: Sla, from: string, to: string): Trend {
  const tracked = parts.filter((p) => !p.excluded && !p.removed_from_bom);
  const days: TrendDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const row: TrendDay = { date: d, started: 0, docs: 0, rd_pass: 0, qa_pass: 0, released: 0, overdue: 0, rejects: 0 };
    for (const p of tracked) {
      if (on(p.pa_start, d)) row.started++;
      if (on(p.docs_received, d)) row.docs++;
      if (on(p.rd_pass, d)) row.rd_pass++;
      if (on(p.qa_pass, d)) row.qa_pass++;
      if (on(p.plm_released, d)) row.released++;
      for (const i of p.issues) if (i.date <= d) row.rejects++;
      // 還沒發起的料不會有紅燈,省掉遮罩與重算
      if (!on(p.pa_start, d)) continue;
      if (on(p.plm_released, d)) continue;
      const m = asOf(p, d);
      if (evalPart(m.part, m.issues, sla, d).red > 0) row.overdue++;
    }
    days.push(row);
  }
  return { total: tracked.length, days };
}

/** 每天各階段(Dashboard 那張表的分類)各有幾顆料 */
export interface PhaseDay {
  date: string;
  counts: Partial<Record<PhaseKey, number>>;
}

/** 用各欄日期回推每一天的階段分布(不含不追蹤的、已不在 BOM 的)。
 *  取捨:卡關原因(ISSUE／待RD圖面進版)沒有歷史紀錄,視為從發起日起就是現在的狀態
 *  (asOf 不會動它);日期事後被改,過去的數字會跟著變。 */
export function buildPhaseTrend(parts: TrendInput[], from: string, to: string): { total: number; days: PhaseDay[] } {
  const tracked = parts.filter((p) => !p.excluded && !p.removed_from_bom);
  const days: PhaseDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const counts: Partial<Record<PhaseKey, number>> = {};
    for (const p of tracked) {
      const m = asOf(p, d);
      if (!isDate(m.part.pa_start)) m.part.hold_reason = ""; // 還沒發起的料沒有卡關
      const ph = derivePhase(m.part, m.issues);
      counts[ph] = (counts[ph] ?? 0) + 1;
    }
    days.push({ date: d, counts });
  }
  return { total: tracked.length, days };
}
