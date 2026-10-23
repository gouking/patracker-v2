"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/paClient";
import type { Diff } from "@/server/pa/bom";

interface Result {
  source: "excel" | "pdf";
  sheet: string;
  header?: { top_pn: string; top_desc: string; lifecycle: string; revision: string; change: string };
  fgModel?: string;
  mapped: { column: string; field: string }[];
  ignored: string[];
  warnings: string[];
  rowCount: number;
  diff: Diff;
  committed: boolean;
}

export default function ImportBom({ projectId }: { projectId: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** PDF 的組件品名不一定等於你們慣用的成品機種名稱，匯入前可以改 */
  const [fgModel, setFgModel] = useState("");

  async function send(f: File, commit: boolean, model = fgModel) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.set("file", f);
      form.set("commit", commit ? "1" : "0");
      if (model.trim()) form.set("fg_model", model.trim());
      const r = await api<Result>(`/api/pa/projects/${projectId}/import`, { form });
      setRes(r);
      if (r.source === "pdf" && !model.trim() && r.fgModel) setFgModel(r.fgModel);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRes(null);
    } finally {
      setBusy(false);
    }
  }

  const d = res?.diff;
  const nothing =
    d && !d.added.length && !d.changed.length && !d.filled && !d.issuesAdded && !d.notesAdded && !d.removed.length && !d.restored.length && !d.autoStarted;

  return (
    <div className="card section">
      <h2>1. 選擇檔案</h2>
      <div className="row">
        <input
          type="file"
          accept=".xlsx,.pdf"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            setRes(null);
            if (f) send(f, false);
          }}
        />
        {busy && <span className="muted">處理中…</span>}
      </div>
      {error && <div className="err" style={{ marginTop: 10 }}>{error}</div>}

      {res && d && (
        <>
          <h2 style={{ marginTop: 20 }}>{res.committed ? "✓ 已匯入" : "2. 確認差異"}</h2>
          <div className="muted" style={{ fontSize: 13 }}>
            {res.source === "pdf" ? `PLM BOM「${res.sheet}」` : `工作表「${res.sheet}」`}，{res.rowCount} 顆料
          </div>
          {res.source === "pdf" && res.header && (
            <div className="row" style={{ marginTop: 10, alignItems: "flex-end", gap: 12 }}>
              <div>
                <div className="muted" style={{ fontSize: 12 }}>主料料號（BOM 最上層）</div>
                <b className="mono">{res.header.top_pn}</b>
                {res.header.revision && <span className="chip" style={{ marginLeft: 6 }}>Rev {res.header.revision}</span>}
                {res.header.change && <span className="chip" style={{ marginLeft: 6 }}>{res.header.change}</span>}
                {res.header.lifecycle && <span className="chip" style={{ marginLeft: 6 }}>{res.header.lifecycle}</span>}
              </div>
              <label>
                <div className="muted" style={{ fontSize: 12 }}>成品機種（要跟現有資料一致的話可以改）</div>
                <input value={fgModel} onChange={(e) => setFgModel(e.target.value)} style={{ minWidth: 280 }} />
              </label>
              {!res.committed && (
                <button className="btn btn-sm" disabled={busy || !file} onClick={() => file && send(file, false)}>
                  重新預覽
                </button>
              )}
            </div>
          )}
          <div className="stats4">
            <Stat n={d.added.length} l="新增料號" />
            <Stat n={d.changed.length} l="BOM 資料變更" />
            <Stat n={d.filled} l="補上空白欄位" />
            <Stat n={d.issuesAdded} l="新增退件紀錄" />
            <Stat n={d.notesAdded} l="新增進度紀錄" />
            <Stat n={d.removed.length} l="已不在 BOM" bad />
            <Stat n={d.restored.length} l="重新出現" />
            <Stat n={d.autoExcluded.length} l="母階組件（自動不追蹤）" />
            <Stat n={d.autoStarted ?? 0} l="自動發起 PA（填今天）" />
          </div>

          {d.added.length > 0 && (
            <details>
              <summary>新增料號（{d.added.length}）</summary>
              <div className="difflist">
                {d.added.map((x) => <div key={x.part_pn}><span className="mono">{x.part_pn}</span>　{x.part_desc}</div>)}
              </div>
            </details>
          )}
          {d.changed.length > 0 && (
            <details open>
              <summary>BOM 資料變更（{d.changed.length}）</summary>
              <div className="difflist">
                {d.changed.map((x) => (
                  <div key={x.part_pn}>
                    <span className="mono">{x.part_pn}</span>
                    {x.changes.map((c, i) => (
                      <span key={i}>{c.field}：{c.from || "（空）"} → <b>{c.to || "（空）"}</b>　</span>
                    ))}
                  </div>
                ))}
              </div>
            </details>
          )}
          {d.autoExcluded.length > 0 && (
            <details>
              <summary>母階組件，自動排除不做 PA 追蹤（{d.autoExcluded.length}）</summary>
              <div className="difflist">
                {d.autoExcluded.map((x) => <div key={x.part_pn}><span className="mono">{x.part_pn}</span>　{x.part_desc}</div>)}
              </div>
            </details>
          )}
          {d.removed.length > 0 && (
            <details open>
              <summary>檔案裡沒有、將標為「已不在 BOM」（{d.removed.length}）</summary>
              <div className="difflist">
                {d.removed.map((x) => <div key={x.part_pn}><span className="mono">{x.part_pn}</span>　{x.part_desc}</div>)}
              </div>
            </details>
          )}
          <details>
            <summary>欄位對應（{res.mapped.length} 欄對到、{res.ignored.length} 欄忽略）</summary>
            <table className="maptable" style={{ margin: "8px 0" }}>
              <tbody>
                {res.mapped.map((m) => (
                  <tr key={m.column}><td className="muted">{m.column.replace(/\s+/g, " ")}</td><td>→ {m.field}</td></tr>
                ))}
                {res.ignored.map((c) => (
                  <tr key={c}><td className="muted">{c.replace(/\s+/g, " ")}</td><td className="muted">（忽略）</td></tr>
                ))}
              </tbody>
            </table>
          </details>
          {res.warnings.length > 0 && (
            <details>
              <summary>注意事項（{res.warnings.length}）</summary>
              <div className="difflist">{res.warnings.map((w, i) => <div key={i}>{w}</div>)}</div>
            </details>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            {res.committed ? (
              <Link className="btn btn-accent" href={`/pa/p/${projectId}`}>回到追蹤表</Link>
            ) : nothing ? (
              <span className="ok">跟目前資料完全一樣，不需要匯入。</span>
            ) : (
              <button className="btn btn-accent" disabled={busy || !file} onClick={() => file && send(file, true)}>
                確認匯入
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ n, l, bad }: { n: number; l: string; bad?: boolean }) {
  return (
    <div className={`kpi ${bad && n ? "red" : ""}`}>
      <span className="n">{n}</span>
      <span className="l">{l}</span>
    </div>
  );
}
