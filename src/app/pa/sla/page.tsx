"use client";

// 全公司的 SLA 天數。所有人都看得到,只有系統管理員能改;改了所有專案一起生效。
// (原本每個專案各設一份,2026-10-08 使用者決定改成一套。)

import { useEffect, useState } from "react";
import PaPage from "@/components/pa/PaPage";
import PaTopBar from "@/components/pa/PaTopBar";
import { api } from "@/lib/paClient";
import { DEFAULT_SLA, SLA_FIELDS, type Sla } from "@/lib/pa";

function SlaSettings() {
  const [sla, setSla] = useState<Sla | null>(null);
  const [saved, setSaved] = useState<Sla | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ sla: Sla; canEdit: boolean }>("/api/pa/sla").then(
      (r) => {
        setSla(r.sla);
        setSaved(r.sla);
        setCanEdit(r.canEdit);
      },
      (e) => setMsg({ err: e instanceof Error ? e.message : String(e) })
    );
  }, []);

  async function save() {
    if (!sla) return;
    setBusy(true);
    setMsg({});
    try {
      const r = await api<{ sla: Sla }>("/api/pa/sla", { method: "PUT", json: { sla } });
      setSla(r.sla);
      setSaved(r.sla);
      setMsg({ ok: "已儲存，所有專案的紅黃燈與逾期信都改用新的天數" });
    } catch (e) {
      setMsg({ err: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const dirty = sla && saved && SLA_FIELDS.some((f) => sla[f.key] !== saved[f.key]);

  return (
    <>
      <PaTopBar crumb="SLA 設定" />
      <main className="page">
        <h1>SLA 天數</h1>
        <p className="lede">
          全公司一套，所有專案共用。天數是日曆天，從「起算」那一步完成的日期開始算；超過就標紅、寫進每天早上的逾期信。
          {!canEdit && sla && " 只有系統管理員可以修改。"}
        </p>

        {msg.err && <div className="err">{msg.err}</div>}
        {msg.ok && <div className="card section" style={{ color: "var(--success)" }}>{msg.ok}</div>}

        {!sla ? (
          <div className="muted">載入中…</div>
        ) : (
          <div className="card section">
            <table className="slatable">
              <thead>
                <tr>
                  <th>項目</th>
                  <th>起算</th>
                  <th>負責</th>
                  <th className="num">天數</th>
                </tr>
              </thead>
              <tbody>
                {SLA_FIELDS.map((f) => (
                  <tr key={f.key}>
                    <td>{f.label}</td>
                    <td className="muted">{f.from}</td>
                    <td className="muted">{f.who}</td>
                    <td className="num">
                      {canEdit ? (
                        <input
                          type="number"
                          min={0}
                          max={365}
                          value={sla[f.key]}
                          onChange={(e) => setSla({ ...sla, [f.key]: Number(e.target.value) })}
                          aria-label={`${f.label}天數`}
                        />
                      ) : (
                        <b className="mono">{sla[f.key]}</b>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {canEdit && (
              <div className="row" style={{ marginTop: 14 }}>
                <button className="btn btn-accent" disabled={busy || !dirty} onClick={save}>
                  {busy ? "儲存中…" : "儲存"}
                </button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setSla(DEFAULT_SLA)}>
                  填入預設值（{SLA_FIELDS.map((f) => DEFAULT_SLA[f.key]).join(" / ")}）
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </>
  );
}

export default function SlaPage() {
  return (
    <PaPage>
      <SlaSettings />
    </PaPage>
  );
}
