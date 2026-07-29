@echo off
rem Affiche l'adresse publique actuelle du tunnel.
rem Elle change a chaque redemarrage du tunnel.

findstr /r /c:"https://[a-z0-9-]*\.trycloudflare\.com" "%~dp0tunnel.log" | findstr /v "Request" | more
echo.
pause
