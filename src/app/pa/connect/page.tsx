"use client";

// 個人連線金鑰:給 QA 電腦上的 map_system 這類程式用,讓它代表你讀寫 PA Tracker。
// 金鑰只在建立當下顯示一次;能做的事跟你在網頁上能做的一樣。

import { useEffect, useState } from "react";
import PaPage from "@/components/pa/PaPage";
import PaTopBar from "@/components/pa/PaTopBar";
import { api } from "@/lib/paClient";

interface TokenInfo {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("zh-TW", { hour12: false }) : "還沒用過");

function Connect() {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [name, setName] = useState("map_system");
  const [fresh, setFresh] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ tokens: TokenInfo[] }>("/api/pa/tokens").then(
      (r) => setTokens(r.tokens),
      (e) => setError(e instanceof Error ? e.message : String(e))
    );
  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string; info: TokenInfo }>("/api/pa/tokens", { json: { name } });
      setFresh(r.token);
      setCopied(false);
      setTokens((t) => [r.info, ...(t ?? [])]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: TokenInfo) {
    if (!confirm(`撤銷「${t.name}」？用這把金鑰的程式會立刻連不上。`)) return;
    try {
      await api(`/api/pa/tokens/${t.id}`, { method: "DELETE" });
      setTokens((list) => (list ?? []).filter((x) => x.id !== t.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      <PaTopBar crumb="連線金鑰" />
      <main className="page">
        <h1>連線金鑰</h1>
        <p className="lede">
          給 QA 電腦上的 <b>map_system</b>（零件承認文件審核）這類程式用：它會用你的身分從 PA Tracker 拿專案與料號，
          審完再寫回「QA 開始 review／退件／pass」。金鑰能做的事跟你在網頁上能做的一樣，修改紀錄也記在你名下。
        </p>

        {error && <div className="err">{error}</div>}

        {fresh && (
          <div className="card tokenfresh">
            <b>新金鑰（只顯示這一次，關掉就看不到了）</b>
            <div className="tokenrow">
              <code className="mono">{fresh}</code>
              <button
                className="btn btn-sm btn-accent"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(fresh);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? "已複製" : "複製"}
              </button>
            </div>
            <span className="muted">貼到 map_system 的「設定 → PA Tracker 連線」。</span>
            <button className="btn btn-sm btn-ghost" onClick={() => setFresh(null)}>我已經貼好了，關閉</button>
          </div>
        )}

        <form className="card tokenform" onSubmit={create}>
          <label>
            名稱（看得出是哪台電腦、哪個程式）
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="例如：品保 Terry 的 map_system" />
          </label>
          <button className="btn btn-accent" disabled={busy}>
            {busy ? "建立中…" : "建立金鑰"}
          </button>
        </form>

        <h2 className="tokenhead">我的金鑰</h2>
        {!tokens ? (
          <div className="muted">載入中…</div>
        ) : tokens.length === 0 ? (
          <div className="card empty">還沒有金鑰。</div>
        ) : (
          <div className="card tokenlist">
            {tokens.map((t) => (
              <div key={t.id} className="tokenitem">
                <div>
                  <b>{t.name}</b>
                  <div className="muted">
                    建立 {when(t.created_at)}・最後使用 {when(t.last_used_at)}
                  </div>
                </div>
                <button className="btn btn-sm btn-ghost btn-danger" onClick={() => revoke(t)}>
                  撤銷
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}

export default function ConnectPage() {
  return (
    <PaPage>
      <Connect />
    </PaPage>
  );
}
