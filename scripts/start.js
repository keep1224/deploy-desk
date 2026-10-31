// Dev launcher: `npm start` -> `node scripts/start.js`.
//
// Two things keep a plain `electron .` from working in every shell:
//   1. ELECTRON_RUN_AS_NODE=1 (sometimes injected by the surrounding
//      environment) turns the electron binary into plain node, so the main
//      process dies before it can open a window.
//   2. pnpm >= 10 skips dependency build scripts, so a fresh `pnpm install`
//      leaves node_modules/electron without its dist/ download.
// This script clears (1) and repairs (2) before starting the app.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const exe = electronBinary();

function electronPackageDir() {
  return path.dirname(require.resolve('electron/package.json', { paths: [root] }));
}

function electronBinary() {
  const pkgDir = electronPackageDir();
  const pathFile = path.join(pkgDir, 'path.txt');
  if (!fs.existsSync(pathFile)) return null;
  const bin = path.join(pkgDir, 'dist', fs.readFileSync(pathFile, 'utf8').trim());
  return fs.existsSync(bin) ? bin : null;
}

if (!exe) {
  console.error('[deploy-desk] Electron 二进制未下载，正在补装（首次需要下载约 100MB）...');
  const env = {
    ...process.env,
    // Keep the download cache inside the project: some sandboxes and locked
    // down profiles refuse to create %LOCALAPPDATA%\electron.
    ELECTRON_CACHE: path.join(root, '.electron-cache'),
    electron_config_cache: path.join(root, '.electron-cache'),
  };
  fs.mkdirSync(env.ELECTRON_CACHE, { recursive: true });
  const r = spawnSync(process.execPath, [path.join(electronPackageDir(), 'install.js')], {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('[deploy-desk] Electron 安装失败。可手动执行: node node_modules/electron/install.js');
    process.exit(r.status || 1);
  }
}

const bin = exe || electronBinary();
if (!bin) {
  console.error('[deploy-desk] 仍然找不到 node_modules/electron/dist 下的可执行文件，请删除 node_modules 后重装。');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_FORCE_RENDERER_ACCESSIBILITY;

const args = [
  root,
  // The bundled Chromium sandbox and the GPU process both refuse to start in
  // some containerized / remote-desktop sessions; the panel does not need them.
  '--no-sandbox',
  '--disable-gpu',
  // Portable by default: settings live next to the code, not in %APPDATA%.
  `--user-data-dir=${path.join(root, '.userdata')}`,
  ...process.argv.slice(2),
];

const child = spawn(bin, args, { cwd: root, env, stdio: 'inherit' });
child.on('error', (err) => {
  console.error('[deploy-desk] 启动失败:', err.message);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 0));
