@echo off
rem ELECTRON_RUN_AS_NODE makes the electron binary behave as plain node and the
rem app dies before it can open a window -- clear it no matter who set it.
set ELECTRON_RUN_AS_NODE=
set ELECTRON_FORCE_RENDERER_ACCESSIBILITY=
rem Repair a half-installed electron first (pnpm >= 10 skips its install script);
rem keep the download cache inside the project like build.cmd does.
set ELECTRON_CACHE=%~dp0.electron-cache
if not exist node_modules\electron\dist\electron.exe (
  echo [deploy-desk] electron 未安装完整，先补装...
  node node_modules\electron\install.js || (echo [deploy-desk] 补装失败，请运行 npm install 重试 & pause & exit /b 1)
)
cd /d "%~dp0"
rem Keep Electron's profile next to the project so the panel is portable.
start "" node_modules\electron\dist\electron.exe . --no-sandbox --disable-gpu --user-data-dir="%~dp0.userdata"
