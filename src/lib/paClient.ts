// PA Tracker 的瀏覽器端呼叫:統一處理錯誤訊息。
//
// 登入是 Trackly 發的 cookie(同網域,fetch 自動帶),不需要自己放 Authorization。
// 401 = 沒登入或過期 → 導去 /api/login-redirect,它會轉去 Trackly 登入、登入後回到這一頁。

function toLogin(): never {
  window.location.href = `/api/login-redirect?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  throw new Error("登入已過期");
}

export async function api<T>(url: string, opts: { method?: string; json?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.json || opts.form ? "POST" : "GET"),
    headers: {
      ...(opts.json !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
    cache: "no-store",
  });
  if (res.status === 401) toLogin();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `請求失敗（${res.status}）`);
  return data as T;
}

/** 下載(匯出 Excel)。 */
export async function download(url: string, fallbackName: string): Promise<void> {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 401) toLogin();
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `下載失敗（${res.status}）`);
  }
  const cd = res.headers.get("content-disposition") || "";
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const name = star ? decodeURIComponent(star[1]) : fallbackName;
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** 2026-05-08 → 26/05/08（表格窄欄用） */
export function shortDate(d: string | null): string {
  return d ? `${d.slice(2, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}` : "";
}
