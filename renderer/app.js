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
  field(form, 'password').placeholder = profile.hasPassword
    ? '已保存在本地，留空表示不修改'
    : '输入密码后点保存，会加密存在本地';
  field(form, 'passphrase').placeholder = profile.hasPassphrase
    ? '已保存在本地，留空表示不修改'
    : '留空表示不修改';
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
    if (payload.password) {
      if (state.canStoreSecrets) appendLog('ok', '密码已加密保存在本地，之后测试连接、上传、迁移都不必再输入\n');
      else appendLog('err', '系统不支持安全存储，密码没有保存\n');
    }
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
  proj.server = new Map();
  proj.loaded = false;
  renderProjects();
});

// ── tabs ────────────────────────────────────────────────────
const TABS = $$('.tab');
const PANELS = $$('.panel');

function showTab(name) {
  for (const t of TABS) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of PANELS) p.hidden = p.id !== `tab-${name}`;
  if (name === 'project' && !proj.loaded) refreshServerState({ quiet: true });
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
  await refreshServerState({ quiet: true });
});

// ── projects ────────────────────────────────────────────────
const proj = { rows: [], server: new Map(), loaded: false, baseText: '' };
const NAME_RE = /^[a-z][a-z0-9-]{2,30}$/;
const DBNAME_RE = /^[a-z][a-z0-9_]{2,30}$/;

