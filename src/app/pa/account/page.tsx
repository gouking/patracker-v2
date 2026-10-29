"use client";

// 帳號設定:改密碼、登出所有裝置。

import { useEffect, useState } from "react";
import PaPage from "@/components/pa/PaPage";
import PaTopBar from "@/components/pa/PaTopBar";

interface Me {
  id: string;
  email: string;
  name: string;
  role: string;
}

async function post(action: string, body?: unknown): Promise<string | null> {
  const res = await fetch(`/api/auth/${action}`, {
    method: "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    window.location.href = "/pa/login?next=/pa/account";
    return "請先登入";
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } | null };
  return res.ok ? null : data.error?.message || `請求失敗（${res.status}）`;
}

function Account() {
  const [me, setMe] = useState<Me | null>(null);
  const [oldPassword, setOld] = useState("");
  const [newPassword, setNew] = useState("");
  const [again, setAgain] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { data?: { session?: { user: Me } | null } }) => {
        if (d.data?.session) setMe(d.data.session.user);
        else window.location.href = "/pa/login?next=/pa/account";
      })
      .catch(() => {});
  }, []);

  async function change(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== again) {
      setMsg({ ok: false, text: "兩次輸入的新密碼不一樣。" });
      return;
    }
    setBusy(true);
    setMsg(null);
    const err = await post("change-password", { oldPassword, newPassword });
    setBusy(false);
    if (err) setMsg({ ok: false, text: err });
    else {
      setMsg({ ok: true, text: "密碼已更新。其他裝置已登出，這台電腦維持登入。" });
      setOld("");
      setNew("");
      setAgain("");
    }
  }

  async function signOutAll() {
    if (!confirm("登出所有裝置（包含這台）？")) return;
    await post("signout-all");
    window.location.href = "/pa/login";
  }

  return (
    <>
      <PaTopBar me={me ? { name: me.name || me.email, isAdmin: me.role === "admin" } : null} crumb="帳號設定" />
      <main className="page">
        <h1>帳號設定</h1>
        {me && (
          <p className="lede">
            {me.name}（{me.email}）
          </p>
        )}
        <div className="acctgrid">
          <form className="card" onSubmit={change}>
            <b>修改密碼</b>
            <label>
              目前的密碼
              <input type="password" value={oldPassword} onChange={(e) => setOld(e.target.value)} autoComplete="current-password" required />
            </label>
            <label>
              新密碼（至少 8 碼）
              <input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} autoComplete="new-password" required minLength={8} />
            </label>
            <label>
              再輸入一次新密碼
              <input type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required minLength={8} />
            </label>
            {msg && <div className={msg.ok ? "ok" : "err"}>{msg.text}</div>}
            <button className="btn btn-accent" disabled={busy}>
              {busy ? "處理中…" : "更新密碼"}
            </button>
          </form>
          <div className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
            <b>登出所有裝置</b>
            <span className="muted">懷疑密碼外流、或在別人電腦上登入過忘了登出時使用。</span>
            <button className="btn btn-danger" onClick={signOutAll}>
              登出所有裝置
            </button>
          </div>
        </div>
      </main>
    </>
  );
}

export default function AccountPage() {
  return (
    <PaPage>
      <Account />
    </PaPage>
  );
}
