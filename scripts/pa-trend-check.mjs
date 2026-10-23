// PA 進度趨勢(src/lib/paTrend.ts)的檢查,不需要資料庫:
//   npm run check:patrend
import { register } from "node:module";
register("./pa-alias-loader.mjs", import.meta.url);
const { buildTrend, addDays } = await import("../src/lib/paTrend.ts");
const { DEFAULT_SLA } = await import("../src/lib/pa.ts");

let failures = 0;
const ok = (label, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
};

const base = {
  project_id: "p", fg_pn: "", fg_model: "", fg_desc: "", main_pn: "M", part_pn: "", lifecycle: "", part_desc: "",
  part_type: "標準件", supplier: "", pa_start: null, supplier_notified: null, docs_received: null,
  rd_review_start: null, qa_review_start: null, rd_pass: null, qa_pass: null, plm_upload: null, plm_released: null,
  hold_reason: "", plm_pa_start: null, first_article: null, sourcer_owner: "", rd_owner: "", sample_received: null,
  drawing_release: null, removed_from_bom: 0, excluded: 0, excluded_note: "", bom_level: "", parent_pn: "",
  find_num: "", alt_of_pn: "", qty: "", ref_des: "", sort_order: 0, updated_at: "", issues: [],
};
const part = (pn, o = {}) => ({ ...base, part_pn: pn, ...o });

console.log("累計數");
const parts = [
  part("A", { pa_start: "2026-10-01", docs_received: "2026-10-05", rd_pass: "2026-10-08", qa_pass: "2026-10-09", plm_released: "2026-10-10" }),
  part("B", { pa_start: "2026-10-03" }),
  part("X", { pa_start: "2026-10-01", excluded: 1 }),
  part("Y", { pa_start: "2026-10-01", removed_from_bom: 1 }),
];
const t = buildTrend(parts, DEFAULT_SLA, "2026-09-30", "2026-10-12");
const at = (d) => t.days.find((x) => x.date === d);
ok("追蹤中不含不追蹤與已移出 BOM", t.total === 2, `total=${t.total}`);
ok("發起日之前是 0", at("2026-09-30").started === 0);
ok("10/03 累計發起 2", at("2026-10-03").started === 2);
ok("10/08 RD pass 1、QA pass 0", at("2026-10-08").rd_pass === 1 && at("2026-10-08").qa_pass === 0);
ok("10/10 起 Released 1", at("2026-10-09").released === 0 && at("2026-10-10").released === 1);
ok("累計數不會往下掉", t.days.every((d, i) => !i || d.started >= t.days[i - 1].started));

console.log("逾期回推");
// B 在 10/03 發起、一直沒通知供應商;SLA 3 天 → 10/06 還不算(>3),10/07 起紅
const tb = buildTrend([part("B", { pa_start: "2026-10-03" })], DEFAULT_SLA, "2026-10-04", "2026-10-12");
const od = (d) => tb.days.find((x) => x.date === d).overdue;
ok("期限內不算逾期", od("2026-10-06") === 0);
ok("超過 SLA 才算逾期", od("2026-10-07") === 1);
// 之後才補填的通知日,不能讓過去那天的紅燈消失
const tc = buildTrend([part("C", { pa_start: "2026-10-03", supplier_notified: "2026-10-11" })], DEFAULT_SLA, "2026-10-04", "2026-10-12");
ok("事後補填的日期不影響當天的逾期", tc.days.find((x) => x.date === "2026-10-08").overdue === 1);
ok("補填之後不再逾期", tc.days.find((x) => x.date === "2026-10-11").overdue === 0);
ok("已 Released 的料不算逾期", buildTrend([part("D", { pa_start: "2026-01-01", plm_released: "2026-02-01" })], DEFAULT_SLA, "2026-10-01", "2026-10-02").days.every((d) => d.overdue === 0));

console.log("日期運算");
ok("addDays 跨月", addDays("2026-10-31", 1) === "2026-11-01");
ok("addDays 往回", addDays("2026-03-01", -1) === "2026-02-28");
ok("區間含頭尾", t.days.length === 13);

console.log(failures ? `\n${failures} 項失敗` : "\n全部通過");
process.exit(failures ? 1 : 0);
