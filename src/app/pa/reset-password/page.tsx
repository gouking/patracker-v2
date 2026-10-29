"use client";

// 信裡的連結點進來:設定新密碼。成功後所有裝置都要重新登入。

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

function Reset() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== again) {
      setError("兩次輸入的密碼不一樣。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } | null };
      if (res.ok) setDone(true);
      else setError(data.error?.message || `請求失敗（${res.status}）`);
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
        <h1>設定密碼</h1>
        {!token ? (
          <div className="err">連結不完整，請從信裡的連結重新點進來，或回登入頁重新申請。</div>
        ) : done ? (
          <>
            <div className="ok">密碼已設定，請用新密碼登入。</div>
            <a className="btn btn-accent" href="/pa/login">
              前往登入
            </a>
          </>
        ) : (
          <>
            <label>
              新密碼（至少 8 碼）
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} />
            </label>
            <label>
              再輸入一次
              <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required minLength={8} />
            </label>
            {error && <div className="err">{error}</div>}
            <button className="btn btn-accent" disabled={busy}>
              {busy ? "處理中…" : "設定密碼"}
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

export default function ResetPage() {
  return (
    <Suspense>
      <Reset />
    </Suspense>
  );
}
