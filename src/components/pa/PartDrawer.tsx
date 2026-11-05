"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/paClient";
import { ESCALATE_AT, ISSUE_EDITOR, HOLD_REASONS, canEditField, holdHint, PHASE_BY_KEY, RESUBMIT_EDITORS, REVIEW_START, daysBetween, ROLE_LABEL, STAGES, evalPart, stageDays, stageStart, todayIn, type Role, type Sla } from "@/lib/pa";
import type { PartDetail, HoldRecord } from "@/server/pa/parts";

export default function PartDrawer({
  projectId, partId, roles, isAdmin, sla, me, members, canManage, onClose, onChanged,
}: {
  projectId: string;
  partId: string;
  roles: Role[];
  isAdmin: boolean;
  sla: Sla;
  me: string;
  members: { user_id: string; name: string; pending?: boolean }[];
  canManage: boolean;
  onClose: () => void;
  onChanged: (d: PartDetail) => void;
}) {
  const [d, setD] = useState<PartDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/pa/projects/${projectId}/parts/${partId}`;

  const got = useCallback((x: PartDetail) => {
    setD(x);
    onChanged(x);
  }, [onChanged]);

  useEffect(() => {
    api<PartDetail>(base).then(setD, (e) => setError(String(e.message ?? e)));
  }, [base]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  /** 先把結果畫上去,再送出。雲端一趟要幾百毫秒,不要讓人按了「記錄」盯著畫面等;
   *  伺服器回來以它為準,失敗就還原並說明原因。 */
  async function optimistic(change: (x: PartDetail) => PartDetail, req: () => Promise<PartDetail>) {
    if (!d) return;
    const before = d;
    const guess = change(d);
    // 表格那一列的退件次數、Status、階段也一起先變
    const iss = guess.issues.map((i) => ({ dept: i.dept, date: i.date, resubmitted: i.resubmitted ?? null }));
    guess.part = { ...guess.part, issues: iss, ev: evalPart(guess.part, iss, sla, todayIn()) };
    setD(guess);
    onChanged(guess);
    setError(null);
    try {
      got(await req());
    } catch (e) {
      setD(before);
      onChanged(before);
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  const tmpId = () => `tmp-${Math.random().toString(36).slice(2)}`;
  const byDate = <T extends { date: string }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  const p = d?.part;

  return (
    <>
      <div className="drawer-bg" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="料號詳細資料">
        <header>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2>{p?.part_pn ?? "…"}</h2>
            <p>{p?.part_desc}</p>
            {p && (
              <div className="row" style={{ marginTop: 6 }}>
                <span className={`phase-chip ph-${p.ev.phase}`} title={PHASE_BY_KEY[p.ev.phase].desc}>{PHASE_BY_KEY[p.ev.phase].label}</span>
                {p.ev.escalated.length > 0 && (
                  <span className="chip warn">{p.ev.escalated.join("、")} 退件 ≥{ESCALATE_AT} 次，需 PM 協助</span>
                )}
                {p.removed_from_bom ? <span className="chip warn">已不在 BOM</span> : null}
                {p.ev.missingType && <span className="chip warn">缺屬性</span>}
              </div>
            )}
          </div>
          <button className="btn btn-sm" onClick={onClose} aria-label="關閉">✕</button>
        </header>
        <div className="body">
          {error && <div className="err">{error}</div>}
          {!p ? (
            <div className="muted">載入中…</div>
          ) : (
            <>
              <section>
                <h3>進度與 SLA</h3>
                <div className="timeline">
                  <div className={`tl ${p.pa_start ? "done" : ""}`}>
                    <span className="dot" />
                    <span>PM/RD 發起 PA</span>
                    <span className="mono">{p.pa_start ?? "—"}</span>
                  </div>
                  {STAGES.map((s) => {
                    const e = p.ev[s.key];
                    const days = stageDays(p, s, sla, p.issues);
                    const from = stageStart(p, s, p.issues);
                    let note = "";
                    if (!from) note = "等待前一步";
                    else if (days === null) note = p[s.key] ? `${p[s.key]}（缺屬性，無法判斷是否超時）` : "缺屬性，算不出期限";
                    else if (e.light === "red") note = `逾期 ${e.overBy} 天（SLA ${days} 天）${REVIEW_START[s.key] && !p[REVIEW_START[s.key]!] ? "・還沒開始 review" : ""}`;
                    else if (e.light === "yellow") note = `${p[s.key]}・超出 ${e.overBy} 天`;
                    else if (p[s.key]) note = p[s.key] as string;
                    else note = `剩 ${e.dueIn} 天（SLA ${days} 天）`;
                    return (
                      <div key={s.key} className={`tl ${p[s.key] ? "done" : ""} ${e.light ?? ""}`}>
                        <span className="dot" />
                        <span>{ROLE_LABEL[s.owner]}：{s.label}</span>
                        <span className="mono" style={{ fontSize: 12 }}>{note}</span>
                      </div>
                    );
                  })}
                  {/* 流程圖最後一段:沒有 SLA,只看有沒有做 */}
                  <div className={`tl ${p.plm_upload ? "done" : ""}`}>
                    <span className="dot" />
                    <span>Sourcer：上傳 PLM 送簽</span>
                    <span className="mono" style={{ fontSize: 12 }}>{p.plm_upload ?? (p.ev.approved ? "可以上傳了" : "等 RD、QA pass")}</span>
                  </div>
                  <div className={`tl ${p.plm_released ? "done" : ""}`}>
                    <span className="dot" />
                    <span>PLM Released</span>
                    <span className="mono" style={{ fontSize: 12 }}>{p.plm_released ?? (p.plm_upload ? "簽核中" : "—")}</span>
                  </div>
                  {p.ev.supplier_update.dept && (
                    <div className={`tl ${p.ev.supplier_update.light ?? ""}`}>
                      <span className="dot" />
                      <span>Sourcer：供應商更新資料（{p.ev.supplier_update.dept} 退件）</span>
                      <span className="mono" style={{ fontSize: 12 }}>
                        {p.ev.supplier_update.light === "red"
                          ? `逾期 ${p.ev.supplier_update.overBy} 天（SLA ${sla.supplier_update} 天，自 ${p.ev.supplier_update.from}）`
                          : `剩 ${p.ev.supplier_update.dueIn} 天（SLA ${sla.supplier_update} 天）`}
                      </span>
                    </div>
                  )}
                  {p.ev.rereview.dept && (
                    <div className={`tl ${p.ev.rereview.light ?? ""}`}>
                      <span className="dot" />
                      <span>{p.ev.rereview.dept}：供應商已補件，待複審</span>
                      <span className="mono" style={{ fontSize: 12 }}>
                        {p.ev.rereview.light === "red"
                          ? `逾期 ${p.ev.rereview.overBy} 天（SLA ${sla.rereview} 天，自 ${p.ev.rereview.from}）`
                          : `剩 ${p.ev.rereview.dueIn} 天（SLA ${sla.rereview} 天）`}
                      </span>
                    </div>
                  )}
                </div>
              </section>

              <section>
                <h3>卡關</h3>
                <HoldPanel
                  part={p}
                  holds={d!.holds ?? []}
                  members={members}
                  me={me}
                  canEdit={canEditField("hold_reason", roles, isAdmin)}
                  onSubmit={async (payload) => {
                    setError(null);
                    try {
                      got(await api<PartDetail>(`${base}/hold`, { json: payload }));
                      return true;
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e));
                      return false;
                    }
                  }}
                />
              </section>

              <section>
                <h3>進度紀錄（原本 Excel 的 remark）</h3>
                <div className="issues">
                  {d!.notes.length === 0 && <div className="muted" style={{ fontSize: 13 }}>還沒有紀錄</div>}
                  {d!.notes.map((n) => (
                    <div key={n.id} className="issue">
                      <span className="chip">記</span>
                      <span className="mono">{n.date}</span>
                      <span>
                        {n.text}
                        <span className="muted" style={{ fontSize: 11.5 }}>　— {n.created_by_name}</span>
                      </span>
                      {(canManage || n.created_by === me) && !n.id.startsWith("tmp-") && (
                        <button
                          className="btn btn-sm btn-ghost btn-danger"
                          onClick={async () => {
                            if (!confirm("刪除這筆進度紀錄？")) return;
                            optimistic(
                              (x) => {
                                const notes = x.notes.filter((y) => y.id !== n.id);
                                return { ...x, notes, part: { ...x.part, recent_notes: notes.map((y) => ({ date: y.date, text: y.text })) } };
                              },
                              () => api<PartDetail>(`/api/pa/projects/${projectId}/notes/${n.id}`, { method: "DELETE" })
                            );
                          }}
                        >
                          刪除
                        </button>
                      )}
                    </div>
                  ))}
                  {!p.removed_from_bom && (
                    <NoteForm
                      onAdd={(date, text) =>
                        optimistic(
                          (x) => {
                            const n = { id: tmpId(), part_id: partId, date, text: text.trim(), created_by: me, created_at: "", created_by_name: "儲存中…" };
                            // 進度紀錄是新到舊
                            const notes = [n, ...x.notes].sort((a, b) => byDate(b, a));
                            return { ...x, notes, part: { ...x.part, recent_notes: notes.map((y) => ({ date: y.date, text: y.text })) } };
                          },
                          () => api<PartDetail>(`${base}/notes`, { json: { date, text } })
                        )
                      }
                    />
                  )}
                </div>
              </section>

              <section>
                <h3>供應商更新資料</h3>
                <div className="issues">
                  <SupplierUpdated
                    value={p.supplier_updated}
                    canEdit={!p.removed_from_bom && (isAdmin || roles.includes("sourcer"))}
                    onSet={(v) =>
                      optimistic(
                        (x) => ({ ...x, part: { ...x.part, supplier_updated: v } }),
                        () => api<PartDetail>(base, { method: "PATCH", json: { field: "supplier_updated", value: v ?? "" } })
                      )
                    }
                  />
                </div>
              </section>

              {(["RD", "QA"] as const).map((dept) => (
                <section key={dept}>
                  <h3>{dept} 退件紀錄（給供應商的問題）</h3>
                  <div className="issues">
                    {d!.issues.filter((i) => i.dept === dept).length === 0 && <div className="muted" style={{ fontSize: 13 }}>沒有紀錄</div>}
                    {d!.issues
                      .filter((i) => i.dept === dept)
                      .map((i, idx, list) => (
                        <div key={i.id} className="issue">
                          <span className="chip warn">#{idx + 1}</span>
                          <span className="mono">{i.date}</span>
                          <span>
                            {i.note || <span className="muted">（無說明）</span>}
                            <span className="muted" style={{ fontSize: 11.5 }}>　— {i.created_by_name}</span>
                            <Resubmit
                              issue={i}
                              superseded={idx < list.length - 1}
                              today={todayIn()}
                              sla={sla.supplier_update}
                              canEdit={!i.id.startsWith("tmp-") && (isAdmin || RESUBMIT_EDITORS[dept].some((r) => roles.includes(r)))}
                              onSet={(v) =>
                                optimistic(
                                  (x) => ({ ...x, issues: x.issues.map((y) => (y.id === i.id ? { ...y, resubmitted: v } : y)) }),
                                  () => api<PartDetail>(`/api/pa/projects/${projectId}/issues/${i.id}`, { method: "PATCH", json: { resubmitted: v } })
                                )
                              }
                            />
                          </span>
                          {(isAdmin || roles.includes(ISSUE_EDITOR[dept])) && !i.id.startsWith("tmp-") && (
                            <button
                              className="btn btn-sm btn-ghost btn-danger"
                              onClick={async () => {
                                if (!confirm("刪除這筆退件紀錄？")) return;
                                optimistic(
                                  (x) => ({ ...x, issues: x.issues.filter((y) => y.id !== i.id) }),
                                  () => api<PartDetail>(`/api/pa/projects/${projectId}/issues/${i.id}`, { method: "DELETE" })
                                );
                              }}
                            >
                              刪除
                            </button>
                          )}
                        </div>
                      ))}
                    {(isAdmin || roles.includes(ISSUE_EDITOR[dept])) && !p.removed_from_bom && (
                      <IssueForm
                        dept={dept}
                        onAdd={(date, note) =>
                          optimistic(
                            (x) => ({
                              ...x,
                              issues: [
                                ...x.issues,
                                { id: tmpId(), part_id: partId, dept, date, note: note.trim(), resubmitted: null, created_by: me, created_at: "", created_by_name: "儲存中…" },
                              ].sort(byDate),
                            }),
                            () => api<PartDetail>(`${base}/issues`, { json: { dept, date, note } })
                          )
                        }
                      />
                    )}
                  </div>
                </section>
              ))}

            </>
          )}
        </div>
      </aside>
    </>
  );
}

/** 卡關:原因(自由填)、卡關日期、負責人(專案成員,誰都可以)、備註;結束時填完成日期,料回到原本的進度。
 *  下面列出這顆料以前卡關過的歷史。 */
function HoldPanel({
  part, holds, members, me, canEdit, onSubmit,
}: {
  part: PartDetail["part"];
  holds: HoldRecord[];
  members: { user_id: string; name: string; pending?: boolean }[];
  me: string;
  canEdit: boolean;
  onSubmit: (payload: Record<string, unknown>) => Promise<boolean>;
}) {
  const today = todayIn();
  const [formOpen, setFormOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [since, setSince] = useState(today);
  const [owner, setOwner] = useState("");
  const [note, setNote] = useState("");
  const [resolved, setResolved] = useState(today);
  const [busy, setBusy] = useState(false);
  const people = members.filter((m) => !m.pending);
  const nameOf = (id: string) => people.find((m) => m.user_id === id)?.name ?? "(已不是成員)";
  const open = part.hold_reason;

  const openForm = (edit: boolean) => {
    setReason(edit ? part.hold_reason : "");
    setSince(edit ? part.hold_since ?? today : today);
    // 預設自己當負責人,但只限專案成員(管理員不一定是成員,選單也選不到自己)
    setOwner(edit ? part.hold_owner || "" : people.some((m) => m.user_id === me) ? me : "");
    setNote(edit ? part.hold_note ?? "" : "");
    setFormOpen(true);
  };
  const run = async (payload: Record<string, unknown>) => {
    setBusy(true);
    const ok = await onSubmit(payload);
    setBusy(false);
    if (ok) setFormOpen(false);
  };

  return (
    <div className="holdpanel">
      {open && !formOpen && (
        <div className="hold-open">
          <div>
            <span className="chip warn">{open}</span>
            <span className="muted" style={{ fontSize: 12 }}>　{holdHint(open)}</span>
          </div>
          <div className="hold-meta">
            <span>負責人：{part.hold_owner ? nameOf(part.hold_owner) : "（未指定）"}</span>
            <span>卡關日期：<span className="mono">{part.hold_since ?? "—"}</span>{part.hold_since ? `（已 ${daysBetween(part.hold_since, today)} 天）` : ""}</span>
            {part.hold_note && <span>備註：{part.hold_note}</span>}
          </div>
          {canEdit && (
            <div className="hold-actions">
              <input type="date" value={resolved} min={part.hold_since ?? undefined} onChange={(e) => setResolved(e.target.value)} aria-label="完成日期" />
              <button className="btn btn-sm btn-accent" disabled={busy || !resolved || (!!part.hold_since && resolved < part.hold_since)} onClick={() => run({ action: "resolve", resolved })}>
                解除卡關（回到原本進度）
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => openForm(true)}>編輯</button>
            </div>
          )}
        </div>
      )}
      {!open && !formOpen && (
        <div className="muted" style={{ fontSize: 13 }}>
          目前沒有卡關
          {canEdit && <button className="btn btn-sm" style={{ marginLeft: 8 }} onClick={() => openForm(false)}>＋ 標記卡關</button>}
        </div>
      )}
      {formOpen && (
        <form
          className="hold-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run({ action: "set", reason, since, owner, note });
          }}
        >
          <label>
            卡關原因（可自由填）
            <input list="hold-reasons" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={40} required autoFocus placeholder="例如：待RD圖面進版、ISSUE、廠商停產" />
            <datalist id="hold-reasons">{HOLD_REASONS.map((h) => <option key={h} value={h} />)}</datalist>
          </label>
          <label>
            卡關日期
            <input type="date" value={since} onChange={(e) => setSince(e.target.value)} required />
          </label>
          <label>
            負責人
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">（未指定）</option>
              {people.map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}
            </select>
          </label>
          <label>
            備註（選填）
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
          </label>
          <div className="hold-actions">
            <button className="btn btn-sm btn-accent" disabled={busy || !reason.trim()}>{open ? "儲存" : "標記卡關"}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFormOpen(false)}>取消</button>
          </div>
        </form>
      )}
      {holds.length > 0 && (
        <div className="hold-history">
          <div className="muted" style={{ fontSize: 12, margin: "10px 0 4px" }}>卡關歷史</div>
          {holds.map((h) => (
            <div key={h.id} className="hold-row">
              <span className="chip">{h.reason}</span>
              <span className="mono">{h.started} → {h.resolved}</span>
              <span className="muted">（{daysBetween(h.started, h.resolved)} 天）</span>
              <span>{h.owner_name || "未指定負責人"}</span>
              {h.note && <span className="muted">・{h.note}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 退件之後供應商送回更新資料的日期。空白＝還在等;填了就回到 RD/QA 待審。 */
function Resubmit({
  issue, superseded, today, sla, canEdit, onSet,
}: {
  issue: { date: string; resubmitted: string | null };
  /** 後面還有同部門的退件:供應商一定送回過才會再被退,所以這筆不算在等 */
  superseded: boolean;
  today: string;
  sla: number;
  canEdit: boolean;
  onSet: (v: string | null) => void;
}) {
  const [date, setDate] = useState(today);
  if (issue.resubmitted) {
    return (
      <span className="resub done">
        供應商 {issue.resubmitted} 更新（{daysBetween(issue.date, issue.resubmitted)} 天）
        {canEdit && (
          <button className="btn btn-sm btn-ghost" onClick={() => onSet(null)} title="改回「還在等供應商」">
            清除
          </button>
        )}
      </span>
    );
  }
  if (superseded) {
    return <span className="resub muted">之後又退件，視為供應商已更新過</span>;
  }
  const waited = daysBetween(issue.date, today);
  const late = waited > sla;
  return (
    <span className={`resub${late ? " late" : ""}`}>
      等供應商更新・已 {waited} 天{late ? `（超過 SLA ${sla} 天）` : ""}
      {canEdit && (
        <>
          <input type="date" value={date} min={issue.date} onChange={(e) => setDate(e.target.value)} aria-label="供應商更新日" />
          <button className="btn btn-sm" disabled={!date || date < issue.date} onClick={() => onSet(date)}>
            供應商已更新
          </button>
        </>
      )}
    </span>
  );
}

/** Sourcer 回填「供應商哪天把更新（補）的資料送回來」。有 RD/QA 退件時,填了退件之後的日期就等於
 *  供應商已送回,QA/RD 的 review pass 期限從這天重新算(天數用「補件後複審」)。 */
function SupplierUpdated({
  value, canEdit, onSet,
}: {
  value: string | null;
  canEdit: boolean;
  onSet: (v: string | null) => void;
}) {
  const [date, setDate] = useState(value ?? todayIn());
  return (
    <>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
        供應商把更新（補）的資料送回來的日期。有退件時，QA／RD 的 review pass 期限會從這天重新算。
      </div>
      {value && (
        <div className="issue">
          <span className="chip">更新</span>
          <span className="mono">{value}</span>
          <span className="muted">供應商已更新資料</span>
          {canEdit && (
            <button className="btn btn-sm btn-ghost btn-danger" onClick={() => onSet(null)}>
              清除
            </button>
          )}
        </div>
      )}
      {!value && !canEdit && <div className="muted" style={{ fontSize: 13 }}>還沒有紀錄（由 Sourcer 回填）</div>}
      {canEdit && (
        <form
          className="issueform"
          onSubmit={(e) => {
            e.preventDefault();
            if (date) onSet(date);
          }}
        >
          <span className="chip" style={{ alignSelf: "center", justifySelf: "start" }}>{value ? "改日期" : "回填"}</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <span />
          <button className="btn btn-sm" disabled={!date}>記錄</button>
        </form>
      )}
    </>
  );
}

function NoteForm({ onAdd }: { onAdd: (date: string, text: string) => Promise<void> }) {
  const [date, setDate] = useState(todayIn());
  const [text, setText] = useState("");
  return (
    <form
      className="issueform"
      onSubmit={async (e) => {
        e.preventDefault();
        // 畫面上已經先加上去了,欄位馬上清空可以接著記下一筆
        setText("");
        void onAdd(date, text);
      }}
    >
      <span className="chip" style={{ alignSelf: "center", justifySelf: "start" }}>新增</span>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      <input placeholder="例如：廠商資料處理中、已審，廠商修正中" value={text} onChange={(e) => setText(e.target.value)} required />
      <button className="btn btn-sm" disabled={!date || !text.trim()}>記錄</button>
    </form>
  );
}

function IssueForm({ dept, onAdd }: { dept: "RD" | "QA"; onAdd: (date: string, note: string) => Promise<void> }) {
  const [date, setDate] = useState(todayIn());
  const [note, setNote] = useState("");
  return (
    <form
      className="issueform"
      onSubmit={async (e) => {
        e.preventDefault();
        setNote("");
        void onAdd(date, note);
      }}
    >
      <span className="chip" style={{ alignSelf: "center", justifySelf: "start" }}>{dept} 新增</span>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      <input placeholder="給供應商的問題（選填）" value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn btn-sm" disabled={!date}>記錄</button>
    </form>
  );
}