function parseConf(text) {
  const rows = [];
  const names = new Set();
  for (const raw of (text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [name, type, port, domain, api, db] = line.split(/\s+/);
    if (!type) continue;
    rows.push({
      name,
      type,
      port: port || '-',
      domain: domain || '-',
      api: api || '-',
      db: db || 'mysql',
      problems: [],
    });
    names.add(name);
  }

  const seen = new Set();
  for (const r of rows) {
    if (!NAME_RE.test(r.name)) r.problems.push('名称不合法');
    if (seen.has(r.name)) r.problems.push('项目重复');
    seen.add(r.name);
    if (r.type !== 'api' && r.type !== 'web') r.problems.push('类型只支持 api / web');
    if (r.port !== '-' && !/^\d+$/.test(r.port)) r.problems.push('端口不是数字');
    if (r.type === 'web' && r.api !== '-' && !names.has(r.api)) r.problems.push(`上游 ${r.api} 未定义`);
    if (r.type === 'api' && !['mysql', 'none'].includes(r.db) && !DBNAME_RE.test(r.db)) {
      r.problems.push('db 只能是 mysql / none / 库名');
    }
  }
  return rows;
}

function syncProjects() {
  proj.rows = parseConf($('#confText').value);
  renderProjects();
  $('#confDirty').hidden = $('#confText').value === proj.baseText;
}

function makeCell(text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
}

function dbCellOf(row) {
  if (row.type !== 'api') return makeCell('—', 'muted');
  if (row.db === 'none') return makeCell('未启用', 'muted');
  if (!proj.loaded) return makeCell(row.db === 'mysql' ? '待创建' : row.db, 'muted');
  const s = proj.server.get(row.name);
  if (!s || !s.db || s.db === '-') return makeCell('未启用', 'muted');
  if (!s.exists) return makeCell(`${s.db} · 缺失`, 'missing mono');
  return makeCell(`${s.db} · ${s.tables} 表 · ${s.size}`, 'mono');
}

function statusCellOf(row) {
  const td = document.createElement('td');
  const chip = document.createElement('span');
  if (row.problems.length) {
    chip.className = 'chip bad';
    chip.textContent = '配置有误';
    td.title = row.problems.join('；');
  } else if (!proj.loaded) {
    chip.className = 'chip';
    chip.textContent = '未知';
  } else if (proj.server.has(row.name)) {
    chip.className = 'chip ok';
    chip.textContent = '已部署';
  } else {
    chip.className = 'chip warn';
    chip.textContent = '待初始化';
  }
  td.appendChild(chip);
  return td;
}

function actionsCellOf(row) {
  const td = document.createElement('td');
  td.className = 'actions';
  if (row.type !== 'api') return td;
  const deployed = proj.server.has(row.name);
  for (const [action, label] of [['migrate', '迁移'], ['dump', '备份']]) {
    const b = document.createElement('button');
    b.className = 'btn tiny';
    b.textContent = label;
    b.dataset.action = action;
    b.dataset.app = row.name;
    b.disabled = !deployed;
    if (!deployed) b.title = '先在服务器上初始化并部署这个项目';
    td.appendChild(b);
  }
  return td;
}

function renderProjects() {
  const tbody = $('#projTable tbody');
  tbody.textContent = '';

  if (!proj.rows.length) {
    const tr = document.createElement('tr');
    const td = makeCell('还没有项目。点下面「+ 新增项目」，或展开原始配置从本地 / 服务器加载。', 'proj-empty');
    td.colSpan = 8;
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    for (const row of proj.rows) {
      const tr = document.createElement('tr');
      if (row.problems.length) tr.className = 'bad';
      tr.appendChild(makeCell(row.name, 'mono'));

      const typeTd = document.createElement('td');
      const chip = document.createElement('span');
      const kind = row.type === 'api' ? 'api' : row.type === 'web' ? 'web' : 'bad';
      chip.className = `chip ${kind}`;
      chip.textContent = row.type || '?';
      typeTd.appendChild(chip);
      tr.appendChild(typeTd);

      tr.appendChild(makeCell(row.port, 'mono'));
      tr.appendChild(makeCell(row.domain === '-' ? '—' : row.domain, 'mono'));
      tr.appendChild(makeCell(row.api === '-' ? '—' : row.api, 'mono'));
      tr.appendChild(dbCellOf(row));
      tr.appendChild(statusCellOf(row));
      tr.appendChild(actionsCellOf(row));
      tbody.appendChild(tr);
    }
  }

  const api = proj.rows.filter((r) => r.type === 'api').length;
  const web = proj.rows.filter((r) => r.type === 'web').length;
  const bad = proj.rows.filter((r) => r.problems.length).length;
  const deployed = proj.rows.filter((r) => proj.server.has(r.name)).length;

  const parts = [];
  if (proj.rows.length) {
    parts.push(`${proj.rows.length} 个项目`, `${api} 后端`, `${web} 前端`);
    parts.push(proj.loaded ? `已部署 ${deployed}/${proj.rows.length}` : '服务器状态未加载');
  } else {
    parts.push('配置为空');
  }
  if (bad) parts.push(`${bad} 行有误`);

  const summary = $('#projSummary');
  summary.textContent = parts.join(' · ');
  summary.style.color = bad ? 'var(--err)' : '';
}

async function refreshServerState({ quiet = false } = {}) {
  if (!state.activeId) {
    if (!quiet) appendLog('err', '先在「服务器」页选择一个连接\n');
    return false;
  }
  const r = await window.api.db.list(state.activeId);
  if (!r.ok) {
    if (!quiet) appendLog('err', `读取服务器项目失败: ${r.error}\n`);
    proj.loaded = false;
    renderProjects();
    return false;
  }
  proj.server = new Map(r.rows.map((row) => [row.name, row]));
  proj.loaded = true;
  renderProjects();
  return true;
}

async function runDbAction(action, app, btn) {
  if (!state.activeId) {
    appendLog('err', '先选择一个连接\n');
    return;
  }
  const label = action === 'migrate' ? '迁移' : '备份';
  setBusy(btn, true, '…');
  const r = await window.api.db.run({ id: state.activeId, app, action });
  setBusy(btn, false);
  if (!r.ok) {
    appendLog('err', `${app} ${label}失败: ${r.error || `退出码 ${r.code}`}\n`);
    return;
  }
  appendLog('ok', `${app} ${label}完成\n`);
  if (action === 'migrate') await refreshServerState({ quiet: true });
}

// ── projects.conf ───────────────────────────────────────────
function setConfPath(p) {
  $('#confPathHint').textContent = p ? `来源：${p}` : '';
}

async function loadConf() {
  const r = await window.api.conf.load();
  $('#confText').value = r.text || '';
  proj.baseText = $('#confText').value;
  setConfPath(r.path);
  syncProjects();
}

$('#confText').addEventListener('input', syncProjects);

$('#btnToggleConf').addEventListener('click', () => {
  const box = $('#confBox');
  box.hidden = !box.hidden;
  $('#btnToggleConf').classList.toggle('open', !box.hidden);
});

function nextProjectName() {
  const used = new Set(proj.rows.map((r) => r.name));
  if (!used.has('new-api')) return 'new-api';
  for (let i = 2; i < 100; i += 1) {
    if (!used.has(`new-api-${i}`)) return `new-api-${i}`;
  }
  return 'new-api';
}

$('#btnAddProject').addEventListener('click', () => {
  const box = $('#confBox');
  box.hidden = false;
  $('#btnToggleConf').classList.add('open');
  const ta = $('#confText');
  const sep = ta.value && !ta.value.endsWith('\n') ? '\n' : '';
  ta.value += `${sep}${nextProjectName().padEnd(11)} api   -      -                   -           mysql\n`;
  syncProjects();
  ta.focus();
  ta.scrollTop = ta.scrollHeight;
});

$('#btnLoadLocalConf').addEventListener('click', async () => {
  const r = await window.api.conf.pickFile();
  if (!r.ok) {
    if (!r.canceled) appendLog('err', `${r.error || '读取失败'}\n`);
    return;
  }
  $('#confText').value = r.text;
  proj.baseText = r.text;
  setConfPath(r.path);
  syncProjects();
  appendLog('info', `已从本地加载 ${r.path}\n`);
});

$('#btnSaveLocalConf').addEventListener('click', async () => {
  const r = await window.api.conf.saveAs($('#confText').value);
  if (!r.ok) {
    if (!r.canceled) appendLog('err', `${r.error || '保存失败'}\n`);
    return;
  }
  proj.baseText = $('#confText').value;
  syncProjects();
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
  const bad = proj.rows.filter((r) => r.problems.length);
  if (bad.length) {
    appendLog('err', `有 ${bad.length} 行配置不对，先改掉再应用\n`);
    return;
  }

  const btn = e.currentTarget;
  setBusy(btn, true, '应用中…');
  await window.api.conf.save(text);
  const r = await window.api.conf.apply({ id: state.activeId, text, scriptsDir });
  setBusy(btn, false);
  if (r.ok) {
    proj.baseText = text;
    syncProjects();
    appendLog('ok', '\napply.sh 执行成功\n');
    await refreshServerState({ quiet: true });
  } else {
    appendLog('err', `\n执行失败: ${r.error || `退出码 ${r.code}`}\n`);
  }
});

$('#btnDownloadConf').addEventListener('click', async (e) => {
  if (!state.activeId) return;
  const btn = e.currentTarget;
  setBusy(btn, true, '下载中…');
  const r = await window.api.conf.download(state.activeId);
  setBusy(btn, false);
  if (r.ok) {
    $('#confText').value = r.text;
    proj.baseText = r.text;
    setConfPath('/opt/deploy/projects.conf（服务器）');
    syncProjects();
    appendLog('ok', '已从服务器下载 projects.conf\n');
  } else appendLog('err', r.error + '\n');
});

$('#btnProjRefresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  setBusy(btn, true, '刷新中…');
  const ok = await refreshServerState();
  setBusy(btn, false);
  if (ok) appendLog('ok', '服务器项目状态已刷新\n');
});

$('#projTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;
  await runDbAction(btn.dataset.action, btn.dataset.app, btn);
});

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
