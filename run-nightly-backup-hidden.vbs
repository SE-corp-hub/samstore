' What the daily scheduled task runs: the same backup as run-nightly-backup.bat, with no window.
' A failed backup still shows a "Samstore backup" message box, and the log is in backups\backup-log.txt.
Set sh = CreateObject("WScript.Shell")
here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WScript.Quit sh.Run("""" & here & "\run-nightly-backup.bat""", 0, True)
