const { app, BrowserWindow, ipcMain, dialog, safeStorage, nativeTheme, clipboard } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
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
  // 明文不出主进程：只下发“是否已保存”的布尔，需要看的时候走 profile:reveal 单条解密
  return {
    ...rest,
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
          new Promise((resolve, reject) => {
            cur += '/' + part;
            sftp.mkdir(cur, (err) => {
              // err.code 4 = SSH_FX_NO_SUCH_FILE：该目录已存在，视为成功
              if (err && err.code !== 4) reject(err);
              else resolve();
            });
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
const SETTING_KEYS = ['repoDir', 'distDir', 'gitRemote', 'gitBranch', 'webTarget', 'webTargetProject', 'webClean', 'theme', 'logBar', 'pushProject', 'repoDirs', 'distDirs'];

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
  const host = payload.host?.trim();
  const username = payload.username?.trim();
  if (!host) return { ok: false, error: '主机不能为空' };
  if (!username) return { ok: false, error: '用户不能为空' };
  const existing = store.profiles.find((p) => p.id === payload.id) || { id: payload.id || cryptoId() };
  const profile = {
    ...existing,
    id: existing.id,
    name: payload.name?.trim() || host,
    host,
    port: payload.port,
    username,
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

// 按需解密单条秘密（「显示」按钮用）。字段白名单写死，避免任意键读取。
ipcMain.handle('profile:reveal', (_e, { id, field: fieldName }) => {
  try {
    if (fieldName !== 'password' && fieldName !== 'passphrase') throw new Error('未知字段');
    const secret = secretOf(resolveProfile(id), fieldName);
    if (!secret) throw new Error('没有保存的值');
    return { ok: true, secret };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('settings:save', (_e, payload) => {
  const store = readStore();
  for (const k of SETTING_KEYS) {
    const v = payload[k];
    if (v === undefined) continue;
    // 布尔和「项目名 → 目录」这类映射原样存，其余收成字符串
    store[k] = typeof v === 'boolean' || typeof v === 'object' ? v : String(v);
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
const confPath = (id) => path.join(app.getPath('userData'), id ? `projects-${id}.conf` : 'projects.conf');

ipcMain.handle('conf:load', (_e, id) => {
  const candidates = [id ? confPath(id) : null, confPath()].filter(Boolean);
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
  return { ok: true, path: r.filePath };
});

ipcMain.handle('conf:save', (_e, { id, text }) => {
  const p = confPath(id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf8');
  return { ok: true, path: p };
});

async function readRemoteConf(id) {
  const profile = resolveProfile(id);
  return withConn(profile, async (conn) => {
    const sftp = await sftpOf(conn);
    return new Promise((resolve, reject) =>
      sftp.readFile('/opt/deploy/projects.conf', (err, buf) =>
        err ? reject(new Error('服务器上没有 /opt/deploy/projects.conf')) : resolve(buf.toString()),
      ),
    );
  });
}

ipcMain.handle('conf:remote', async (_e, id) => {
  try {
    return { ok: true, text: await readRemoteConf(id) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('conf:download', async (_e, id) => {
  try {
    const text = await readRemoteConf(id);
    fs.mkdirSync(path.dirname(confPath(id)), { recursive: true });
    fs.writeFileSync(confPath(id), text, 'utf8');
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── ipc: nginx ──────────────────────────────────────────────
// apply.sh 为每个项目生成独立的 deploy-<name>.conf；旧版单文件
// /etc/nginx/conf.d/projects.conf 在首次 apply 时已被迁移(rename)掉，
// 所以这里按 deploy-*.conf 前缀聚合展示，不再引用那个不存在的单文件。

ipcMain.handle('nginx:show', async (_e, id) => {
  try {
    const profile = resolveProfile(id);
    const cmd = [
      'nginx -t 2>&1',
      `echo '@@CONF'`,
      `[ -d /etc/nginx/conf.d ] && find /etc/nginx/conf.d -maxdepth 1 -name 'deploy-*.conf' -type f 2>/dev/null | sort | while IFS= read -r f; do echo "## $f"; cat "$f"; echo; done; if ! ls /etc/nginx/conf.d/deploy-*.conf >/dev/null 2>&1; then echo "服务器上还没有 deploy-*.conf，先点「应用更改」"; fi`,
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

const SCRIPT_NAMES = ['apply.sh', 'add-project.sh', 'post-receive', 'db.sh', 'remove-project.sh'];

function bundledScriptsDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server')
    : path.join(__dirname, 'server');
}

ipcMain.handle('conf:apply', async (_e, { id, text }) => {
  try {
    const profile = resolveProfile(id);
    const dir = bundledScriptsDir();
    const missing = SCRIPT_NAMES.filter((n) => !fs.existsSync(path.join(dir, n)));
    if (missing.length) throw new Error(`内置部署脚本缺失: ${missing.join(', ')}（${dir}）`);

    log('info', `\n$ 上传部署脚本 → ${profile.host}:/opt/deploy`);
    const result = await withConn(profile, async (conn) => {
      const sftp = await sftpOf(conn);
      await mkdirp(sftp, '/opt/deploy');
      for (const n of SCRIPT_NAMES) {
        await putFile(sftp, path.join(dir, n), `/opt/deploy/${n}`);
        log('info', `  uploaded ${n}`);
      }
      // 清单直接经 SFTP 写到服务器，不落本地临时文件：
      // 固定的 %TEMP%\projects.conf 会被杀软/其他实例占用（EPERM 教训）
      // 补末尾换行：编辑器里没有最后一行的空行，读回来会少掉一个项目
      const confText = text.endsWith('\n') ? text : `${text}\n`;
      await new Promise((resolve, reject) =>
        sftp.writeFile('/opt/deploy/projects.conf', confText, 'utf8', (err) => (err ? reject(err) : resolve())));
      log('info', '  uploaded projects.conf');
      await exec(conn, 'chmod 755 /opt/deploy/*.sh /opt/deploy/post-receive');

      log('info', '\n$ bash /opt/deploy/apply.sh /opt/deploy/projects.conf');
      const r = await exec(conn, 'bash /opt/deploy/apply.sh /opt/deploy/projects.conf 2>&1');
      return r;
    });

    fs.mkdirSync(path.dirname(confPath(id)), { recursive: true });
    fs.writeFileSync(confPath(id), text, 'utf8');
    return { ok: result.code === 0, code: result.code, out: result.out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── ipc: database ───────────────────────────────────────────
ipcMain.handle('db:list', async (_e, id) => {
  try {
    const profile = resolveProfile(id);
    const { dbOut, webOut, portsOut, hookOut, webFilesOut, svcOut } = await withConn(profile, async (conn) => {
      const db = await exec(conn, 'bash /opt/deploy/db.sh list 2>/dev/null', { silent: true });
      const web = await exec(
        conn,
        'find /var/www -mindepth 1 -maxdepth 1 -type d -printf "%f\\n" 2>/dev/null',
        { silent: true },
      );
      const ports = await exec(conn, `ss -lntH 2>/dev/null | awk '{print $4}' | sed 's/.*://'`, {
        silent: true,
      });
      const hooks = await exec(
        conn,
        `for d in /opt/git/*.git; do [ -d "$d" ] || continue; printf '%s\\t%s\\n' "$(basename "$d" .git)" "$(grep -h '^export BRANCH=\\|^BRANCH=' "$d/hooks/post-receive" /opt/deploy/post-receive 2>/dev/null | head -1)"; done`,
        { silent: true },
      );
      // 前端站点的文件数：目录存在但 0 个文件 = apply 建了目录还没发布过
      const webFiles = await exec(
        conn,
        `for d in /var/www/*/; do [ -d "$d" ] || continue; printf '%s\\t%s\\n' "$(basename "$d")" "$(find "$d" -type f 2>/dev/null | wc -l)"; done`,
        { silent: true },
      );
      return { dbOut: db.out, webOut: web.out, portsOut: ports.out, hookOut: hooks.out, webFilesOut: webFiles.out, svcOut: svc.out };
    });
    const webFiles = new Map();
    for (const line of webFilesOut.split('\n')) {
      const [name, n] = line.split('\t');
      if (name && n !== undefined) webFiles.set(name.trim(), Number(n.trim()) || 0);
    }
    const hookBranch = new Map();
    for (const line of hookOut.split('\n')) {
      const [name, decl] = line.split('\t');
      if (!name || !decl) continue;
      // BRANCH=${BRANCH:-master} 取默认值，BRANCH=main 直接取值。
      const m = decl.match(/:-([^}]*)\}/) || decl.match(/=\s*(\S+)/);
      if (m && m[1]) hookBranch.set(name.trim(), m[1].trim());
    }
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
        branch: hookBranch.get(name) || '',
      }));

    const seen = new Set(rows.map((row) => row.name));
    for (const name of webOut.split('\n').map((l) => l.trim())) {
      if (!name || seen.has(name)) continue;
      seen.add(name);
      rows.push({
        name,
        db: '-',
        exists: false,
        size: '-',
        tables: '-',
        web: true,
        branch: hookBranch.get(name) || '',
        files: webFiles.get(name),
      });
    }
    return {
      ok: true,
      rows,
      ports: portsOut.trim().split(/\s+/).filter(Boolean),
      services: (svcOut.split('@@off')[0] || '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((s) => s.replace(/^nest-/, '')),
      sitesOff: (svcOut.split('@@off')[1] || '')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((f) => f.replace(/^deploy-/, '').replace(/\.conf$/, '')),
    };
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

ipcMain.handle('clip:write', (_e, text) => {
  try {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 从服务器删除一个项目（清单行移除后的配套清理）
ipcMain.handle('project:remove', async (_e, { id, name, withDb }) => {
  try {
    const profile = resolveProfile(id);
    if (!/^[a-z][a-z0-9-]{2,30}$/.test(name || '')) throw new Error('项目名不合法');
    const script = path.join(bundledScriptsDir(), 'remove-project.sh');
    if (!fs.existsSync(script)) throw new Error('内置脚本缺失: remove-project.sh');
    log('info', `\n$ remove-project.sh ${name}${withDb ? ' --with-db' : ''}`);
    const r = await withConn(profile, async (conn) => {
      const sftp = await sftpOf(conn);
      await mkdirp(sftp, '/opt/deploy');
      await putFile(sftp, script, '/opt/deploy/remove-project.sh');
      await exec(conn, 'chmod 755 /opt/deploy/remove-project.sh', { silent: true });
      return exec(conn, `bash /opt/deploy/remove-project.sh ${name}${withDb ? ' --with-db' : ''} 2>&1`);
    });
    return { ok: r.code === 0, code: r.code, out: r.out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 行内启停：api = systemd 单元 nest-<name>；web = nginx 站点的上线/下线
//（配置在 conf.d 和 deploy-disabled 之间搬，站点文件和构建产物都不动）
ipcMain.handle('project:service', async (_e, { id, name, action }) => {
  try {
    const profile = resolveProfile(id);
    if (!/^[a-z][a-z0-9-]{2,30}$/.test(name || '')) throw new Error('项目名不合法');
    if (action !== 'start' && action !== 'stop') throw new Error('未知操作');
    const unit = `nest-${name}`;
    log('info', `\n$ systemctl ${action} ${unit}`);
    const r = await withConn(profile, (conn) =>
      exec(
        conn,
        `systemctl ${action} ${unit} 2>&1; echo "@@rc=$?"; systemctl is-active ${unit} 2>&1 || true`,
      ),
    );
    const at = r.out.indexOf('@@rc=');
    const out = at < 0 ? r.out : r.out.slice(0, at);
    const tail = at < 0 ? '' : r.out.slice(at);
    const rc = at < 0 ? NaN : Number((tail.match(/@@rc=(\d+)/) || [])[1]);
    const state = at < 0
      ? String(out).trim().split('\n').pop()
      : String(tail.split('\n')[1] || '').trim();
    // 退出码 + 最终状态都要对：服务可能秒退，stop 一个不存在的单元也不能算成功
    const ok = rc === 0 && (action === 'start'
      ? state === 'active' || state === 'activating'
      : state === 'inactive' || state === 'failed');
    return { ok, state, out: (out || '').trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('project:site', async (_e, { id, name, on }) => {
  try {
    const profile = resolveProfile(id);
    if (!/^[a-z][a-z0-9-]{2,30}$/.test(name || '')) throw new Error('项目名不合法');
    const file = `deploy-${name}.conf`;
    const live = `/etc/nginx/conf.d/${file}`;
    const away = `/etc/nginx/deploy-disabled/${file}`;
    // 下线先搬走再 nginx -t，失败立刻搬回来：坏配置不上线，站点不会莫名 404
    const cmd = on
      ? `if [ ! -f ${away} ]; then echo '站点没有被下线，不需要上线'; exit 0; fi; ` +
        `install -d /etc/nginx/deploy-disabled; mv ${away} ${live}; ` +
        `if ! nginx -t 2>&1; then mv ${live} ${away} 2>/dev/null; echo 'nginx -t failed, reverted' >&2; exit 1; fi; ` +
        `systemctl reload nginx && echo 'site on'`
      : `if [ ! -f ${live} ]; then echo '站点配置文件不存在，先点「应用更改」'; exit 2; fi; ` +
        `install -d /etc/nginx/deploy-disabled; mv ${live} ${away}; ` +
        `if ! nginx -t 2>&1; then mv ${away} ${live} 2>/dev/null; echo 'nginx -t failed, reverted' >&2; exit 1; fi; ` +
        `systemctl reload nginx && echo 'site off'`;
    log('info', `\n$ nginx ${on ? '上线' : '下线'} ${file}`);
    const r = await withConn(profile, (conn) => exec(conn, cmd));
    return { ok: r.code === 0, code: r.code, out: r.out };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── ipc: deploy backend (local git push) ────────────────────
function runGit(repoDir, args, env) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repoDir, ...args], {
      shell: process.platform === 'win32',
      env: env || process.env,
    });
    let out = '';
    let errOut = '';
    child.stdout?.on('data', (d) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d) => {
      errOut += d.toString();
    });
    child.on('close', (code) => resolve({ code, out, err: errOut }));
    child.on('error', () => resolve({ code: -1, out: '', err: '' }));
  });
}

// 面板自己的部署密钥：生成一次，推到每台服务器一次，之后 git push 全程免交互。
// 不依赖用户本机已有的 ~/.ssh 配置，也不要求用户手工把公钥贴到服务器。
function deployKeyPaths() {
  const dir = path.join(app.getPath('userData'), 'keys');
  fs.mkdirSync(dir, { recursive: true });
  return {
    privateKey: path.join(dir, 'deploy_ed25519'),
    publicKey: path.join(dir, 'deploy_ed25519.pub'),
    knownHosts: path.join(dir, 'known_hosts'),
  };
}

function ensureLocalDeployKey() {
  const k = deployKeyPaths();
  if (!fs.existsSync(k.privateKey) || !fs.existsSync(k.publicKey)) {
    const native = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'OpenSSH',
      'ssh-keygen.exe',
    );
    const candidates = process.platform === 'win32' && fs.existsSync(native) ? [native] : ['ssh-keygen'];
    let lastErr = null;
    for (const bin of candidates) {
      try {
        execFileSync(bin, ['-q', '-t', 'ed25519', '-N', '', '-C', 'deploy-desk', '-f', k.privateKey], {
          stdio: 'ignore',
          windowsHide: true,
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw new Error(`无法生成部署密钥（需要 ssh-keygen）: ${lastErr.message}`);
    try {
      fs.chmodSync(k.privateKey, 0o600);
    } catch {}
  }
  return { ...k, pub: fs.readFileSync(k.publicKey, 'utf8').trim() };
}

// Windows 下 Electron 里跑的 git 会拉起 Git 自带的 MSYS ssh，直接崩在
// NtCreateDirectoryObject；统一改用系统 OpenSSH。
function nativeSshBin() {
  const native = path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'OpenSSH',
    'ssh.exe',
  );
  if (process.platform === 'win32' && fs.existsSync(native)) return native.replace(/\\/g, '/');
  return 'ssh';
}

// GIT_SSH_COMMAND 要经过 sh 解析，Electron 里 Git 自带的 MSYS sh 起不来；
// GIT_SSH 只给可执行文件路径、不经过 shell，参数放进独立的 ssh config。
function gitEnvWithKey(key) {
  const home = path.join(app.getPath('userData'), 'keys', 'home');
  const sshDir = path.join(home, '.ssh');
  fs.mkdirSync(sshDir, { recursive: true });
  fs.writeFileSync(
    path.join(sshDir, 'config'),
    [
      'Host *',
      `  IdentityFile "${key.privateKey.replace(/\\/g, '/')}"`,
      '  IdentitiesOnly yes',
      '  BatchMode yes',
      '  StrictHostKeyChecking accept-new',
      `  UserKnownHostsFile "${key.knownHosts.replace(/\\/g, '/')}"`,
      '  ConnectTimeout 15',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  const env = { ...process.env };
  delete env.GIT_SSH_COMMAND;
  env.GIT_SSH = nativeSshBin();
  env.GIT_SSH_VARIANT = 'ssh';
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}

const sshAuthReady = new Set();

// 用面板已有的 SSH 连接（密码或私钥）把部署公钥装进服务器，并确认 sshd
// 允许公钥认证。idempotent：已经在 authorized_keys 里就什么都不写。
async function ensureServerAuth(profile) {
  const key = ensureLocalDeployKey();
  const cacheKey = `${profile.id}|${profile.host}|${profile.username}`;
  if (sshAuthReady.has(cacheKey)) return key;

  const b64 = Buffer.from(`${key.pub}\n`, 'utf8').toString('base64');
  const script = [
    'set -e',
    'umask 077',
    'mkdir -p "$HOME/.ssh"',
    'chmod 700 "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys"',
    'chmod 600 "$HOME/.ssh/authorized_keys"',
    `KEY=$(printf %s '${b64}' | base64 -d)`,
    'grep -qxF "$KEY" "$HOME/.ssh/authorized_keys" || printf \'%s\\n\' "$KEY" >> "$HOME/.ssh/authorized_keys"',
    'if command -v sshd >/dev/null 2>&1; then',
    '  if ! sshd -T 2>/dev/null | grep -qi "^pubkeyauthentication yes"; then',
    '    mkdir -p /etc/ssh/sshd_config.d',
    '    printf "PubkeyAuthentication yes\\n" > /etc/ssh/sshd_config.d/99-deploy-desk.conf',
    '    if [ -f /etc/ssh/sshd_config ] && ! grep -qE "^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d/" /etc/ssh/sshd_config; then',
    '      grep -q "^# deploy-desk public key" /etc/ssh/sshd_config || printf "\\n# deploy-desk public key\\nPubkeyAuthentication yes\\n" >> /etc/ssh/sshd_config',
    '    fi',
    '    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true',
    '  fi',
    'fi',
    'if command -v sshd >/dev/null 2>&1; then sshd -T 2>/dev/null | grep -qi "^pubkeyauthentication yes" && echo pubkey-auth=yes || echo pubkey-auth=unknown; fi',
  ].join('\n');

  log('info', `$ 配置免密推送（部署密钥 → ${profile.username}@${profile.host}）\n`);
  const r = await withConn(profile, (conn) => exec(conn, script, { silent: true }));
  if (r.code !== 0) {
    throw new Error((r.err || r.out || '').trim() || `写入 authorized_keys 失败（退出码 ${r.code}）`);
  }
  if (/pubkey-auth=unknown/.test(r.out)) {
    log('warn', '  服务器未确认 PubkeyAuthentication=yes，推送可能仍要密码\n');
  } else {
    log('info', '  部署密钥已就绪\n');
  }
  sshAuthReady.add(cacheKey);
  return key;
}

function bareRepoUrl(profile, project) {
  return `ssh://${profile.username}@${profile.host}:${profile.port}/opt/git/${project}.git`;
}

// 全新仓库没有远端：面板按配置清单里的项目名直接补一个，省掉手敲
// git remote add。已有同名远端则原样使用，绝不覆盖用户设置。
async function ensureRemote(repoDir, remote, project, profile) {
  if (!remote || !project) return null;
  const existing = await runGit(repoDir, ['remote', 'get-url', remote]);
  if (existing.code === 0) return { remote, url: existing.out.trim(), added: false };
  const url = bareRepoUrl(profile, project);
  const add = await runGit(repoDir, ['remote', 'add', remote, url]);
  if (add.code !== 0) {
    throw new Error(`添加远端失败: ${(add.err || add.out || '').trim() || `退出码 ${add.code}`}`);
  }
  return { remote, url, added: true };
}

// 发布页的「远端 / 分支」是仓库里真实存在的名字，不是让用户猜。
ipcMain.handle('git:inspect', async (_e, repoDir) => {
  try {
    if (!repoDir) throw new Error('未选择仓库目录');
    if (!fs.existsSync(path.join(repoDir, '.git'))) throw new Error(`不是 git 仓库: ${repoDir}`);
    const remotes = await runGit(repoDir, ['remote', '-v']);
    if (remotes.code !== 0) throw new Error('git remote 执行失败，请确认 git 已安装并在 PATH 中');
    const branches = await runGit(repoDir, ['branch', '--list', '--format=%(refname:short)']);
    const head = await runGit(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const urls = new Map();
    for (const line of remotes.out.split('\n')) {
      const m = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
      if (m && (!urls.has(m[1]) || m[3] === 'push')) urls.set(m[1], m[2]);
    }
    return {
      ok: true,
      remotes: [...urls].map(([name, url]) => ({ name, url })),
      branches: branches.out.split('\n').map((s) => s.trim()).filter(Boolean),
      head: head.out.trim(),
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Electron spawns git outside MSYS; the Git-bundled ssh.exe dies there with
// NtCreateDirectoryObject, so use the system OpenSSH client when available.
// GIT_SSH（而不是 GIT_SSH_COMMAND）不经过 shell，避免再拉起 MSYS sh。
function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_SSH_COMMAND;
  if (process.platform === 'win32') {
    const native = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(native)) {
      env.GIT_SSH = native.replace(/\\/g, '/');
      env.GIT_SSH_VARIANT = 'ssh';
    }
  }
  return env;
}

ipcMain.handle('deploy:push', async (_e, { id, repoDir, remote, branch, project }) => {
  try {
    if (!repoDir || !fs.existsSync(path.join(repoDir, '.git'))) {
      throw new Error(`不是 git 仓库: ${repoDir}`);
    }
    const profile = id ? resolveProfile(id) : null;
    let pushedRemote = String(remote || '').trim();

    if (profile && project) {
      if (!/^[a-z][a-z0-9-]{2,30}$/.test(project)) throw new Error(`项目名不合法: ${project}`);
      pushedRemote = pushedRemote || 'deploy';
      const r = await ensureRemote(repoDir, pushedRemote, project, profile);
      if (r?.added) log('info', `  已添加远端 ${pushedRemote} → ${r.url}\n`);
    }
    if (!pushedRemote || !branch) throw new Error('没有可用的远端或分支');

    let env = gitEnv();
    if (profile) {
      try {
        const key = await ensureServerAuth(profile);
        env = gitEnvWithKey(key);
      } catch (err) {
        if (profile.auth === 'password') {
          throw new Error(`自动配置免密推送失败: ${err.message}`);
        }
        log('warn', `  免密推送配置失败，改用本机 SSH 配置: ${err.message}\n`);
      }
    }

    log('info', `\n$ git -C ${repoDir} push ${pushedRemote} ${branch}\n`);
    return await new Promise((resolve) => {
      const child = spawn('git', ['-C', repoDir, 'push', pushedRemote, branch], {
        shell: process.platform === 'win32',
        env,
      });
      child.stdout?.on('data', (d) => log('out', d.toString()));
      child.stderr?.on('data', (d) => log('err', d.toString()));
      child.on('close', (code) => resolve({ ok: code === 0, code, remote: pushedRemote }));
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── ipc: publish frontend (sftp upload) ─────────────────────
// 本机 curl 127.0.0.1 时 Host 是 127.0.0.1，nginx 会落到默认站点而不是
// server_name 匹配的项目站点，所以自检要带上项目域名。
function selfCheckHost(domain) {
  const raw = String(domain || '').trim();
  if (!raw || raw === '-') return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    return /^[A-Za-z0-9.\-:[\]]+$/.test(u.hostname) ? u.hostname : '';
  } catch {
    return '';
  }
}

ipcMain.handle('web:upload', async (_e, { id, localDir, remoteDir, clean, port, domain }) => {
  try {
    if (!fs.existsSync(localDir)) throw new Error(`目录不存在: ${localDir}`);
    // 目标目录安全校验：必须绝对路径、不含 ..、每段为常规目录名；
    // 勾选「清空」时额外要求至少到第 3 级（如 /var/www/<项目>），
    // 避免误清 /etc、/var/www 等顶级目录。项目表默认给的是 /var/www/<项目>，
    // 自定义路径（发布页的「自定义路径…」）只要不是顶级系统目录即可。
    const remote = String(remoteDir || '').trim().replace(/\/+$/, '');
    if (!remote.startsWith('/')) {
      throw new Error(`目标目录必须是绝对路径，收到: ${remoteDir}`);
    }
    const segs = remote.split('/').filter(Boolean);
    if (segs.length === 0 || segs.some((s) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s))) {
      throw new Error(`目标目录不合法（需形如 /var/www/<项目>，不能含 .. 或异常字符）: ${remoteDir}`);
    }
    if (clean && segs.length < 3) {
      throw new Error(`勾选「清空」时目标至少要到第 3 级（如 /var/www/<项目>），避免误清顶级目录: ${remote}`);
    }
    const profile = resolveProfile(id);
    const total = countFiles(localDir);
    let done = 0;
    let check = null;
    const staging = clean ? `${remote}.staging` : remote;
    log('info', `\n$ 上传 ${localDir} → ${profile.host}:${staging} (${total} 个文件)\n`);

    await withConn(profile, async (conn) => {
      const sftp = await sftpOf(conn);
      if (clean) {
        // 先把暂存目录清掉再上传，全部传完后原子切换；上传期间旧站点仍可服务
        log('info', `  清空暂存目录 ${staging}\n`);
        const prep = await exec(conn, `rm -rf ${JSON.stringify(staging)} && mkdir -p ${JSON.stringify(staging)}`);
        if (prep.code !== 0) throw new Error(`清空暂存目录失败（退出码 ${prep.code}）`);
      }
      await uploadDir(sftp, localDir, staging, (file) => {
        done += 1;
        if (done % 20 === 0 || done === total) log('info', `  ${done}/${total}\n`);
      });
      if (clean) {
        log('info', `  切换 ${staging} → ${remote}\n`);
        const sw = await exec(
          conn,
          [
            `rm -rf ${JSON.stringify(`${remote}.old`)}`,
            `if [ -d ${JSON.stringify(remote)} ]; then mv ${JSON.stringify(remote)} ${JSON.stringify(`${remote}.old`)}; fi`,
            `mv ${JSON.stringify(staging)} ${JSON.stringify(remote)}`,
          ].join(' && ')
        );
        if (sw.code !== 0) {
          // 切换失败：尽力把旧站点还原回原位，暂存目录留着供排查
          await exec(
            conn,
            `if [ -d ${JSON.stringify(`${remote}.old`)} ] && [ ! -d ${JSON.stringify(remote)} ]; then mv ${JSON.stringify(`${remote}.old`)} ${JSON.stringify(remote)}; fi`,
            { silent: true },
          );
          throw new Error(
            `切换失败（退出码 ${sw.code}）：旧站点未受影响，新内容仍在 ${staging}，可重新发布重试`,
          );
        }
        await exec(conn, `rm -rf ${JSON.stringify(`${remote}.old`)}`, { silent: true });
      }

      // 文件到位 ≠ 站点可访问：用清单里的端口在服务器本机请求一次，
      // 免得清单没应用、端口没 listen 时面板照样报「已发布」。
      log('info', `  完成 ${done} 个文件\n`);
      const p = String(port ?? '').trim();
      if (/^\d{2,5}$/.test(p)) {
        const host = selfCheckHost(domain);
        const hostArg = host ? ` -H ${JSON.stringify(`Host: ${host}`)}` : '';
        const probe = await exec(
          conn,
          `curl -fsS -m 8${hostArg} -o /dev/null -w '%{http_code}' http://127.0.0.1:${p}/ 2>&1 || true`,
          { silent: true },
        );
        const code = ((probe.out || '').match(/\d{3}/) || [])[0] || '';
        check = { port: p, code };
        if (code === '200') log('info', `  站点自检 http://127.0.0.1:${p}/ → HTTP 200\n`);
        else {
          log(
            'err',
            `  站点自检 http://127.0.0.1:${p}/ → ${code || '无响应'}：文件已经到位，但 nginx 没返回 200。` +
              `去「项目」确认该项目的端口列，改过清单要点「应用更改」。\n`,
          );
        }
      }
    });

    return { ok: true, files: done, check };
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
