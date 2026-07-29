@echo off
rem Démarrage de YouSeal sur cette machine.
rem Les chemins sont relatifs à ce script : le dossier peut être déplacé.

cd /d "%~dp0.."

rem --- Réglages par défaut -------------------------------------------------
rem HOST=127.0.0.1 : Node n'écoute que localement, seul le proxy (Caddy) le
rem joint. Mettre 0.0.0.0 pour tester depuis un autre appareil du réseau local.
set "HOST=127.0.0.1"
set "PORT=3000"
set "STORAGE_DIR=%~dp0..\storage"

rem Capacité totale du service, en octets (30 Go par défaut).
set "MAX_STORAGE=30000000000"

rem Derrière Caddy, décommenter les deux lignes suivantes :
rem set "TRUST_PROXY=1"
rem set "PUBLIC_URL=https://youseal.site"

rem --- Secrets et surcharges locales (non versionné) -----------------------
if exist "%~dp0env.cmd" call "%~dp0env.cmd"

node server.js
