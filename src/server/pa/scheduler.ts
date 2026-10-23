// 程式內的排程:取代 web-gantt 在 Vercel 上的 Cron(vercel.json)。
//
//   每日逾期信     台北 08:00 起     → sendDigests()
//   催供應商信     台北 09:00 起     → sendSupplierChase()(週末與國定假日它自己會跳過)
//
// 做法跟舊的本機 patracker 一樣:每 10 分鐘看一次,「已經過了寄信時間、今天還沒寄」就寄。
// 不會重寄的保證在資料庫(pa_digest_log / pa_supplier_chase_log 先佔位再寄),
// 所以重啟、兩個行程同時跑、整點前後多次觸發都不會寄出第二封;主機晚開機也會補寄當天的份。
//
// **預設不啟動。** 要設 PA_SCHEDULER=1(而且是 production)才會跑,理由:
// 切換期間 Vercel 那邊還在寄信,兩邊同時寄會重複。切換當天才打開,見 CUTOVER.md。

import { TIMEZONE } from "./parts";
import { sendDigests } from "./digest";
import { sendSupplierChase } from "./supplierChase";

const DIGEST_HOUR = Number(process.env.DIGEST_HOUR ?? 8);
const CHASE_HOUR = Number(process.env.SUPPLIER_CHASE_HOUR ?? 9);
const TICK_MS = 10 * 60 * 1000;

export function hourIn(tz: string, at = new Date()): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(at)) % 24;
}

export interface Job {
  name: string;
  hour: number;
  run: () => Promise<unknown>;
}

export const JOBS: Job[] = [
  { name: "digest", hour: DIGEST_HOUR, run: () => sendDigests() },
  { name: "supplier-chase", hour: CHASE_HOUR, run: () => sendSupplierChase() },
];

/** 這一輪該跑的工作:台北時間已到點的。一個工作壞了不影響下一個。 */
export async function tick(at = new Date(), jobs: Job[] = JOBS): Promise<string[]> {
  const hour = hourIn(TIMEZONE, at);
  const ran: string[] = [];
  for (const job of jobs) {
    if (hour < job.hour) continue;
    try {
      const r = await job.run();
      ran.push(job.name);
      const n = r as { sent?: number; failed?: number };
      if (n?.sent || n?.failed) console.log(`[pa scheduler] ${job.name}`, JSON.stringify(r));
    } catch (e) {
      console.error(`[pa scheduler] ${job.name} 失敗`, e);
    }
  }
  return ran;
}

export function startScheduler() {
  const g = globalThis as unknown as { __paSchedulerTimer?: NodeJS.Timeout };
  if (g.__paSchedulerTimer) return;
  let running = false;
  const safeTick = async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } finally {
      running = false;
    }
  };
  g.__paSchedulerTimer = setInterval(safeTick, TICK_MS);
  setTimeout(safeTick, 30 * 1000); // 開機後半分鐘先跑一次(補寄關機期間漏掉的)
  console.log(`[pa scheduler] 已啟動:逾期信 ${DIGEST_HOUR}:00、催供應商信 ${CHASE_HOUR}:00(${TIMEZONE})`);
}
