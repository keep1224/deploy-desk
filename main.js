const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, nativeTheme } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Client } = require('ssh2');

let win = null;
let guideWin = null;

function log(kind, text) {
  if (win && !win.isDestroyed()) win.webContents.send('log', { kind, text });
}

// ── settings ────────────────────────────────────────────────
const storePath = () => path.join(app.getPath('userData'), 'profiles.json');

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    return { profiles: [], lastProfileId: null };
  }
}

function writeStore(data) {
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(data, null, 2), 'utf8');
}

function publicProfile(p) {
  const { passwordEnc, passphraseEnc, ...rest } = p;
  return {
    ...rest,
    password: secretOf(p, 'password'),
    passphrase: secretOf(p, 'passphrase'),
    hasPassword: !!passwordEnc,
    hasPassphrase: !!passphraseEnc,
  };
}

function secretOf(profile, field) {
  const enc = profile[`${field}Enc`];
  if (!enc) return '';
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return '';
  }
}

// ── ssh ─────────────────────────────────────────────────────
function expandHome(p) {
  if (!p) return p;
  if (p.startsWith('~')) return path.join(app.getPath('home'), p.slice(1).replace(/^[\\/]/, ''));
  return p;
}

function connect(profile) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const opts = {
      host: profile.host,
      port: Number(profile.port) || 22,
      username: profile.username,
      readyTimeout: 20000,
      keepaliveInterval: 10000,
    };

    if (profile.auth === 'password') {
      opts.password = secretOf(profile, 'password');
      if (!opts.password) return reject(new Error('密码未保存，请重新输入'));
    } else {
      const keyPath = expandHome(profile.keyPath);
      if (!keyPath) return reject(new Error('未指定私钥路径'));
      if (!fs.existsSync(keyPath)) return reject(new Error(`私钥不存在: ${keyPath}`));
      opts.privateKey = fs.readFileSync(keyPath);
      const pass = secretOf(profile, 'passphrase');
      if (pass) opts.passphrase = pass;
    }

    conn
      .on('ready', () => resolve(conn))
      .on('error', (err) => reject(new Error(`连接失败: ${err.message}`)))
      .connect(opts);
  });
}

function exec(conn, cmd, { silent = false } = {}) {
  return new Promise((resolve, reject) => {
    conn.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = '';
      let errOut = '';
      stream.on('data', (d) => {
        out += d.toString();
        if (!silent) log('out', d.toString());
      });
      if (stream.stderr) {
        stream.stderr.on('data', (d) => {
          errOut += d.toString();
          if (!silent) log('err', d.toString());
        });
      }
      stream.on('close', (code) => resolve({ code: code ?? 0, out, err: errOut }));
    });
  });
}

async function withConn(profile, fn) {
  const conn = await connect(profile);
  try {
    return await fn(conn);
  } finally {
    conn.end();
  }
}

// ── sftp ────────────────────────────────────────────────────
function sftpOf(conn) {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function mkdirp(sftp, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  return parts.reduce(
    (p, part) =>
      p.then(
        () =>
          new Promise((resolve) => {
            cur += '/' + part;
            sftp.mkdir(cur, () => resolve());
          }),
      ),
    Promise.resolve(),
  );
}

function putFile(sftp, local, remote) {
  return new Promise((resolve, reject) =>
    sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve())),
  );
}

