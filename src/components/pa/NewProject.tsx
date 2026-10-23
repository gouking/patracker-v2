"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/paClient";

export default function NewProject() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { project } = await api<{ project: { id: string } }>("/api/pa/projects", { method: "POST", json: { name, code } });
      router.push(`/pa/p/${project.id}/import`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form className="card newproj" onSubmit={submit}>
      <b>新專案</b>
      <input placeholder="專案名稱，例如 XT" value={name} onChange={(e) => setName(e.target.value)} required />
      <input placeholder="代號（選填）" value={code} onChange={(e) => setCode(e.target.value)} style={{ flex: "0 1 160px" }} />
      <button className="btn btn-accent" disabled={busy || !name.trim()}>
        {busy ? "建立中…" : "建立並匯入 BOM"}
      </button>
      {error && <div className="err" style={{ flexBasis: "100%" }}>{error}</div>}
    </form>
  );
}
