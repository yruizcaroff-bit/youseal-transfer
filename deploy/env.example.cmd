@echo off
rem Modèle de configuration locale.
rem Copier en env.cmd et compléter — env.cmd n'est pas versionné.

rem Jeton de modération, à générer aléatoirement :
rem   powershell -c "-join ((1..32) | %% { '{0:x2}' -f (Get-Random -Max 256) })"
set "ADMIN_TOKEN="

rem Décommenter une fois le service exposé derrière Caddy :
rem set "TRUST_PROXY=1"
rem set "PUBLIC_URL=https://youseal.site"
