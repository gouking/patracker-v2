// 帳號與登入的檢查:註冊、登入、忘記/重設密碼、改密碼、登出、速率限制、使用者管理。
//
// 直接呼叫 route handler(不必開伺服器),全部在暫時資料夾的 SQLite 檔跑,
// 信寫進暫時的 outbox 檔,**不會碰到正式的 patracker.db、也不會真的寄信**。
//
// 跑法:npm run check:auth

import { register } from "node:module";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

register("./pa-alias-loader.mjs", import.meta.url);

const TMP = mkdtempSync(join(tmpdir(), "pa-auth-check-"));
process.env.DB_PATH = join(TMP, "patracker.db");
process.env.MAIL_OUTBOX_FILE = join(TMP, "outbox.jsonl");
process.env.NEXT_PUBLIC_APP_URL = "http://192.168.1.50:3200";
process.env.SESSION_SECRET = "auth-check-secret";

let failures = 0;
const ok = (label, cond, detail = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
};
const section = (s) => console.log(`\n${s}`);

const BASE = "http://192.168.1.50:3200";
let ipSeq = 0;

async function main() {
  const Auth = await import("../src/app/api/auth/[action]/route.ts");
  const Admin = await import("../src/app/api/pa/admin/users/route.ts");
  const { apiUser } = await import("../src/server/pa/auth.ts");
  const { db } = await import("../src/server/pa/db.ts");

  /** 每個情境用不同 IP,速率限制才不會互相影響(速率限制那段另外測)。 */
  const freshIp = () => `10.0.0.${++ipSeq}`;
  const call = async (action, body, { cookie = "", ip = freshIp(), method = "POST" } = {}) => {
    const req = new Request(`${BASE}/api/auth/${action}`, {
      method,
      headers: { "content-type": "application/json", cookie, "x-forwarded-for": ip },
      body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
    });
    const res = await (method === "POST" ? Auth.POST : Auth.GET)(req, { params: Promise.resolve({ action }) });
    const json = await res.json().catch(() => ({}));
    const set = res.headers.get("set-cookie") || "";
    const m = /pa_session=([^;]*)/.exec(set);
    return { status: res.status, json, cookie: m && m[1] ? `pa_session=${m[1]}` : "", setCookie: set };
  };
  const whoami = (cookie) => apiUser(new Request(`${BASE}/api/pa/projects`, { headers: { cookie } }));
  const admin = async (method, cookie, json) => {
    const req = new Request(`${BASE}/api/pa/admin/users`, {
      method,
      headers: { "content-type": "application/json", cookie },
      body: json ? JSON.stringify(json) : undefined,
    });
    const res = await (method === "GET" ? Admin.GET : Admin.PATCH)(req, {});
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };
  const outbox = () =>
    existsSync(process.env.MAIL_OUTBOX_FILE)
      ? readFileSync(process.env.MAIL_OUTBOX_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  const tokenFrom = (mail) => decodeURIComponent(/token=([^\s]+)/.exec(mail.text)?.[1] ?? "");

  // ---------- 註冊 ----------
  section("註冊");
  const a = await call("signup", { email: "Boss@Example.com", password: "boss-pass-1", name: "老闆" });
  ok("第一個註冊成功並登入", a.status === 200 && a.cookie, `${a.status}`);
  ok("cookie 是 HttpOnly、http 下不加 Secure", /HttpOnly/.test(a.setCookie) && !/Secure/.test(a.setCookie));
  const boss = await whoami(a.cookie);
  ok("第一個帳號是系統管理員", boss?.isAdmin === true && boss?.email === "boss@example.com", boss?.account_role);
  const u = await call("signup", { email: "worker@example.com", password: "worker-pass", name: "員工" });
  const worker = await whoami(u.cookie);
  ok("之後註冊的是一般使用者", worker?.account_role === "user", worker?.account_role);
  ok("同一個信箱不能再註冊", (await call("signup", { email: "worker@example.com", password: "xxxxxxxx", name: "x" })).status === 400);
  ok("密碼太短擋下", (await call("signup", { email: "short@example.com", password: "123", name: "x" })).status === 400);
  ok("沒填姓名擋下", (await call("signup", { email: "noname@example.com", password: "12345678", name: "" })).status === 400);

  // ---------- 匯入的帳號(沒有密碼)----------
  section("從舊系統匯入、還沒設密碼的帳號");
  const importedId = randomUUID();
  await db.run(
    "insert into users (id, email, password_hash, name, role, created_at, updated_at) values (?,?,?,?,?,?,?)",
    [importedId, "old@example.com", "none$no-password-set", "老同事", "pm", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const noPw = await call("signin", { email: "old@example.com", password: "anything" });
  ok("沒設密碼不能登入", noPw.status === 400 && !noPw.cookie);
  ok("不能用註冊搶走匯入的帳號", (await call("signup", { email: "old@example.com", password: "hijack-123", name: "x" })).status === 400);
  const before = outbox().length;
  const fp = await call("forgot-password", { email: "old@example.com" });
  const mails = outbox();
  ok("忘記密碼回應成功", fp.status === 200);
  ok("寄出一封設定密碼信給本人", mails.length === before + 1 && mails.at(-1).to === "old@example.com");
  ok("信裡連結用 APP_URL、指到 /pa/reset-password", mails.at(-1).text.includes(`${BASE}/pa/reset-password?token=`));
  const unknown = await call("forgot-password", { email: "nobody@example.com" });
  ok("不存在的信箱回應一樣(不洩漏帳號)、不寄信", unknown.status === 200 && outbox().length === before + 1);
  const token = tokenFrom(mails.at(-1));
  ok("猜錯 token 失敗", (await call("reset-password", { token: token.split(".")[0] + ".wrong", password: "new-pass-12" })).status === 400);
  ok("用信裡的 token 設定密碼", (await call("reset-password", { token, password: "new-pass-12" })).status === 200);
  ok("同一個 token 不能再用", (await call("reset-password", { token, password: "again-pass-12" })).status === 400);
  const old = await call("signin", { email: "OLD@example.com", password: "new-pass-12" });
  const oldUser = await whoami(old.cookie);
  ok("設好密碼後能登入(信箱不分大小寫)、id 與角色不變", oldUser?.id === importedId && oldUser?.account_role === "pm");

  // ---------- 登入/登出/session ----------
  section("登入、登出、session");
  ok("密碼錯誤擋下", (await call("signin", { email: "worker@example.com", password: "wrong-pass" })).status === 400);
  const s1 = await call("signin", { email: "worker@example.com", password: "worker-pass" });
  const s2 = await call("signin", { email: "worker@example.com", password: "worker-pass" });
  ok("兩個裝置都登入", Boolean(await whoami(s1.cookie)) && Boolean(await whoami(s2.cookie)));
  const sess = await call("session", undefined, { cookie: s1.cookie, method: "GET" });
  ok("GET session 回目前的人", sess.json?.data?.session?.user?.email === "worker@example.com");
  const out = await call("signout", {}, { cookie: s1.cookie });
  ok("登出清掉 cookie", /pa_session=;/.test(out.setCookie) && /Max-Age=0/.test(out.setCookie));
  ok("登出後舊 cookie 立刻失效", (await whoami(s1.cookie)) === null);
  ok("另一個裝置不受影響", Boolean(await whoami(s2.cookie)));
  ok("亂填的 cookie 不算登入", (await whoami("pa_session=abc.def.ghi")) === null);
  ok("沒 cookie 不算登入", (await whoami("")) === null);

  // ---------- 改密碼 ----------
  section("改密碼");
  const s3 = await call("signin", { email: "worker@example.com", password: "worker-pass" });
  ok("舊密碼錯誤擋下", (await call("change-password", { oldPassword: "nope", newPassword: "worker-pass-2" }, { cookie: s2.cookie })).status === 400);
  ok("沒登入不能改", (await call("change-password", { oldPassword: "worker-pass", newPassword: "worker-pass-2" })).status === 401);
  const chg = await call("change-password", { oldPassword: "worker-pass", newPassword: "worker-pass-2" }, { cookie: s2.cookie });
  ok("改密碼成功", chg.status === 200);
  ok("改密碼的這台還登入著", Boolean(await whoami(s2.cookie)));
  ok("其他裝置被登出", (await whoami(s3.cookie)) === null);
  ok("舊密碼不能再登入", (await call("signin", { email: "worker@example.com", password: "worker-pass" })).status === 400);
  ok("新密碼可以登入", (await call("signin", { email: "worker@example.com", password: "worker-pass-2" })).status === 200);

  // ---------- 速率限制 ----------
  section("速率限制");
  const ip = "10.9.9.9";
  for (let i = 0; i < 5; i++) await call("signin", { email: "worker@example.com", password: "bad" }, { ip });
  const locked = await call("signin", { email: "worker@example.com", password: "worker-pass-2" }, { ip });
  ok("同信箱+IP 錯 5 次 → 連正確密碼也先擋(429)", locked.status === 429, `${locked.status}`);
  ok("換個 IP 不受影響", (await call("signin", { email: "worker@example.com", password: "worker-pass-2" })).status === 200);

  // ---------- 使用者管理 ----------
  section("使用者管理");
  const wk = await call("signin", { email: "worker@example.com", password: "worker-pass-2" });
  ok("一般使用者看不到使用者列表(403)", (await admin("GET", wk.cookie)).status === 403);
  const list = await admin("GET", a.cookie);
  ok("管理員看得到全部帳號", list.status === 200 && list.json.users.length === 3, `${list.json.users?.length}`);
  ok("列表標出還沒設密碼的人", list.json.users.every((x) => x.no_password === 0), "(三個都已設密碼)");
  ok("一般使用者不能改角色(403)", (await admin("PATCH", wk.cookie, { id: worker.id, role: "admin" })).status === 403);
  ok("管理員把員工升成 PM Head", (await admin("PATCH", a.cookie, { id: worker.id, role: "pm_head" })).status === 200);
  ok("升級後看得到所有專案", (await whoami(wk.cookie))?.canViewAll === true);
  ok("沒有這個角色擋下", (await admin("PATCH", a.cookie, { id: worker.id, role: "god" })).status === 400);
  ok("不能把自己降級", (await admin("PATCH", a.cookie, { id: boss.id, role: "user" })).status === 400);
  ok("不能停用自己", (await admin("PATCH", a.cookie, { id: boss.id, is_active: false })).status === 400);
  ok("停用員工", (await admin("PATCH", a.cookie, { id: worker.id, is_active: false })).status === 200);
  ok("停用後他的 cookie 立刻失效", (await whoami(wk.cookie)) === null);
  ok("停用後不能登入(403)", (await call("signin", { email: "worker@example.com", password: "worker-pass-2" })).status === 403);
  ok("停用的人收不到重設密碼信", await (async () => {
    const n = outbox().length;
    await call("forgot-password", { email: "worker@example.com" });
    return outbox().length === n;
  })());
  ok("重新啟用後能登入", (await admin("PATCH", a.cookie, { id: worker.id, is_active: true })).status === 200 &&
    (await call("signin", { email: "worker@example.com", password: "worker-pass-2" })).status === 200);

  // ---------- 登出所有裝置 ----------
  section("登出所有裝置");
  const d1 = await call("signin", { email: "boss@example.com", password: "boss-pass-1" });
  const d2 = await call("signin", { email: "boss@example.com", password: "boss-pass-1" });
  await call("signout-all", {}, { cookie: d1.cookie });
  ok("兩台都被登出", (await whoami(d1.cookie)) === null && (await whoami(d2.cookie)) === null);

  console.log(failures ? `\nFAIL(${failures})` : "\nPASS");
}

main()
  .catch((e) => {
    console.error(e);
    failures++;
  })
  .finally(() => {
    try {
      rmSync(TMP, { recursive: true, force: true });
    } catch {
      /* Windows 上 SQLite 檔還被占用時刪不掉,留在暫存資料夾就好 */
    }
    process.exit(failures ? 1 : 0);
  });
