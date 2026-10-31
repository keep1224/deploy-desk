@echo off
rem electron-builder and the electron downloader default to %LOCALAPPDATA%, which
rem some machines deny to the app-builder subprocess. Keep every cache inside the
rem project instead, and pull binaries from a mirror that is reachable here.
set ELECTRON_CACHE=%~dp0.electron-cache
set ELECTRON_BUILDER_CACHE=%~dp0.builder-cache
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
cd /d "%~dp0"
call npx electron-builder --win --publish never