async function uploadDir(sftp, localDir, remoteDir, onFile) {
  await mkdirp(sftp, remoteDir);
  for (const entry of fs.readdirSync(localDir, { withFileTypes: true })) {
    const lp = path.join(localDir, entry.name);
    const rp = remoteDir.replace(/\/+$/, '') + '/' + entry.name;
    if (entry.isDirectory()) await uploadDir(sftp, lp, rp, onFile);
    else {
      await putFile(sftp, lp, rp);
      if (onFile) onFile(lp);
    }
  }
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

// ── ipc: profiles ───────────────────────────────────────────
const SETTING_KEYS = ['scriptsDir', 'repoDir', 'distDir', 'gitRemote', 'gitBranch', 'webTarget', 'webClean', 'theme'];

ipcMain.handle('profile:list', () => {
  const store = readStore();
  const settings = {};
  for (const k of SETTING_KEYS) settings[k] = store[k];
  return {
    profiles: store.profiles.map(publicProfile),
    lastProfileId: store.lastProfileId,
    settings,
    canStoreSecrets: safeStorage.isEncryptionAvailable(),
  };
});

ipcMain.handle('profile:save', (_e, payload) => {
  const store = readStore();
  const existing = store.profiles.find((p) => p.id === payload.id) || { id: payload.id || cryptoId() };
  const profile = {
    ...existing,
    id: existing.id,
    name: payload.name?.trim() || payload.host,
    host: payload.host?.trim(),
    port: payload.port,
    username: payload.username?.trim(),
    auth: payload.auth === 'password' ? 'password' : 'key',
    keyPath: payload.keyPath || '',
  };

  const canEncrypt = safeStorage.isEncryptionAvailable();
  const seal = (value, field) => {
    if (value === undefined) return;
    if (value === '') {
      delete profile[`${field}Enc`];
      return;
    }
    if (canEncrypt) profile[`${field}Enc`] = safeStorage.encryptString(value).toString('base64');
  };
  seal(payload.password, 'password');
  seal(payload.passphrase, 'passphrase');

  store.profiles = store.profiles.filter((p) => p.id !== profile.id).concat(profile);
  store.lastProfileId = profile.id;
  writeStore(store);
  return { ok: true, profile: publicProfile(profile) };
});

ipcMain.handle('profile:delete', (_e, id) => {
  const store = readStore();
  store.profiles = store.profiles.filter((p) => p.id !== id);
  if (store.lastProfileId === id) store.lastProfileId = store.profiles[0]?.id || null;
  writeStore(store);
  return { ok: true };
});

ipcMain.handle('settings:save', (_e, payload) => {
  const store = readStore();
  for (const k of SETTING_KEYS) {
    if (payload[k] === undefined) continue;
    store[k] = typeof payload[k] === 'boolean' ? payload[k] : String(payload[k]);
  }
  writeStore(store);
  return { ok: true };
});

function cryptoId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function resolveProfile(id) {
  const store = readStore();
  const profile = store.profiles.find((p) => p.id === id);
  if (!profile) throw new Error('连接配置不存在');
  return profile;
}

// ── ipc: server ─────────────────────────────────────────────
ipcMain.handle('server:test', async (_e, id) => {
  try {
    const profile = resolveProfile(id);
    const r = await withConn(profile, (conn) =>
      exec(conn, 'echo "user=$(whoami)"; echo "host=$(hostname)"; echo "up=$(uptime -p 2>/dev/null || uptime)"; echo "swap=$(free -m | awk \'/Swap/{print $2}\')"'),
    );
    return { ok: true, out: r.out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const PROBE = `{
echo "@@node";  node -v 2>/dev/null || echo "missing"
echo "@@pnpm";  pnpm -v 2>/dev/null || echo "missing"
echo "@@nginx"; nginx -v 2>&1
echo "@@mysql"; mysql --version 2>/dev/null || echo "missing"
echo "@@mem";   free -m | awk '/Mem:/{print $2} /Swap:/{print $2}'
echo "@@swap";  swapon --show 2>/dev/null | tail -n +2 | wc -l
echo "@@svc";   systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | grep -E '^(nest-|node|nginx|mysql|mariadb)' || true
echo "@@ports"; ss -lntH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | sort -nu | tr '\\n' ' '; echo
echo "@@apps";  ls -1 /opt/apps 2>/dev/null || true
echo "@@git";   ls -1 /opt/git 2>/dev/null || true
echo "@@hooks"; find /opt/git -maxdepth 3 -name post-receive -path '*/hooks/*' 2>/dev/null | wc -l
} 2>/dev/null`;

ipcMain.handle('server:probe', async (_e, id) => {
  try {
    const profile = resolveProfile(id);
    log('info', `\n$ 采集服务器状态 ${profile.host}`);
    const r = await withConn(profile, (conn) => exec(conn, PROBE, { silent: true }));
    const data = {};
    let key = null;
    for (const line of r.out.split('\n')) {
      const m = line.match(/^@@(\w+)$/);
      if (m) {
        key = m[1];
        data[key] = '';
      } else if (key) {
        data[key] += (data[key] ? '\n' : '') + line;
      }
    }
    const pick = (text, re) => (String(text || '').match(re) || [])[1] || String(text || '').trim();
    const ports = (data.ports || '').trim().split(/\s+/).filter(Boolean);
    return {
      ok: true,
      node: data.node,
      pnpm: data.pnpm,
      nginx: pick(data.nginx, /nginx\/([\d.]+)/),
      mysql: pick(data.mysql, /(\d+\.\d+\.\d+)/),
      mem: data.mem,
      swapFiles: Number(data.swap || 0),
      services: (data.svc || '').trim().split('\n').filter(Boolean).map((s) => s.replace(/\.service$/, '')),
      ports,
      apps: (data.apps || '').trim().split('\n').filter(Boolean),
      repos: (data.git || '').trim().split('\n').filter(Boolean),
      hooks: Number(data.hooks || 0),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── ipc: projects.conf ──────────────────────────────────────
const confPath = () => path.join(app.getPath('userData'), 'projects.conf');

ipcMain.handle('conf:load', () => {
  const store = readStore();
  const candidates = [
    store.confPath,
    confPath(),
    store.scriptsDir ? path.join(store.scriptsDir, 'projects.conf') : null,
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      return { ok: true, text: fs.readFileSync(p, 'utf8'), path: p };
    } catch {}
  }
  return { ok: true, text: '', path: '' };
});

ipcMain.handle('conf:pickFile', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择 projects.conf',
    properties: ['openFile'],
    filters: [
      { name: '配置文件', extensions: ['conf', 'txt', 'cfg'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  const file = r.filePaths[0];
  const text = fs.readFileSync(file, 'utf8');
  const store = readStore();
  store.confPath = file;
  writeStore(store);
  return { ok: true, path: file, text };
});

ipcMain.handle('conf:saveAs', async (_e, text) => {
  const r = await dialog.showSaveDialog(win, {
    title: '另存 projects.conf',
    defaultPath: 'projects.conf',
    filters: [{ name: '配置文件', extensions: ['conf'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(r.filePath, text, 'utf8');
  const store = readStore();
  store.confPath = r.filePath;
  writeStore(store);
  return { ok: true, path: r.filePath };
});

ipcMain.handle('conf:save', (_e, text) => {
  fs.mkdirSync(path.dirname(confPath()), { recursive: true });
  fs.writeFileSync(confPath(), text, 'utf8');
  return { ok: true, path: confPath() };
});

ipcMain.handle('conf:download', async (_e, id) => {
  try {
    const profile = resolveProfile(id);
    const text = await withConn(profile, async (conn) => {
      const sftp = await sftpOf(conn);
      return new Promise((resolve, reject) =>
        sftp.readFile('/opt/deploy/projects.conf', (err, buf) =>
          err ? reject(new Error('服务器上没有 /opt/deploy/projects.conf')) : resolve(buf.toString()),
        ),
      );
    });
    fs.writeFileSync(confPath(), text, 'utf8');
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── ipc: nginx ──────────────────────────────────────────────
const NGINX_CONF = '/etc/nginx/conf.d/projects.conf';

ipcMain.handle('nginx:show', async (_e, id) => {
  try {
    const profile = resolveProfile(id);
    const cmd = [
      'nginx -t 2>&1',
      `echo '@@CONF'`,
      `if [ -f ${NGINX_CONF} ]; then cat ${NGINX_CONF}; else echo "服务器上还没有 ${NGINX_CONF}，先点「应用更改」"; fi`,
    ].join('; ');
    const r = await withConn(profile, (conn) => exec(conn, cmd, { silent: true }));
    const [test, ...rest] = r.out.split('@@CONF');
    return {
      ok: true,
      test: String(test || '').trim(),
      pass: /test is successful/.test(test) && !/emerg|\[error\]/.test(test),
      warn: /\[warn\]/.test(test),
      conf: rest.join('@@CONF').replace(/^\n/, '').trimEnd(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('conf:apply', async (_e, { id, text, scriptsDir }) => {
  try {
    const profile = resolveProfile(id);
    if (!scriptsDir) throw new Error('未设置脚本目录（scripts/deploy）');
    const names = ['apply.sh', 'add-project.sh', 'post-receive', 'db.sh'];
    for (const n of names) {
      if (!fs.existsSync(path.join(scriptsDir, n))) throw new Error(`缺少脚本: ${path.join(scriptsDir, n)}`);
    }

    log('info', `\n$ 上传部署脚本 → ${profile.host}:/opt/deploy`);
    const result = await withConn(profile, async (conn) => {
      const sftp = await sftpOf(conn);
      await mkdirp(sftp, '/opt/deploy');
      for (const n of names) {
        await putFile(sftp, path.join(scriptsDir, n), `/opt/deploy/${n}`);
        log('info', `  uploaded ${n}`);
      }
      fs.writeFileSync(path.join(app.getPath('temp'), 'projects.conf'), text, 'utf8');
      await putFile(sftp, path.join(app.getPath('temp'), 'projects.conf'), '/opt/deploy/projects.conf');
      log('info', '  uploaded projects.conf');
      await exec(conn, 'chmod 755 /opt/deploy/*.sh /opt/deploy/post-receive');

      log('info', '\n$ bash /opt/deploy/apply.sh /opt/deploy/projects.conf');
      const r = await exec(conn, 'bash /opt/deploy/apply.sh /opt/deploy/projects.conf 2>&1');
      return r;
    });

    fs.writeFileSync(confPath(), text, 'utf8');
    return { ok: result.code === 0, code: result.code, out: result.out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── ipc: database ───────────────────────────────────────────
ipcMain.handle('db:list', async (_e, id) => {
  try {
    const profile = resolveProfile(id);
    const { dbOut, webOut } = await withConn(profile, async (conn) => {
      const db = await exec(conn, 'bash /opt/deploy/db.sh list 2>/dev/null', { silent: true });
      const web = await exec(
        conn,
        'find /var/www -mindepth 1 -maxdepth 1 -type d -printf "%f\\n" 2>/dev/null',
        { silent: true },
      );
      return { dbOut: db.out, webOut: web.out };
    });
    const rows = dbOut
      .split('\n')
      .map((l) => l.split('\t'))
      .filter((c) => c.length >= 4 && c[0])
      .map(([name, db, exists, size, tables]) => ({
        name,
        db,
        exists: exists === 'yes',
        size: size || '-',
        tables: tables || '-',
      }));

    const seen = new Set(rows.map((row) => row.name));
    for (const name of webOut.split('\n').map((l) => l.trim())) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      rows.push({ name, db: '-', exists: false, size: '-', tables: '-', web: true });
    }
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:run', async (_e, { id, app, action }) => {
  try {
    const profile = resolveProfile(id);
    if (!/^[a-z][a-z0-9-]{2,30}$/.test(app || '')) throw new Error('项目名不合法');
    if (action !== 'migrate' && action !== 'dump') throw new Error('未知操作');
    log('info', `\n$ db.sh ${action} ${app}`);
    const r = await withConn(profile, (conn) =>
      exec(conn, `bash /opt/deploy/db.sh ${action} ${app} 2>&1`),
    );
    return { ok: r.code === 0, code: r.code, out: r.out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('db:import', async (_e, { id, app }) => {
  try {
    const profile = resolveProfile(id);
    if (!/^[a-z][a-z0-9-]{2,30}$/.test(app || '')) throw new Error('项目名不合法');

    const pick = await dialog.showOpenDialog({
      title: `导入 SQL 到 ${app}`,
      properties: ['openFile'],
      filters: [{ name: 'SQL 文件', extensions: ['sql', 'gz'] }],
    });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
    const file = pick.filePaths[0];

    const answer = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', '导入'],
      defaultId: 0,
      cancelId: 0,
      message: `把 SQL 导入 ${app} 的数据库？`,
      detail: `${path.basename(file)} → ${app}\n表结构和同名表会被写入/覆盖，建议先点「备份」。`,
    });
    if (answer.response !== 1) return { ok: false, canceled: true };

    const gz = file.toLowerCase().endsWith('.gz');
    const remote = `/tmp/deploy-desk-import-${Date.now()}.sql${gz ? '.gz' : ''}`;
    log('info', `\n$ 导入 ${path.basename(file)} → ${app}`);

    const r = await withConn(profile, async (conn) => {
      const sftp = await sftpOf(conn);
      log('info', `  上传到 ${remote}`);
      await putFile(sftp, file, remote);
      const res = await exec(conn, `bash /opt/deploy/db.sh import ${app} ${remote} 2>&1`);
      await exec(conn, `rm -f ${remote}`, { silent: true });
      return res;
    });

    return { ok: r.code === 0, code: r.code, out: r.out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('shell:openExternal', async (_e, url) => {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只支持 http/https');
    await shell.openExternal(parsed.href);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── ipc: deploy backend (local git push) ────────────────────
ipcMain.handle('deploy:push', async (_e, { repoDir, remote, branch }) => {
  try {
    if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) {
      throw new Error(`不是 git 仓库: ${repoDir}`);
    }
    log('info', `\n$ git -C ${repoDir} push ${remote} ${branch}`);
    return await new Promise((resolve) => {
      const child = spawn('git', ['-C', repoDir, 'push', remote, branch], {
        shell: process.platform === 'win32',
      });
      child.stdout?.on('data', (d) => log('out', d.toString()));
      child.stderr?.on('data', (d) => log('err', d.toString()));
      child.on('close', (code) => resolve({ ok: code === 0, code }));
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── ipc: publish frontend (sftp upload) ─────────────────────
ipcMain.handle('web:upload', async (_e, { id, localDir, remoteDir, clean }) => {
  try {
    if (!fs.existsSync(localDir)) throw new Error(`目录不存在: ${localDir}`);
    const profile = resolveProfile(id);
    const total = countFiles(localDir);
    let done = 0;
    log('info', `\n$ 上传 ${localDir} → ${profile.host}:${remoteDir} (${total} 个文件)`);

    await withConn(profile, async (conn) => {
      const sftp = await sftpOf(conn);
      if (clean) {
        log('info', `  清空 ${remoteDir}`);
        await exec(conn, `rm -rf ${JSON.stringify(remoteDir)} && mkdir -p ${JSON.stringify(remoteDir)}`);
      }
      await uploadDir(sftp, localDir, remoteDir, (file) => {
        done += 1;
        if (done % 20 === 0 || done === total) log('info', `  ${done}/${total}`);
      });
    });

    log('info', `  完成 ${done} 个文件`);
    return { ok: true, files: done };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dialog:pickDir', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ── ipc: app + updates ──────────────────────────────────────
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
}));

function sendUpdate(payload) {
  if (win && !win.isDestroyed()) win.webContents.send('update', payload);
}

function updateBlockReason() {
  if (!app.isPackaged) return '开发模式（未打包）不检查更新';
  if (process.env.PORTABLE_EXECUTABLE_DIR) return '便携版不支持自动更新，请下载新的安装包';
  if (process.platform === 'darwin') return 'macOS 版没有签名，暂不支持应用内更新，请到 Releases 下载';
  return '';
}

async function checkForUpdates() {
  const blocked = updateBlockReason();
  if (blocked) return { ok: false, error: blocked };
  try {
    log('info', '\n$ 检查更新');
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r?.updateInfo?.version || '' };
  } catch (err) {
    log('err', `检查更新失败: ${err.message}\n`);
    return { ok: false, error: err.message };
  }
}

function setupUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => sendUpdate({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => sendUpdate({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', (info) => sendUpdate({ status: 'none', version: info.version }));
  autoUpdater.on('download-progress', (p) =>
    sendUpdate({
      status: 'downloading',
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
    }),
  );
  autoUpdater.on('update-downloaded', (info) => sendUpdate({ status: 'downloaded', version: info.version }));
  autoUpdater.on('error', (err) => sendUpdate({ status: 'error', message: err.message }));
  if (app.isPackaged && !updateBlockReason()) setTimeout(checkForUpdates, 4000);
}

ipcMain.handle('update:check', () => checkForUpdates());

ipcMain.handle('update:download', () => {
  const blocked = updateBlockReason();
  if (blocked) return { ok: false, error: blocked };
  log('info', '\n$ 下载更新');
  autoUpdater.downloadUpdate().catch((err) => {
    log('err', `下载更新失败: ${err.message}\n`);
    sendUpdate({ status: 'error', message: err.message });
  });
  return { ok: true };
});

ipcMain.handle('update:install', () => {
  setImmediate(() => autoUpdater.quitAndInstall());
  return { ok: true };
});

function openGuide() {
  if (guideWin && !guideWin.isDestroyed()) {
    guideWin.show();
    guideWin.focus();
    return { ok: true };
  }
  guideWin = new BrowserWindow({
    width: 1000,
    height: 860,
    minWidth: 720,
    minHeight: 520,
    title: 'Deploy Desk 使用说明',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1218' : '#f4f6fa',
    autoHideMenuBar: true,
    webPreferences: { sandbox: true },
  });
  guideWin.removeMenu();
  guideWin.on('closed', () => {
    guideWin = null;
  });
  guideWin.loadFile(path.join(__dirname, 'docs', 'guide.html'));
  return { ok: true };
}

ipcMain.handle('guide:open', () => {
  try {
    return openGuide();
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── window ──────────────────────────────────────────────────
function createWindow() {
  const theme = readStore().theme;
  const dark = theme === 'light' ? false : theme === 'dark' ? true : nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1120,
    minHeight: 640,
    backgroundColor: dark ? '#12151b' : '#eef1f6',
    title: 'Deploy Desk',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('renderer gone:', JSON.stringify(details));
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(() => {
    createWindow();
    setupUpdater();
  });
  app.on('window-all-closed', () => app.quit());
}
