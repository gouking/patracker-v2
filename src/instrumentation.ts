// 伺服器啟動時掛上排程(每日逾期信、催供應商信)。
// 只在 production 且明確設了 PA_SCHEDULER=1 才跑:開發模式不會一直寄信,
// 切換期間舊系統還在寄的時候也不會重複(見 CUTOVER.md)。

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "production" || process.env.PA_SCHEDULER !== "1") return;
  const { startScheduler } = await import("./server/pa/scheduler");
  startScheduler();
}
