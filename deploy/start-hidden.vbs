' Lance un script .cmd du dossier sans afficher de fenêtre de console.
' Utilisé par les tâches planifiées pour que YouSeal tourne discrètement.
'
'   wscript start-hidden.vbs          -> start.cmd        (le service)
'   wscript start-hidden.vbs tunnel   -> start-tunnel.cmd (le tunnel Cloudflare)

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

target = "start.cmd"
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "tunnel" Then target = "start-tunnel.cmd"
End If

script = fso.GetParentFolderName(WScript.ScriptFullName) & "\" & target
shell.Run """" & script & """", 0, False
