@echo off
rem Daily backup of data\patracker.db (see scripts\backup-db.mjs).
rem Template: change the folder and node.exe paths to the new host's, then
rem schedule it daily, e.g. (as the user who runs PA Tracker):
rem   schtasks /create /tn patracker-backup /sc daily /st 03:00 /tr "D:\Claude\patracker-v2\scripts\backup-patracker.cmd"
cd /d "D:\Claude\patracker-v2"
"C:\Users\Alec\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.19.0-win-x64\node.exe" scripts\backup-db.mjs >> "D:\Claude\patracker-v2\backup.log" 2>&1
