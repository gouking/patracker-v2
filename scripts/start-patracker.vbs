' Starts PA Tracker (Next.js production, port 3200) with no console window.
' Called by the "patracker-v2-local-autostart" scheduled task at logon.
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c ""D:\Claude\patracker-v2\scripts\start-patracker-v2.cmd""", 0, False
