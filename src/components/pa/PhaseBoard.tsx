"use client";

// 專案卡片裡的階段統計:對應原本手工維護的「階段／料件數／佔比／負責單位／說明」那張表,
// 只是數字由日期推出來(lib/pa.ts 的 derivePhase、server/pa/parts.ts 的 projectStats),
// 不用再有人每週數一次。點一列 = 進到那個專案、只看那個階段。

import Link from "next/link";
import { Fragment } from "react";
import { PHASES, type PhaseKey } from "@/lib/pa";

export default function PhaseBoard({
  projectId, counts, total, reworkQa, issues,
}: {
  projectId: string;
  /** ISSUE 階段的料:列在那一列正下面(料號、原因、負責人、日期) */
  issues?: { part_pn: string; part_desc: string; reason: string; owner: string; since: string | null }[];
  /** 「廠商資料更新」各被 QA 退件幾次的料數,顯示在那一列正下面 */
  reworkQa?: Record<number, number>;
  counts: Partial<Record<PhaseKey, number>>;
  /** 含不追蹤(不需PA)、不含已不在 BOM —— 跟原本那張表一樣 */
  total: number;
}) {
  if (!total) return null;
  // 不需PA 不在流程裡:不算進百分比的分母,比例條也不畫它;料件數照常列出來
  const na = counts.na ?? 0;
  const base = total - na;
  const pct = (n: number) => (base > 0 ? `${((n / base) * 100).toFixed(1)}%` : "—");
  const href = (k: PhaseKey) => `/pa/p/${projectId}?phase=${k}`;

  return (
    <div className="phaseboard">
      {/* 比例條:每一段就是一個階段,點了一樣會跳過去 */}
      <div className="pb-bar">
        {PHASES.map((ph) => {
          const n = counts[ph.key] ?? 0;
          if (!n || ph.key === "na") return null;
          return (
            <Link
              key={ph.key}
              href={href(ph.key)}
              className={`pb-seg ph-${ph.key}`}
              style={{ flexGrow: n }}
              title={`${ph.label}：${n}（${pct(n)}）`}
              aria-label={`${ph.label} ${n} 顆`}
            />
          );
        })}
      </div>
      <table className="pb-table">
        <thead>
          <tr>
            <th>階段</th>
            <th className="num">料件數</th>
            <th className="num">佔比</th>
            <th>負責單位</th>
            <th>說明</th>
          </tr>
        </thead>
        <tbody>
          {PHASES.map((ph) => {
            const n = counts[ph.key] ?? 0;
            // 整列可點:第一格的連結用 CSS 把點擊範圍撐滿整列
            return (
              <Fragment key={ph.key}>
              {/* 不需PA 不在流程裡:用一條分隔列跟上面的流程階段隔開 */}
              {ph.key === "na" && (
                <tr className="pb-sep">
                  <td colSpan={5}>流程外</td>
                </tr>
              )}
              <tr className={n ? "" : "zero"}>
                <td>
                  {n ? (
                    <Link href={href(ph.key)} className="pb-rowlink" title="點一下進專案、只看這些">
                      <span className={`phase-chip ph-${ph.key}`}>{ph.label}</span>
                    </Link>
                  ) : (
                    <span className={`phase-chip ph-${ph.key}`}>{ph.label}</span>
                  )}
                </td>
                <td className="num mono">{n}</td>
                <td className="num mono">{ph.key === "na" ? "—" : pct(n)}</td>
                <td>{ph.owner}</td>
                <td className="desc" title={ph.desc}>{ph.desc}</td>
              </tr>
              {ph.key === "hold_issue" && n > 0 && issues && issues.length > 0 && (
                <tr className="pb-issues">
                  <td colSpan={5}>
                    <table className="pb-issuelist">
                      <thead>
                        <tr>
                          <th>料號</th>
                          <th>卡關原因</th>
                          <th>負責人</th>
                          <th>卡關日期</th>
                        </tr>
                      </thead>
                      <tbody>
                        {issues.map((it, i) => (
                          <tr key={i}>
                            <td className="mono" title={it.part_desc}>{it.part_pn}</td>
                            <td>{it.reason}</td>
                            <td>{it.owner || "（未指定）"}</td>
                            <td className="mono">{it.since ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
              {ph.key === "rework_qa" && n > 0 && reworkQa && Object.keys(reworkQa).length > 0 && (
                <tr className="pb-sub">
                  <td colSpan={5}>
                    被 QA 退件：
                    {Object.entries(reworkQa)
                      .sort((a, b) => Number(a[0]) - Number(b[0]))
                      .map(([times, cnt]) => (
                        <Link
                          key={times}
                          href={`${href("rework_qa")}&rej=${times}`}
                          className="pb-sub-item"
                          title={`看被 QA 退件 ${times} 次的 ${cnt} 顆`}
                        >
                          {times} 次 <b className="mono">{cnt}</b> 顆
                        </Link>
                      ))}
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td>合計</td>
            <td className="num mono">{base}</td>
            <td className="num mono">100%</td>
            <td colSpan={2} className="desc">{na ? `不含不需PA ${na} 顆` : ""}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
