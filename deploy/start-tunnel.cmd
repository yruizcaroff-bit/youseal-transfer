@echo off
rem Tunnel Cloudflare nomme « youseal » : expose https://youseal.site sans
rem ouvrir le moindre port sur la box. La connexion part d'ici vers Cloudflare,
rem qui fournit et renouvelle le certificat HTTPS.
rem
rem La configuration (domaines desservis) est dans tunnel-config.yml.

cd /d "%~dp0"
"%~dp0cloudflared.exe" tunnel --no-autoupdate --config "%~dp0tunnel-config.yml" run youseal > "%~dp0tunnel.log" 2>&1
