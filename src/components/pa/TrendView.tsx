"use client";

import { useMemo, useState } from "react";
import { addDays, buildPhaseTrend, buildTrend, earliestDate, type PhaseDay, type TrendDay, type TrendInput } from "@/lib/paTrend";
import { PHASES, type PhaseKey, type Sla } from "@/lib/pa";
import { isTwWorkday } from "@/lib/twCalendar";

type SeriesKey = Exclude<keyof TrendDay, "date">;

const SERIES: { key: SeriesKey; label: string; color: string; dash?: string }[] = [
  { key: "started", label: "已發起", color: "#8a8f98" },
  { key: "docs", label: "資料收齊", color: "#2f6fb0" },
  { key: "qa_pass", label: "QA pass", color: "#7a5bc4" },
  { key: "rd_pass", label: "RD pass", color: "#d98a1c" },
  { key: "released", label: "PLM Released", color: "#2e9e5b" },
  { key: "overdue", label: "逾期料數", color: "#d6452f", dash: "5 3" },
];

/** 依階段看:由下往上照流程順序疊起來(不含不需PA)。顏色跟階段表的標籤大致對應 */
const PHASE_SERIES = PHASES.filter((p) => p.key !== "na").map((p) => ({
  key: p.key,
  label: p.label,
  color: ({
    not_started: "#c9ccd1", to_notify: "#a8adb6", supplier: "#8a8f98", hold_issue: "#d6452f",
    review_qa: "#7a5bc4", rework_qa: "#b79be0", review_rd: "#d98a1c", rework_rd: "#ecc07a",
    hold_ec: "#8c6d3f", plm_ready: "#2f6fb0", plm_signing: "#7fb0e0", done: "#2e9e5b",
  } as Record<PhaseKey, string>)[p.key],
}));

const RANGES = [14, 30, 60, 90] as const;
const W = 900;
const H = 320;
const PAD = { l: 40, r: 16, t: 14, b: 28 };

function niceMax(n: number): number {
  if (n <= 5) return 5;
  const step = n <= 20 ? 5 : n <= 60 ? 10 : n <= 150 ? 20 : 50;
  return Math.ceil(n / step) * step;
}

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

