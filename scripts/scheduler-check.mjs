// 排程邏輯檢查:時間到了才跑、沒到不跑、一個壞了不影響另一個。不寄信、不碰資料庫。
import { register } from "node:module";
register("./pa-alias-loader.mjs", import.meta.url);
process.env.DB_PATH = ":memory:";
const { tick, hourIn } = await import("../src/server/pa/scheduler.ts");

let failures = 0;
const ok = (label, cond) => { if (!cond) failures++; console.log(`  ${cond ? "✓" : "✗"} ${label}`); };
const at = (h) => new Date(`2026-10-26T${String(h).padStart(2, "0")}:05:00+08:00`); // 台北 h 點 05 分
const calls = [];
const jobs = [
  { name: "a", hour: 8, run: async () => { calls.push("a"); return { sent: 0 }; } },
  { name: "b", hour: 9, run: async () => { calls.push("b"); throw new Error("boom"); } },
  { name: "c", hour: 9, run: async () => { calls.push("c"); return {}; } },
];
ok("hourIn 用台北時區", hourIn("Asia/Taipei", at(8)) === 8 && hourIn("Asia/Taipei", at(0)) === 0);
console.error = () => {};
ok("07:05 什麼都不跑", (await tick(at(7), jobs)).length === 0);
ok("08:05 只跑 08:00 的", (await tick(at(8), jobs)).join() === "a");
calls.length = 0;
ok("09:05 兩個都到點;b 壞了 c 照跑", (await tick(at(9), jobs)).join() === "a,c" && calls.join() === "a,b,c");
ok("半夜 00:05 不跑(當天還沒到點)", (await tick(at(0), jobs)).length === 0);
console.log(failures ? `\nFAIL(${failures})` : "\nPASS");
process.exit(failures ? 1 : 0);
