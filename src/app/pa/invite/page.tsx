"use client";

// 邀請信上的連結落在這裡:看到是誰邀請、加進哪裡,設好名字和密碼就建好帳號並登入。

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface Info {
  email: string;
  name: string;
  inviter: string;
  where: string;
  hasAccount: boolean;
}

function Invite() {
  const token = useSearchParams().get("t") ?? "";
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/invite/accept?t=${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) setError(d.error || "這個邀請連結無效");
        else {
          setInfo(d as Info);
          setName((d as Info).name || "");
        }
      })
      .catch(() => !cancelled && setError("連不上伺服器,請稍後再試。"));
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== again) return setError("兩次輸入的密碼不一樣。");
    setBusy(true);
    try {
      const res = await fetch("/api/invite/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t: token, name, password }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) return setError(d.error || `請求失敗（${res.status}）`);
      window.location.href = d.next || "/pa";
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="authwrap">
      <form className="card authbox" onSubmit={submit}>
        <div className="brand">
          <span className="mark" />
          PA Tracker
        </div>
        <h1>接受邀請</h1>
        {!token ? (
          <div className="err">連結不完整，請從信裡的連結重新點進來。</div>
        ) : !info ? (
          error ? <div className="err">{error}</div> : <p>載入中…</p>
        ) : info.hasAccount ? (
          <div className="ok">
            這個信箱已經有帳號了，直接登入就好。
            <a className="btn btn-accent" href="/pa/login" style={{ marginLeft: 8 }}>
              前往登入
            </a>
          </div>
        ) : (
          <>
            <p>{info.inviter || "專案 PM"} 邀請你加入 {info.where}</p>
            <label>
              電子郵件
              <input type="email" value={info.email} disabled />
            </label>
            <label>
              你的名字
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </label>
            <label>
              設定密碼（至少 8 碼）
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} />
            </label>
            <label>
              再輸入一次
              <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required minLength={8} />
            </label>
            {error && <div className="err">{error}</div>}
            <button className="btn btn-accent" disabled={busy}>
              {busy ? "處理中…" : "建立帳號並登入"}
            </button>
          </>
        )}
        <div className="authlinks">
          <a href="/pa/login">← 回登入</a>
        </div>
      </form>
    </div>
  );
}

export default function InvitePage() {
  return (
    <Suspense>
      <Invite />
    </Suspense>
  );
}
