const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const field = (form, name) => form.elements[name];

const state = { profiles: [], activeId: null, canStoreSecrets: true };
const consoleEl = $('#console');

function appendLog(kind, text) {
  const span = document.createElement('span');
  if (kind === 'err') span.className = 'err';
  else if (kind === 'info') span.className = 'info';
  else if (kind === 'ok') span.className = 'ok';
  span.textContent = text;
  consoleEl.appendChild(span);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

window.api.onLog(({ kind, text }) => appendLog(kind || 'out', text));

function setBusy(btn, busy, label) {
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.textContent = label || '处理中…';
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
}

function dot(stateName) {
  const el = $('#connDot');
  el.className = 'dot' + (stateName === 'on' ? ' on' : stateName === 'off' ? ' off' : '');
  el.title = stateName === 'on' ? '已连接' : stateName === 'off' ? '连接失败' : '未连接';
}

// ── persisted settings ──────────────────────────────────────
const SETTING_FIELDS = {
  scriptsDir: '#scriptsDir',
  repoDir: '#repoDir',
  distDir: '#distDir',
  gitRemote: '#gitRemote',
  gitBranch: '#gitBranch',
  webTarget: '#webTarget',
};

function applySettings(s) {
  for (const [k, sel] of Object.entries(SETTING_FIELDS)) {
    if (typeof s[k] === 'string') $(sel).value = s[k];
  }
  if (typeof s.webClean === 'boolean') $('#webClean').checked = s.webClean;
}

function persistSettings(payload) {
  window.api.settings.save(payload);
}

for (const [k, sel] of Object.entries(SETTING_FIELDS)) {
  $(sel).addEventListener('change', (e) => persistSettings({ [k]: e.target.value.trim() }));
}
$('#webClean').addEventListener('change', (e) => persistSettings({ webClean: e.target.checked }));

// ── profiles ────────────────────────────────────────────────
async function refreshProfiles(selectId) {
  const data = await window.api.profiles.list();
  state.profiles = data.profiles;
  state.canStoreSecrets = data.canStoreSecrets;

  const select = $('#profileSelect');
  select.innerHTML = '';
  for (const p of data.profiles) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name || p.host} (${p.username}@${p.host}:${p.port})`;
    select.appendChild(opt);
  }

  state.activeId = selectId || data.lastProfileId || data.profiles[0]?.id || null;
  if (state.activeId) select.value = state.activeId;

  applySettings(data.settings || {});
  $('#secretHint').textContent = data.canStoreSecrets
    ? '密码/私钥口令会加密保存在系统凭据中'
    : '系统不支持安全存储，密码不会保存';

  fillForm(data.profiles.find((p) => p.id === state.activeId));
}

function fillForm(profile) {
  const form = $('#profileForm');
  form.reset();
  if (!profile) return;
  field(form, 'name').value = profile.name || '';
  field(form, 'host').value = profile.host || '';
  field(form, 'port').value = profile.port || 22;
  field(form, 'username').value = profile.username || '';
  field(form, 'auth').value = profile.auth || 'key';
  field(form, 'keyPath').value = profile.keyPath || '';
  syncAuthFields();
}

function syncAuthFields() {
  const auth = field($('#profileForm'), 'auth').value;
  for (const el of $$('[data-auth]')) el.hidden = el.dataset.auth !== auth;
}

field($('#profileForm'), 'auth').addEventListener('change', syncAuthFields);

$('#profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = {
    id: state.activeId,
    name: field(form, 'name').value,
    host: field(form, 'host').value,
    port: Number(field(form, 'port').value) || 22,
    username: field(form, 'username').value,
    auth: field(form, 'auth').value,
    keyPath: field(form, 'keyPath').value,
    passphrase: field(form, 'passphrase').value || undefined,
    password: field(form, 'password').value || undefined,
  };
  const r = await window.api.profiles.save(payload);
  if (r.ok) {
    appendLog('info', `已保存连接 ${r.profile.name}\n`);
    field(form, 'passphrase').value = '';
    field(form, 'password').value = '';
    await refreshProfiles(r.profile.id);
  } else {
    appendLog('err', `保存失败: ${r.error || ''}\n`);
  }
});

$('#btnDeleteProfile').addEventListener('click', async () => {
  if (!state.activeId) return;
  await window.api.profiles.remove(state.activeId);
  appendLog('info', '已删除连接\n');
  await refreshProfiles();
});

$('#btnNewProfile').addEventListener('click', () => {
  state.activeId = null;
  $('#profileForm').reset();
  field($('#profileForm'), 'port').value = 22;
  syncAuthFields();
});

$('#profileSelect').addEventListener('change', (e) => {
  state.activeId = e.target.value;
  fillForm(state.profiles.find((p) => p.id === state.activeId));
});

// ── tabs ────────────────────────────────────────────────────
const TABS = $$('.tab');
const PANELS = $$('.panel');

function showTab(name) {
  for (const t of TABS) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of PANELS) p.hidden = p.id !== `tab-${name}`;
}

for (const t of TABS) t.addEventListener('click', () => showTab(t.dataset.tab));

// ── server ──────────────────────────────────────────────────
$('#btnTest').addEventListener('click', async (e) => {
  if (!state.activeId) return;
  const btn = e.currentTarget;
  setBusy(btn, true, '连接中…');
  dot('off');
  const r = await window.api.server.test(state.activeId);
  setBusy(btn, false);
  if (r.ok) {
    dot('on');
    appendLog('ok', r.out + '\n');
  } else {
    dot('off');
    appendLog('err', r.error + '\n');
  }
});

$('#btnProbe').addEventListener('click', async (e) => {
  if (!state.activeId) return;
  const btn = e.currentTarget;
  setBusy(btn, true, '采集中…');
  const r = await window.api.server.probe(state.activeId);
  setBusy(btn, false);
  if (!r.ok) {
    dot('off');
    appendLog('err', r.error + '\n');
    return;
  }
  dot('on');
  $('#st-node').textContent = r.node;
  $('#st-pnpm').textContent = r.pnpm;
  $('#st-nginx').textContent = r.nginx;
  $('#st-mysql').textContent = r.mysql;
  const [mem, swap] = (r.mem || '').split('\n');
  $('#st-mem').textContent = `${mem || '?'} MB / swap ${swap || '0'} MB (${r.swapFiles} 个 swap 文件)`;
  $('#st-svc').textContent = r.services.join(', ') || '无';
  $('#st-ports').textContent = r.ports.join(', ') || '无';
  $('#st-apps').textContent = r.apps.join(', ') || '无';
  $('#st-repos').textContent = r.repos.length ? `${r.repos.join(', ')} (钩子 ${r.hooks})` : '无';
  appendLog('ok', '状态采集完成\n');
});

// ── projects.conf ───────────────────────────────────────────
function setConfPath(p) {
  $('#confPathHint').textContent = p ? `当前来源：${p}` : '';
}

async function loadConf() {
  const r = await window.api.conf.load();
  $('#confText').value = r.text || '';
  setConfPath(r.path);
}

$('#btnLoadLocalConf').addEventListener('click', async () => {
  const r = await window.api.conf.pickFile();
  if (!r.ok) {
    if (!r.canceled) appendLog('err', `${r.error || '读取失败'}\n`);
    return;
  }
  $('#confText').value = r.text;
  setConfPath(r.path);
  appendLog('info', `已从本地加载 ${r.path}\n`);
});

$('#btnSaveLocalConf').addEventListener('click', async () => {
  const r = await window.api.conf.saveAs($('#confText').value);
  if (!r.ok) {
    if (!r.canceled) appendLog('err', `${r.error || '保存失败'}\n`);
    return;
  }
  setConfPath(r.path);
  appendLog('ok', `已保存到 ${r.path}\n`);
});

$('#btnApplyConf').addEventListener('click', async (e) => {
  if (!state.activeId) {
    appendLog('err', '先选择一个连接\n');
    return;
  }
  const text = $('#confText').value;
  const scriptsDir = $('#scriptsDir').value.trim();
  if (!text.trim()) {
    appendLog('err', 'projects.conf 是空的\n');
    return;
  }
  const btn = e.currentTarget;
  setBusy(btn, true, '应用中…');
  await window.api.conf.save(text);
  const r = await window.api.conf.apply({ id: state.activeId, text, scriptsDir });
  setBusy(btn, false);
  if (r.ok) appendLog('ok', '\napply.sh 执行成功\n');
  else appendLog('err', `\n执行失败: ${r.error || `退出码 ${r.code}`}\n`);
});

$('#btnDownloadConf').addEventListener('click', async (e) => {
  if (!state.activeId) return;
  const btn = e.currentTarget;
  setBusy(btn, true, '下载中…');
  const r = await window.api.conf.download(state.activeId);
  setBusy(btn, false);
  if (r.ok) {
    $('#confText').value = r.text;
    setConfPath('/opt/deploy/projects.conf（服务器）');
    appendLog('ok', '已从服务器下载 projects.conf\n');
  } else appendLog('err', r.error + '\n');
});

// ── database ────────────────────────────────────────────────
function renderDbRows(rows) {
  const tbody = $('#dbTable tbody');
  const sel = $('#dbProject');
  const prev = sel.value;
  tbody.textContent = '';
  sel.textContent = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    const cells = [
      [row.name, ''],
      [row.db || '—', 'muted'],
      [row.exists ? '已建库' : '缺失', row.exists ? 'present' : 'missing'],
      [row.size || '-', 'muted'],
      [row.tables || '-', 'muted'],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      if (cls) td.className = cls;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    const opt = document.createElement('option');
    opt.value = row.name;
    opt.textContent = row.db ? `${row.name} (${row.db})` : `${row.name} (无数据库)`;
    sel.appendChild(opt);
  }
  if (prev) sel.value = prev;
}

$('#btnDbRefresh').addEventListener('click', async (e) => {
  if (!state.activeId) {
    appendLog('err', '先选择一个连接\n');
    return;
  }
  const btn = e.currentTarget;
  setBusy(btn, true, '刷新中…');
  const r = await window.api.db.list(state.activeId);
  setBusy(btn, false);
  if (!r.ok) {
    appendLog('err', `${r.error}\n`);
    return;
  }
  renderDbRows(r.rows);
  appendLog('ok', `数据库清单已刷新（${r.rows.length} 个项目）\n`);
});

async function runDbAction(action, label) {
  if (!state.activeId) {
    appendLog('err', '先选择一个连接\n');
    return null;
  }
  const app = $('#dbProject').value;
  if (!app) {
    appendLog('err', '先刷新清单并选一个项目\n');
    return null;
  }
  const btn = $(action === 'migrate' ? '#btnDbMigrate' : '#btnDbBackup');
  setBusy(btn, true, `${label}中…`);
  const r = await window.api.db.run({ id: state.activeId, app, action });
  setBusy(btn, false);
  if (!r.ok) appendLog('err', `${r.error || `退出码 ${r.code}`}\n`);
  else appendLog('ok', `${label}完成\n`);
  return r;
}

$('#btnDbMigrate').addEventListener('click', () => runDbAction('migrate', '迁移'));
$('#btnDbBackup').addEventListener('click', () => runDbAction('dump', '备份'));

$('#btnPickScripts').addEventListener('click', async () => {
  const dir = await window.api.pickDir();
  if (!dir) return;
  $('#scriptsDir').value = dir;
  persistSettings({ scriptsDir: dir });
});

// ── publish ─────────────────────────────────────────────────
$('#btnPickRepo').addEventListener('click', async () => {
  const dir = await window.api.pickDir();
  if (!dir) return;
  $('#repoDir').value = dir;
  persistSettings({ repoDir: dir });
});

$('#btnPickDist').addEventListener('click', async () => {
  const dir = await window.api.pickDir();
  if (!dir) return;
  $('#distDir').value = dir;
  persistSettings({ distDir: dir });
});

$('#btnPush').addEventListener('click', async (e) => {
  const repoDir = $('#repoDir').value.trim();
  if (!repoDir) {
    appendLog('err', '先选择仓库目录\n');
    return;
  }
  const btn = e.currentTarget;
  setBusy(btn, true, '推送中…');
  const r = await window.api.deploy.push({
    repoDir,
    remote: $('#gitRemote').value.trim() || 'deploy',
    branch: $('#gitBranch').value.trim() || 'master',
  });
  setBusy(btn, false);
  if (r.ok) appendLog('ok', '推送完成，服务器钩子已接管构建\n');
  else appendLog('err', `推送失败${r.code ? `（退出码 ${r.code}）` : ''}\n`);
});

$('#btnUpload').addEventListener('click', async (e) => {
  if (!state.activeId) {
    appendLog('err', '先选择一个连接\n');
    return;
  }
  const localDir = $('#distDir').value.trim();
  const remoteDir = $('#webTarget').value.trim();
  if (!localDir || !remoteDir) {
    appendLog('err', 'dist 目录和目标目录都要填\n');
    return;
  }
  const btn = e.currentTarget;
  setBusy(btn, true, '上传中…');
  const r = await window.api.web.upload({
    id: state.activeId,
    localDir,
    remoteDir,
    clean: $('#webClean').checked,
  });
  setBusy(btn, false);
  if (r.ok) appendLog('ok', `已上传 ${r.files} 个文件\n`);
  else appendLog('err', r.error + '\n');
});

$('#btnClear').addEventListener('click', () => {
  consoleEl.textContent = '';
});

// ── boot ────────────────────────────────────────────────────
(async () => {
  await refreshProfiles();
  await loadConf();
  syncAuthFields();
})();
