' Lance start.cmd sans fenêtre de console.
' Utilisé par la tâche planifiée pour que YouSeal tourne discrètement.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
script = fso.GetParentFolderName(WScript.ScriptFullName) & "\start.cmd"
shell.Run """" & script & """", 0, False
