"use client";

// 供應商清單與 Email,催供應商發信用。所有登入的人都能新增、修改、刪除。

import { useEffect, useMemo, useState } from "react";
import PaPage from "@/components/pa/PaPage";
import PaTopBar from "@/components/pa/PaTopBar";
import { api } from "@/lib/paClient";

interface Supplier { id: string; name: string; emails: string; contact: string; note: string; updated_at: string | null }
interface Draft { name: string; emails: string; contact: string; note: string }
const EMPTY: Draft = { name: "", emails: "", contact: "", note: "" };

function Suppliers() {
  const [list, setList] = useState<Supplier[] | null>(null);
  const [unlisted, setUnlisted] = useState<{ name: string; parts: number }[]>([]);
  const [q, setQ] = useState("");
  const [add, setAdd] = useState<Draft>(EMPTY);
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Draft>(EMPTY);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setMsg({ err: e instanceof Error ? e.message : String(e) });

  async function load() {
    const r = await api<{ suppliers: Supplier[]; unlisted: { name: string; parts: number }[] }>("/api/pa/suppliers");
    setList(r.suppliers);
    setUnlisted(r.unlisted);
  }
  useEffect(() => { load().catch(fail); }, []);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg({});
    try {
      await fn();
      await load();
      if (ok) setMsg({ ok });
      return true;
    } catch (e) {
      fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (list ?? []).filter((s) => !k || `${s.name} ${s.emails} ${s.contact} ${s.note}`.toLowerCase().includes(k));
  }, [list, q]);

  const noMail = (list ?? []).filter((s) => !s.emails).length;

  return (
    <>
      <PaTopBar crumb="供應商清單" />
      <main className="page">
        <h1>供應商清單與 Email</h1>
        <p className="lede">
          催供應商發信用。所有人都可以新增、修改、刪除。一家供應商可以放多個信箱（換行或逗號隔開）。
          名稱要跟零件上的「供應商」欄位寫的一樣，系統才對得起來。
        </p>

        {msg.err && <div className="err">{msg.err}</div>}
        {msg.ok && <div className="card section" style={{ color: "var(--success)" }}>{msg.ok}</div>}

        {unlisted.length > 0 && (
          <div className="card section">
            零件上有 <b>{unlisted.length}</b> 家供應商還沒建檔
            （{unlisted.slice(0, 3).map((u) => `${u.name}（${u.parts}）`).join("、")}{unlisted.length > 3 ? "…" : ""}）。
            <div style={{ marginTop: 10 }}>
              <button
                className="btn btn-accent"
                disabled={busy}
                onClick={async () => {
                  let n = 0;
                  if (await run(async () => { n = (await api<{ added: number }>("/api/pa/suppliers", { json: { importFromParts: true } })).added; }, "")) {
                    setMsg({ ok: `已補進 ${n} 家，Email 還是空的，請逐家填` });
                  }
                }}
              >
                一鍵補進清單
              </button>
            </div>
          </div>
        )}

        <div className="card section">
          <h2>新增供應商</h2>
          <DraftForm d={add} set={setAdd} />
          <div className="row" style={{ marginTop: 10 }}>
            <button
              className="btn btn-accent"
              disabled={busy || !add.name.trim()}
              onClick={async () => {
                if (await run(() => api("/api/pa/suppliers", { json: add }), `已新增「${add.name.trim()}」`)) setAdd(EMPTY);
              }}
            >
              新增
            </button>
          </div>
        </div>

        <div className="card section">
          <div className="row" style={{ marginBottom: 10, gap: 12 }}>
            <input type="search" placeholder="搜尋供應商、Email、聯絡人" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="muted">
              共 {list?.length ?? 0} 家{noMail > 0 && `，${noMail} 家還沒填 Email`}
            </span>
          </div>
          {!list ? (
            <div className="muted">載入中…</div>
          ) : shown.length === 0 ? (
            <div className="muted">沒有資料</div>
          ) : (
            <table className="slatable suptable">
              <thead>
                <tr><th>供應商</th><th>Email</th><th>聯絡人</th><th>備註</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((s) =>
                  editId === s.id ? (
                    <tr key={s.id}>
                      <td colSpan={4}><DraftForm d={edit} set={setEdit} /></td>
                      <td className="sup-act">
                        <button
                          className="btn btn-sm btn-accent"
                          disabled={busy || !edit.name.trim()}
                          onClick={async () => {
                            if (await run(() => api(`/api/pa/suppliers/${s.id}`, { method: "PUT", json: edit }), "已儲存")) setEditId(null);
                          }}
                        >
                          儲存
                        </button>
                        <button className="btn btn-sm btn-ghost" onClick={() => setEditId(null)}>取消</button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={s.id}>
                      <td><b>{s.name}</b></td>
                      <td className="sup-mails">{s.emails ? s.emails : <span className="muted">（未填）</span>}</td>
                      <td>{s.contact}</td>
                      <td className="muted">{s.note}</td>
                      <td className="sup-act">
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => { setEditId(s.id); setEdit({ name: s.name, emails: s.emails, contact: s.contact, note: s.note }); }}
                        >
                          編輯
                        </button>
                        <button
                          className="btn btn-sm btn-ghost"
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`刪除「${s.name}」？`)) run(() => api(`/api/pa/suppliers/${s.id}`, { method: "DELETE" }), `已刪除「${s.name}」`);
                          }}
                        >
                          刪除
                        </button>
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}

function DraftForm({ d, set }: { d: Draft; set: (d: Draft) => void }) {
  return (
    <div className="supform">
      <label>供應商名稱<input value={d.name} onChange={(e) => set({ ...d, name: e.target.value })} /></label>
      <label>聯絡人<input value={d.contact} onChange={(e) => set({ ...d, contact: e.target.value })} /></label>
      <label className="wide">
        Email（多個用換行或逗號隔開）
        <textarea rows={2} value={d.emails} onChange={(e) => set({ ...d, emails: e.target.value })} />
      </label>
      <label className="wide">備註<input value={d.note} onChange={(e) => set({ ...d, note: e.target.value })} /></label>
    </div>
  );
}

export default function SuppliersPage() {
  return (
    <PaPage>
      <Suppliers />
    </PaPage>
  );
}
