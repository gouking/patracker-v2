@echo off
rem Starts PA Tracker (Next.js production, port 3200). Called by the
rem "patracker-v2-local-autostart" scheduled task at logon.
cd /d "D:\Claude\patracker-v2"
"C:\Users\Alec\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\node.exe" node_modules\next\dist\bin\next start -p 3200 > "D:\Claude\patracker-v2\server.log" 2>&1