function Chart({ days, shown }: { days: TrendDay[]; shown: Set<SeriesKey> }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = niceMax(Math.max(1, ...days.flatMap((d) => SERIES.filter((s) => shown.has(s.key)).map((s) => d[s.key]))));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (days.length <= 1 ? iw / 2 : (i / (days.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((top / 4) * i));
  const every = Math.max(1, Math.ceil(days.length / 10));

  return (
    <div className="trend-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="每日進度變化曲線圖"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - PAD.l) / iw) * (days.length - 1));
          setHover(Math.max(0, Math.min(days.length - 1, i)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--ink-faint)">{t}</text>
          </g>
        ))}
        {days.map((d, i) =>
          i % every === 0 || i === days.length - 1 ? (
            <text key={d.date} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--ink-faint)">{md(d.date)}</text>
          ) : null
        )}
        {SERIES.filter((s) => shown.has(s.key)).map((s) => (
          <polyline
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth="2.2"
            strokeDasharray={s.dash}
            strokeLinejoin="round"
            points={days.map((d, i) => `${x(i)},${y(d[s.key])}`).join(" ")}
          />
        ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--ink-faint)" strokeDasharray="3 3" />
            {SERIES.filter((s) => shown.has(s.key)).map((s) => (
              <circle key={s.key} cx={x(hover)} cy={y(days[hover][s.key])} r="3.5" fill={s.color} />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="trend-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <b>{days[hover].date}</b>
          {SERIES.filter((s) => shown.has(s.key)).map((s) => (
            <div key={s.key}>
              <i style={{ background: s.color }} /> {s.label} <span className="mono">{days[hover][s.key]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PhaseChart({ days, shown, total }: { days: PhaseDay[]; shown: Set<PhaseKey>; total: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = niceMax(Math.max(1, total));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const slot = iw / Math.max(1, days.length);
  const bw = Math.max(3, Math.min(72, slot * 0.72));
  const cx = (i: number) => PAD.l + slot * (i + 0.5);
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((top / 4) * i));
  const every = Math.max(1, Math.ceil(days.length / 10));
  const active = PHASE_SERIES.filter((s) => shown.has(s.key));
  const showNum = bw >= 26; // 柱子夠寬才把數字寫在裡面

  return (
    <div className="trend-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="每天各階段料件數(堆疊長條圖)"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(days.length - 1, Math.floor((px - PAD.l) / slot))));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--ink-faint)">{t}</text>
          </g>
        ))}
        {days.map((d, i) =>
          i % every === 0 || i === days.length - 1 ? (
            <text key={d.date} x={cx(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--ink-faint)">{md(d.date)}</text>
          ) : null
        )}
        {days.map((d, i) => {
          let acc = 0;
          return (
            <g key={d.date} opacity={hover === null || hover === i ? 1 : 0.55}>
              {active.map((s) => {
                const n = d.counts[s.key] ?? 0;
                if (!n) return null;
                const y0 = y(acc);
                acc += n;
                const y1 = y(acc);
                return (
                  <g key={s.key}>
                    <rect x={cx(i) - bw / 2} y={y1} width={bw} height={Math.max(0, y0 - y1)} fill={s.color} stroke="var(--surface)" strokeWidth="0.8" />
                    {showNum && y0 - y1 >= 14 && (
                      <text x={cx(i)} y={(y0 + y1) / 2 + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill="#fff" style={{ pointerEvents: "none" }}>{n}</text>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="trend-tip" style={{ left: `${(cx(hover) / W) * 100}%` }}>
          <b>{days[hover].date}</b>
          {[...active].reverse().filter((s) => days[hover].counts[s.key]).map((s) => (
            <div key={s.key}>
              <i style={{ background: s.color }} /> {s.label} <span className="mono">{days[hover].counts[s.key]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PhaseLines({ days, shown }: { days: PhaseDay[]; shown: Set<PhaseKey> }) {
  const [hover, setHover] = useState<number | null>(null);
  const active = PHASE_SERIES.filter((s) => shown.has(s.key));
  const top = niceMax(Math.max(1, ...days.flatMap((d) => active.map((s) => d.counts[s.key] ?? 0))));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (days.length <= 1 ? iw / 2 : (i / (days.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / top) * ih;
  const ticks = Array.from({ length: 5 }, (_, i) => Math.round((top / 4) * i));
  const every = Math.max(1, Math.ceil(days.length / 10));

  return (
    <div className="trend-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="每天各階段料件數(折線圖)"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - PAD.l) / iw) * (days.length - 1));
          setHover(Math.max(0, Math.min(days.length - 1, i)));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line)" />
            <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--ink-faint)">{t}</text>
          </g>
        ))}
        {days.map((d, i) =>
          i % every === 0 || i === days.length - 1 ? (
            <text key={d.date} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--ink-faint)">{md(d.date)}</text>
          ) : null
        )}
        {active.map((s) => (
          <g key={s.key}>
            <polyline
              fill="none"
              stroke={s.color}
              strokeWidth="2.4"
              strokeLinejoin="round"
              points={days.map((d, i) => `${x(i)},${y(d.counts[s.key] ?? 0)}`).join(" ")}
            />
            {/* 天數很少時,線只有兩三個點看不出來,每個點都標一個圓點 */}
            {days.length <= 31 && days.map((d, i) => <circle key={i} cx={x(i)} cy={y(d.counts[s.key] ?? 0)} r="3" fill={s.color} />)}
          </g>
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--ink-faint)" strokeDasharray="3 3" />}
      </svg>
      {hover !== null && (
        <div className="trend-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <b>{days[hover].date}</b>
          {active.filter((s) => days[hover].counts[s.key]).map((s) => (
            <div key={s.key}>
              <i style={{ background: s.color }} /> {s.label} <span className="mono">{days[hover].counts[s.key]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 當天相對前一天的變化,例如「RD pass +2、逾期 −1」;沒變回空字串。 */
function changes(prev: TrendDay | undefined, d: TrendDay): string {
  if (!prev) return "";
  return SERIES.map((s) => {
    const n = d[s.key] - prev[s.key];
    return n ? `${s.label} ${n > 0 ? "+" : "−"}${Math.abs(n)}` : "";
  })
    .filter(Boolean)
    .join("、");
}

export default function TrendView({ parts, sla, today }: { parts: TrendInput[]; sla: Sla; today: string }) {
  const [range, setRange] = useState<number>(30);
  const [shown, setShown] = useState<Set<SeriesKey>>(() => new Set(SERIES.map((s) => s.key)));
  // 依階段(Dashboard 那張表的分類)看,或看累計里程碑曲線
  const [mode, setMode] = useState<"phase" | "milestone">("phase");
  // 依階段有兩種畫法:堆疊長條(看整體組成)、折線(看每個階段自己怎麼變)
  const [phaseStyle, setPhaseStyle] = useState<"bar" | "line">("bar");
  const [shownPhases, setShownPhases] = useState<Set<PhaseKey>>(() => new Set(PHASE_SERIES.map((s) => s.key)));

  const first = useMemo(() => earliestDate(parts), [parts]);
  // 「全部」= 從第一顆發起日起算,上限 180 天,避免曲線太密、計算太久
  const span = first ? Math.min(180, Math.max(14, Math.round((Date.parse(today) - Date.parse(first)) / 86400000) + 1)) : 14;
  const len = Math.min(range === 0 ? span : range, 180);
  // 趨勢從「第一顆發起 PA」那天開始畫,不往前拉出一長串空白(也不會被匯入前的舊 pass 日期拖長)
  const rangeFrom = addDays(today, -(len - 1));
  const from = first && rangeFrom < first ? first : rangeFrom;
  const trend = useMemo(() => buildTrend(parts, sla, from, today), [parts, sla, from, today]);
  const phaseTrend = useMemo(() => buildPhaseTrend(parts, from, today), [parts, from, today]);
  // 圖與表只畫台灣的上班日(假日、週末不畫);數字是累計的,下個上班日自然包含假日的變動。
  // 「目前」那幾張卡片仍用最後一天(今天)的數字。
  const allDays = trend.days;
  const last = allDays[allDays.length - 1];
  const days = useMemo(() => allDays.filter((d) => isTwWorkday(d.date)), [allDays]);
  const workPhaseDays = useMemo(() => phaseTrend.days.filter((d) => isTwWorkday(d.date)), [phaseTrend]);
  const rate = trend.total ? Math.round((last.released / trend.total) * 100) : 0;
  const toggle = (k: SeriesKey) =>
    setShown((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const togglePhase = (k: PhaseKey) =>
    setShownPhases((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  if (!first) {
    return <div className="card empty">還沒有任何料發起 PA,沒有資料可畫。</div>;
  }

  return (
    <div className="trend">
      <div className="kpis">
        <div className="kpi"><span className="n">{trend.total}</span><span className="l">追蹤中料數</span></div>
        <div className="kpi good"><span className="n">{last.released}</span><span className="l">PLM Released（{rate}%）</span></div>
        <div className="kpi"><span className="n">{last.rd_pass}／{last.qa_pass}</span><span className="l">RD／QA pass</span></div>
        <div className="kpi red"><span className="n">{last.overdue}</span><span className="l">目前逾期料數</span></div>
      </div>

      <div className="card trend-card">
        <div className="trend-bar">
          <div className="trend-ranges" role="group" aria-label="圖表類型">
            <button className={`btn btn-sm btn-toggle${mode === "phase" ? " on" : ""}`} onClick={() => setMode("phase")}>依階段</button>
            <button className={`btn btn-sm btn-toggle${mode === "milestone" ? " on" : ""}`} onClick={() => setMode("milestone")}>累計進度</button>
          </div>
          {mode === "phase" && (
            <div className="trend-ranges" role="group" aria-label="畫法">
              <button className={`btn btn-sm btn-toggle${phaseStyle === "bar" ? " on" : ""}`} onClick={() => setPhaseStyle("bar")}>長條圖</button>
              <button className={`btn btn-sm btn-toggle${phaseStyle === "line" ? " on" : ""}`} onClick={() => setPhaseStyle("line")}>折線圖</button>
            </div>
          )}
          <div className="trend-ranges" role="group" aria-label="時間範圍">
            {RANGES.map((r) => (
              <button key={r} className={`btn btn-sm btn-toggle${range === r ? " on" : ""}`} onClick={() => setRange(r)}>
                近 {r} 天
              </button>
            ))}
            <button className={`btn btn-sm btn-toggle${range === 0 ? " on" : ""}`} onClick={() => setRange(0)}>
              從頭
            </button>
          </div>
          <div className="trend-legend">
            {mode === "phase"
              ? PHASE_SERIES.map((s) => (
                  <button key={s.key} className={`btn btn-sm btn-ghost${shownPhases.has(s.key) ? "" : " off"}`} onClick={() => togglePhase(s.key)} aria-pressed={shownPhases.has(s.key)}>
                    <i style={{ background: s.color }} /> {s.label}
                  </button>
                ))
              : SERIES.map((s) => (
                  <button key={s.key} className={`btn btn-sm btn-ghost${shown.has(s.key) ? "" : " off"}`} onClick={() => toggle(s.key)} aria-pressed={shown.has(s.key)}>
                    <i style={{ background: s.color }} /> {s.label}
                  </button>
                ))}
          </div>
        </div>
        {mode === "phase" ? (
          phaseStyle === "bar" ? (
            <PhaseChart days={workPhaseDays} shown={shownPhases} total={phaseTrend.total} />
          ) : (
            <PhaseLines days={workPhaseDays} shown={shownPhases} />
          )
        ) : (
          <Chart days={days} shown={shown} />
        )}
        <p className="trend-note">
          {mode === "phase"
            ? (phaseStyle === "bar"
              ? "長條圖：每一根柱子是一天，柱子裡的每一色塊是一個階段（顏色看上面的圖例，數字是料件數，跟專案頁的階段表同一套分類），整根柱子的高度就是追蹤中的料數。"
              : "折線圖：每個階段一條線（顏色看圖例），縱軸是那個階段的料件數，可以點圖例隱藏不想看的階段。") + "階段用各欄日期回推；卡關原因（ISSUE、待RD圖面進版）沒有歷史紀錄，視為從發起日起就是現在的狀態。日期事後被改，過去的數字也會跟著變。只畫台灣的上班日，假日與週末不畫。"
            : "曲線是用各欄日期回推的：某天的數字＝日期在那天（含）以前的料數；逾期料數用目前的 SLA 在那一天重算。日期事後被改，過去的數字也會跟著變。只畫台灣的上班日，假日與週末不畫。"}
        </p>
      </div>

      {mode === "phase" ? (
        <div className="card trend-table">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                {PHASE_SERIES.map((s) => (
                  <th key={s.key} className="num">{s.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[...workPhaseDays].reverse().map((d) => (
                <tr key={d.date}>
                  <td className="mono">{d.date}</td>
                  {PHASE_SERIES.map((s) => (
                    <td key={s.key} className="num mono">{d.counts[s.key] ?? 0}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card trend-table">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                {SERIES.map((s) => (
                  <th key={s.key} className="num">{s.label}</th>
                ))}
                <th className="num">完成率</th>
                <th>與前一天相比</th>
              </tr>
            </thead>
            <tbody>
              {[...days].reverse().map((d) => {
                const prev = days[days.indexOf(d) - 1];
                const diff = changes(prev, d);
                return (
                  <tr key={d.date}>
                    <td className="mono">{d.date}</td>
                    {SERIES.map((s) => (
                      <td key={s.key} className={`num mono${s.key === "overdue" && d.overdue ? " bad" : ""}`}>{d[s.key]}</td>
                    ))}
                    <td className="num mono">{trend.total ? Math.round((d.released / trend.total) * 100) : 0}%</td>
                    <td className="trend-diff">{diff || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
