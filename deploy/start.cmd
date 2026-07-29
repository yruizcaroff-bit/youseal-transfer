@echo off
rem Démarrage de YouSeal sur cette machine.
rem Les chemins sont relatifs à ce script : le dossier peut être déplacé.

cd /d "%~dp0.."

rem --- Réglages par défaut -------------------------------------------------
rem HOST=127.0.0.1 : Node n'écoute que localement. Seul le tunnel Cloudflare
rem le joint, ce qui évite toute exposition directe de la machine.
set "HOST=127.0.0.1"
set "PORT=3000"
set "STORAGE_DIR=%~dp0..\storage"

rem Capacité totale du service : 800 Go.
rem Le disque D: en compte environ 812 de libres : la marge est mince. Un
rem disque plein empêcherait aussi l'écriture des métadonnées et des compteurs,
rem donc surveiller l'espace restant.
set "MAX_STORAGE=858993459200"

rem Un fichier ne peut à lui seul dépasser 100 Go, ni un transfert 200 Go.
set "MAX_FILE_SIZE=107374182400"
set "MAX_TRANSFER_SIZE=214748364800"

rem --- Secrets et surcharges locales (non versionné) -----------------------
if exist "%~dp0env.cmd" call "%~dp0env.cmd"

node server.js
