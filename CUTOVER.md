# 切換清單(web-gantt /pa → 新主機的 patracker-v2)

信件有兩個來源:Vercel Cron(舊)與本站的 `PA_SCHEDULER`(新)。**同一時間只能開一個**,不然使用者會收到兩封。

## 切換前(任何時候都可以做)
1. 新主機放好 Trackly(已用同一份備份匯入),`.env.local` 照 `.env.example` 填好,**`PA_SCHEDULER` 先留空**。
2. `npm run build`、`npm start`,用真實帳號登入看得到專案與料號。
3. SMTP 測試:`POST /api/pa/supplier-chase {"to":"自己的信箱"}`(admin)能收到測試信。

## 切換當天(下班後做,約 20 分鐘)
1. web-gantt 的 `/pa` 讓使用者停止編輯(通知同事),再手動取最新備份:
   `D:\Claude\web-gantt-backups\backup.ps1`(或等 03:00 的)。
2. 匯入最新資料(整份覆蓋):
   `node --experimental-strip-types --no-warnings scripts/import-pa-dump.mjs <最新 dump>`
   → 末尾每張表的筆數都要沒有 ✗。
3. 停掉 Vercel 的 PA 寄信:移除 `web-gantt/vercel.json` 裡 `/api/pa/digest` 與 `/api/pa/supplier-chase` 兩個 cron 並部署
   (`/api/reminders` 是甘特圖的提醒,不要動)。
4. 新主機設 `PA_SCHEDULER=1` 後重啟。log 會出現「[pa scheduler] 已啟動」。
5. 通知同事新網址 `http://新主機IP:3000`(甘特圖)、`:3200/pa`(PA);web-gantt 的 `/pa` 加一個「已搬家」公告。

## 退路
舊的 Vercel 版資料沒有被動過,隨時可以:關 `PA_SCHEDULER`、把 cron 加回 `vercel.json`、把網域指回去。
但切換後在新站填的資料不會回流到 Supabase。

## 新主機安裝(一次性)
1. 裝 Node 24(要有內建的 `node:sqlite`)。
2. `git clone https://github.com/aleckuab/patracker-v2.git`(Trackly 同樣 clone `aleckuab/trackly`),
   再把舊電腦的 `data/` 資料夾複製過去(資料庫不在 GitHub 上),`npm ci`,`npm run build`。
   之後改程式:push → 新主機 `git pull`、`npm ci`、`npm run build`、重啟。
3. `.env.local` 照 `.env.example` 填:`SESSION_SECRET` 要跟 Trackly **一字不差**,`TRACKLY_DB` 指到同一台機器上 Trackly 的 `trackly.db`。
4. 先啟動升級後的 Trackly 並打一個 API(sessions 表第一次存取才建),再啟動本站。順序反了所有人都會被擋(故意 fail closed)。
5. 開機自動啟動:`scripts/start-patracker.cmd` 與 `.vbs` 是範本,**裡面的 node 與資料夾路徑要改成新主機的**,再用工作排程在登入時執行。port 3200。
6. 內網直連(不用 Cloudflare):新主機設固定 IP(路由器 DHCP 保留),防火牆開 3000、3200(系統管理員):
   `netsh advfirewall firewall add rule name="Trackly+PA" dir=in action=allow protocol=TCP localport=3000,3200`
   兩邊 `.env.local` 的 `TRACKLY_URL` / `APP_URL` / `NEXT_PUBLIC_APP_URL` 都填 `http://新主機IP:port`。
   http + IP 時 cookie 不加 Secure、不分 port,所以 3000 與 3200 共用同一個登入。只有內網連得到。
7. 備份:整個 `data/` 資料夾(patracker.db 與 -wal/-shm)。每日備份要自己加(舊版靠 Supabase 的 pg_dump 排程)。

## 已知限制
- 「預約 owner」(邀請還沒建帳號的人)停用:Trackly 沒有邀請系統。
- 本站不發登入、不存密碼;帳號、改密碼、停用都在 Trackly。
- 切換後新站的資料不會回流到 Supabase。
