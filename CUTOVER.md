# 切換清單(web-gantt /pa → 新主機的 patracker-v2,PA 單獨搬、不依賴 Trackly)

信件有兩個來源:Vercel Cron(舊)與本站的 `PA_SCHEDULER`(新)。**同一時間只能開一個**,不然使用者會收到兩封。

## 切換前(任何時候都可以做)
1. 新主機照下面「新主機安裝」裝好,`.env.local` 照 `.env.example` 填好,**`PA_SCHEDULER` 先留空**。
2. `npm run build`、`npm start`,開 `http://tpp1131.contoso.com/pa/login`:
   用「忘記密碼/第一次登入」收信設定你自己的密碼 → 登入看得到專案與料號。
3. SMTP 測試:上一步收得到設定密碼信就是通了;也可 `POST /api/pa/supplier-chase {"to":"自己的信箱"}`(admin)。

## 切換當天(下班後做,約 20 分鐘)
1. web-gantt 的 `/pa` 讓使用者停止編輯(通知同事),再手動取最新備份:
   `D:\Claude\web-gantt-backups\backup.ps1`(或等 03:00 的)。
2. 匯入最新資料(PA 整份覆蓋;帳號只新增/更新、不刪,已設的密碼保留):
   `node --experimental-strip-types --no-warnings scripts/import-pa-dump.mjs <最新 dump>`
   → 末尾每張表的筆數都要沒有 ✗,「對不到帳號的」要是 0。
3. 停掉 Vercel 的 PA 寄信:移除 `web-gantt/vercel.json` 裡 `/api/pa/digest` 與 `/api/pa/supplier-chase` 兩個 cron 並部署
   (`/api/reminders` 是甘特圖的提醒,不要動)。
4. 新主機設 `PA_SCHEDULER=1` 後重啟。log 會出現「[pa scheduler] 已啟動」。
5. 通知同事新網址 `http://tpp1131.contoso.com/pa`(web-gantt 首頁的 PA Tracker 連結已指到這裡),**第一次登入按「忘記密碼/第一次登入」收信設定密碼**;
   web-gantt 的 `/pa` 與首頁 PA 摘要加一個「已搬家」公告(那邊的數字會停在搬家那一刻)。

## 退路
舊的 Vercel 版資料沒有被動過,隨時可以:關 `PA_SCHEDULER`、把 cron 加回 `vercel.json`。
但切換後在新站填的資料不會回流到 Supabase。

## 新主機安裝(一次性)
1. 裝 Node 24(要有內建的 `node:sqlite`)。
2. `git clone https://github.com/gouking/patracker-v2.git`,
   再把舊電腦的 `data/` 資料夾複製過去(資料庫不在 GitHub 上),`npm ci`,`npm run build`。
   之後改程式:push → 新主機 `git pull`、`npm ci`、`npm run build`、重啟。
3. `.env.local` 照 `.env.example` 填:`SESSION_SECRET`(新產生一把隨機值)、`NEXT_PUBLIC_APP_URL`、`SMTP_*`。
4. 開機自動啟動:`scripts/start-patracker.cmd` 與 `.vbs` 是範本,**裡面的 node 與資料夾路徑要改成新主機的**,再用工作排程在登入時執行。port 80(`npm start` 也是 80;開發用 `npm run dev` 仍是 3200)。先確認 80 沒被佔用:`netstat -ano | findstr ":80 "`,有 IIS/其他網站要先停掉。
5. 內網直連(不用 Cloudflare):新主機設固定 IP(路由器 DHCP 保留),防火牆開 80(系統管理員):
   `netsh advfirewall firewall add rule name="PA Tracker" dir=in action=allow protocol=TCP localport=80`
   只有內網連得到;http 下 cookie 不加 Secure。
6. 每日備份:`scripts/backup-patracker.cmd` 是範本(路徑改成新主機的),再排程每天 03:00 跑:
   `schtasks /create /tn patracker-backup /sc daily /st 03:00 /tr "<專案資料夾>\scripts\backup-patracker.cmd"`
   備份放在專案旁邊的 `patracker-backups`(可用 `PA_BACKUP_DIR` 改,最好指到另一顆硬碟或 NAS),保留 30 份,
   結果寫在 `backup.log`。手動跑:`npm run backup`。網站開著也能備份(用 VACUUM INTO,不是直接複製檔案)。
   還原:停網站 → 移走 `data/patracker.db`、`-wal`、`-shm` → 把備份檔複製成 `data/patracker.db` → 啟動。

## 帳號
- 自己的帳號系統(`users`/`sessions` 在 patracker.db),cookie 叫 `pa_session`,跟同主機的 Trackly 互不干擾。
- 開放註冊:新註冊的是一般使用者,要專案 PM 把人加進專案才看得到東西;資料庫裡第一個帳號自動是管理員。
- 從 web-gantt 匯入的帳號沒有密碼,本人用「忘記密碼/第一次登入」設定(設定信 1 小時內有效)。
- 管理員在 `/pa/users` 改角色(PM Head = 看所有專案)、停用帳號(立刻登出、連線金鑰也失效)。
- 檢查:`npm run check:auth`(50 項,暫時資料庫,不寄信)。

## 已知限制
- 「預約 owner」(邀請還沒建帳號的人)停用:沒有邀請系統,請對方先自行註冊。
- 沒有 Email 驗證:註冊時填錯信箱就收不到重設信,要管理員停用後請本人重新註冊。
- 切換後新站的資料不會回流到 Supabase。
