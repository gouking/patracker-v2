"use client";

// 顯示設定:背景(跟隨系統／淺色／深色)與文字大小。存在這個瀏覽器的 localStorage,
// 換電腦要重選。頁面載入時由 pa/layout.tsx 的小段 script 先套用,避免閃一下白底。

import { useEffect, useRef, useState } from "react";

type Theme = "auto" | "light" | "dark";

const THEMES: { key: Theme; label: string }[] = [
  { key: "auto", label: "跟隨系統" },
  { key: "light", label: "白底" },
  { key: "dark", label: "黑底" },
];
const SIZES: { key: number; label: string }[] = [
  { key: 0.9, label: "小" },
  { key: 1, label: "標準" },
  { key: 1.15, label: "大" },
  { key: 1.3, label: "特大" },
];

const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* 瀏覽器不讓存就只在這次有效 */
  }
};

export default function DisplaySettings() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("auto");
  const [size, setSize] = useState(1);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = read("pa-theme");
    if (t === "light" || t === "dark") setTheme(t);
    const z = parseFloat(read("pa-zoom") ?? "");
    if (SIZES.some((s) => s.key === z)) setSize(z);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pickTheme(t: Theme) {
    setTheme(t);
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    write("pa-theme", t === "auto" ? null : t);
  }
  function pickSize(z: number) {
    setSize(z);
    document.documentElement.style.setProperty("--pa-zoom", String(z));
    write("pa-zoom", z === 1 ? null : String(z));
  }

  return (
    <div className="dispset" ref={box}>
      <button
        className="btn btn-ghost btn-sm"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="文字大小、白底／黑底"
        onClick={() => setOpen((v) => !v)}
      >
        Aa
      </button>
      {open && (
        <div className="dispset-pop" role="dialog" aria-label="顯示設定">
          <div className="dispset-h">背景</div>
          <div className="dispset-row">
            {THEMES.map((t) => (
              <button key={t.key} className={`dispset-opt${theme === t.key ? " on" : ""}`} aria-pressed={theme === t.key} onClick={() => pickTheme(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="dispset-h">文字大小</div>
          <div className="dispset-row">
            {SIZES.map((s) => (
              <button key={s.key} className={`dispset-opt${size === s.key ? " on" : ""}`} aria-pressed={size === s.key} onClick={() => pickSize(s.key)}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="dispset-note">只影響這台電腦的這個瀏覽器。</div>
        </div>
      )}
    </div>
  );
}
