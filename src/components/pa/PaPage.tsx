"use client";

/** 沒登入時 API 回 401,paClient 會把整頁導去 /pa/login,所以這裡直接掛載內容。 */
export default function PaPage({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
