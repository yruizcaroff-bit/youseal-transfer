@echo off
rem Tunnel Cloudflare : expose le service sur Internet en HTTPS, sans ouvrir
rem le moindre port sur la box. La connexion part d'ici vers Cloudflare.
rem
rem L'adresse publique est tiree au hasard et change a chaque demarrage ;
rem elle est ecrite dans tunnel.log.

cd /d "%~dp0"
"%~dp0cloudflared.exe" tunnel --url http://127.0.0.1:3000 --no-autoupdate > "%~dp0tunnel.log" 2>&1
