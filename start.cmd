@echo off
rem ELECTRON_RUN_AS_NODE makes the electron binary behave as plain node and the
rem app dies before it can open a window -- clear it no matter who set it.
set ELECTRON_RUN_AS_NODE=
set ELECTRON_FORCE_RENDERER_ACCESSIBILITY=
cd /d "%~dp0"
rem Keep Electron's profile next to the project so the panel is portable.
start "" node_modules\electron\dist\electron.exe . --no-sandbox --disable-gpu --user-data-dir="%~dp0.userdata"
