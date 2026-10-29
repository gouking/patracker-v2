"use client";

// 登入/註冊/忘記密碼。登入後回到 ?next= 指的那一頁(只接受本站路徑)。

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";

type Mode = "signin" | "signup" | "forgot";

const safeNext = (raw: string | null) => (raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/pa");

async function post(action: string, body: unknown): Promise<string | null> {
  const res = await fetch(`/api/auth/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } | null };
  return res.ok ? null : data.error?.message || `請求失敗（${res.status}）`;
}

function Login() {
  const next = safeNext(useSearchParams().get("next"));
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  function go(m: Mode) {
    setMode(m);
    setError(null);
    setSent(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "forgot") {
        const err = await post("forgot-password", { email });
        if (err) setError(err);
        else setSent(true);
        return;
      }
      const err = await post(mode, mode === "signup" ? { email, password, name } : { email, password });
      if (err) setError(err);
      else window.location.href = next;
    } finally {
      setBusy(false);
    }
  }

  const title = mode === "signin" ? "登入" : mode === "signup" ? "註冊新帳號" : "忘記密碼／第一次登入";

  return (
    <div className="authwrap">
      <form className="card authbox" onSubmit={submit}>
        <div className="brand">
          <span className="mark" />
          PA Tracker
        </div>
        <h1>{title}</h1>

        {mode === "forgot" && (
          <p className="authnote">
            輸入你的公司信箱，我們會寄一封設定密碼的信（1 小時內有效）。
            從舊系統搬過來的帳號，第一次登入也請用這裡設定密碼。
          </p>
        )}

        {mode === "signup" && (
          <label>
            姓名
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={60} />
          </label>
        )}
        <label>
          電子郵件
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        {mode !== "forgot" && (
          <label>
            密碼{mode === "signup" && "（至少 8 碼）"}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
              required
              minLength={mode === "signup" ? 8 : undefined}
            />
          </label>
        )}

        {error && <div className="err">{error}</div>}
        {sent && <div className="ok">如果這個信箱有帳號，設定密碼的信已經寄出，請到信箱收信。</div>}

        <button className="btn btn-accent" disabled={busy || sent}>
          {busy ? "處理中…" : mode === "signin" ? "登入" : mode === "signup" ? "註冊並登入" : "寄設定密碼信"}
        </button>

        <div className="authlinks">
          {mode !== "signin" && (
            <button type="button" onClick={() => go("signin")}>
              ← 回登入
            </button>
          )}
          {mode === "signin" && (
            <>
              <button type="button" onClick={() => go("forgot")}>
                忘記密碼／第一次登入
              </button>
              <button type="button" onClick={() => go("signup")}>
                註冊新帳號
              </button>
            </>
          )}
        </div>
        {mode === "signup" && <p className="authnote">新帳號註冊後還看不到專案，要請專案 PM 把你加進專案。</p>}
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}
