const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const field = (form, name) => form.elements[name];

const state = { profiles: [], activeId: null, canStoreSecrets: true };
// declared up here because syncWebTargets() reads it while settings are applied
const proj = { rows: [], server: new Map(), ports: new Set(), loaded: false, baseText: '', nginxLoaded: false, published: false };
const consoleEl = $('#console');

const logTail = new Map();
const logTimers = new Map();

function writeLine(kind, line) {
  if (!line) {
    consoleEl.appendChild(document.createTextNode('\n'));
    return;
  }
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const span = document.createElement('span');
  if (kind === 'err') span.className = 'err';
  else if (kind === 'info') span.className = 'info';
  else if (kind === 'ok') span.className = 'ok';
  span.textContent = line;
  consoleEl.appendChild(ts);
  consoleEl.appendChild(span);
  consoleEl.appendChild(document.createTextNode('\n'));
}

function flushTail(kind) {
  const rest = logTail.get(kind);
  logTail.set(kind, '');
  if (rest) writeLine(kind, rest);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function appendLog(kind, text) {
  const buf = (logTail.get(kind) || '') + String(text).replace(/\r/g, '');
  const parts = buf.split('\n');
  logTail.set(kind, parts.pop());
  for (const line of parts) writeLine(kind, line);
  markLogActivity(kind, text);

  clearTimeout(logTimers.get(kind));
  if (logTail.get(kind)) logTimers.set(kind, setTimeout(() => flushTail(kind), 150));
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

// 日志默认收起，输出落在看不见的面板里，所以按钮上留个提示点：有输出变蓝，报错变红
function markLogActivity(kind, text) {
  if (!String(text || '').trim() || !document.body.classList.contains('log-hidden')) return;
  const btn = $('#btnLogShow');
  btn.classList.add('has-log');
  if (kind === 'err') btn.classList.add('has-err');
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
  repoDir: '#repoDir',
  distDir: '#distDir',
  webTarget: '#webTarget',
  webTargetProject: '#webTargetProject',
};

const CUSTOM_TARGET = '__custom__';

// 后端发布的选择项由仓库本身决定，启动时先收下上次用过的值，
// 等 git:inspect 读到真实远端/分支后再回填，避免被空下拉冲掉。
const repoDirs = new Map(); // 项目名 → 本地仓库目录
let pushProjectName = '';
let preferredRemote = '';
let preferredBranch = '';

// Single source of truth for where a web project lives, mirroring the nginx
// root that apply.sh writes. Custom paths stay as an escape hatch for sites
// that are not in the project table.
const webDirOf = (name) => `/var/www/${name}`;

function syncWebTargets() {
  const sel = $('#webTargetProject');
  const wanted = sel.value;
  const names = proj.rows.filter((r) => r.type === 'web').map((r) => r.name);
  sel.textContent = '';

  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name}  →  ${webDirOf(name)}`;
    sel.appendChild(opt);
  }
  const custom = document.createElement('option');
  custom.value = CUSTOM_TARGET;
  custom.textContent = '自定义路径…';
  sel.appendChild(custom);

  if (wanted === CUSTOM_TARGET || (wanted && !names.includes(wanted))) sel.value = CUSTOM_TARGET;
  else if (wanted && names.includes(wanted)) sel.value = wanted;
  else sel.value = names.length ? names[0] : CUSTOM_TARGET;

  $('#webTargetRow').hidden = sel.value !== CUSTOM_TARGET;
}

function webRemoteDir() {
  const sel = $('#webTargetProject');
  if (sel.value === CUSTOM_TARGET || sel.value === '') return $('#webTarget').value.trim();
  return webDirOf(sel.value);
}

function applySettings(s) {
  for (const [k, sel] of Object.entries(SETTING_FIELDS)) {
    if (typeof s[k] === 'string') $(sel).value = s[k];
  }
  if (typeof s.pushProject === 'string') pushProjectName = s.pushProject;
  if (typeof s.gitRemote === 'string') preferredRemote = s.gitRemote;
  if (typeof s.gitBranch === 'string') preferredBranch = s.gitBranch;
  if (s.repoDirs && typeof s.repoDirs === 'object') {
    for (const [k, v] of Object.entries(s.repoDirs)) {
      if (typeof v === 'string') repoDirs.set(k, v);
    }
  }
  if (typeof s.webClean === 'boolean') $('#webClean').checked = s.webClean;
  if (s.logPanel === 'on') setLogVisible(true, false);
  const theme = typeof s.theme === 'string' ? s.theme : 'system';
  $('#themeSelect').value = theme;
  applyTheme(theme);
  syncWebTargets();
}

function persistSettings(payload) {
  window.api.settings.save(payload);
}

for (const [k, sel] of Object.entries(SETTING_FIELDS)) {
  $(sel).addEventListener('change', (e) => persistSettings({ [k]: e.target.value.trim() }));
}
$('#webClean').addEventListener('change', (e) => persistSettings({ webClean: e.target.checked }));
$('#webTargetProject').addEventListener('change', () => {
  $('#webTargetRow').hidden = $('#webTargetProject').value !== CUSTOM_TARGET;
});

// ── theme ───────────────────────────────────────────────────
const themeMedia = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme(mode) {
  const resolved = mode === 'light' || mode === 'dark' ? mode : themeMedia.matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = resolved;
}

$('#themeSelect').addEventListener('change', (e) => {
  applyTheme(e.target.value);
  persistSettings({ theme: e.target.value });
});

themeMedia.addEventListener('change', () => {
  if ($('#themeSelect').value === 'system') applyTheme('system');
});

// ── 日志面板收起/展开：默认收起，需要时点右下角按钮展开，选择记住 ──
function setLogVisible(on, persist = true) {
  document.body.classList.toggle('log-hidden', !on);
  $('#btnLogShow').hidden = on;
  if (on) $('#btnLogShow').classList.remove('has-log', 'has-err');
  if (persist) persistSettings({ logPanel: on ? 'on' : 'off' });
}

$('#btnLogHide').addEventListener('click', () => setLogVisible(false));
$('#btnLogShow').addEventListener('click', () => setLogVisible(true));

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
    opt.textContent = p.name || p.host;
    opt.title = `${p.name || p.host} (${p.username}@${p.host}:${p.port})`;
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
  field(form, 'password').type = 'password';
  $('#btnShowPwd').textContent = '显示';
  if (!profile) return;
  field(form, 'name').value = profile.name || '';
  field(form, 'host').value = profile.host || '';
  field(form, 'port').value = profile.port || 22;
  field(form, 'username').value = profile.username || '';
  field(form, 'auth').value = profile.auth || 'key';
  field(form, 'keyPath').value = profile.keyPath || '';
  // 明文不出主进程：表单不回填已存密码，点「显示」按需解密；留空保存 = 保留原值
  field(form, 'password').placeholder = profile.hasPassword
    ? '已保存，可直接修改'
    : '输入密码后点保存';
  field(form, 'passphrase').placeholder = profile.hasPassphrase
    ? '已保存，可直接修改'
    : '可选';
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
      if (state.canStoreSecrets) appendLog('ok', '密码已加密保存，下次打开会直接回填\n');
      else appendLog('err', '系统不支持安全存储，密码没有保存\n');
    }
    await refreshProfiles(r.profile.id);
    if (!proj.rows.length) appendLog('info', '下一步：左侧点「项目」，用「+ 新增项目」加你的第一个项目\n');
  } else {
    appendLog('err', `保存失败: ${r.error || ''}\n`);
  }
});

$('#btnShowPwd').addEventListener('click', async (e) => {
  const input = field($('#profileForm'), 'password');
  const show = input.type === 'password';
  if (show && !input.value) {
    // 用户正在输入的值直接显示；只有空字段才去主进程按需解密已存密码
    const p = state.profiles.find((x) => x.id === state.activeId);
    if (p?.hasPassword) {
      const r = await window.api.profiles.reveal({ id: state.activeId, field: 'password' });
      if (r.ok) input.value = r.secret;
      else appendLog('err', `读取已存密码失败: ${r.error}\n`);
    }
  }
  input.type = show ? 'text' : 'password';
  e.currentTarget.textContent = show ? '隐藏' : '显示';
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

$('#profileSelect').addEventListener('change', async (e) => {
  if (confDirty() && !confirm('当前配置有未应用的修改，切换连接会丢弃这些修改。继续？')) {
    e.target.value = state.activeId;
    return;
  }
  state.activeId = e.target.value;
  fillForm(state.profiles.find((p) => p.id === state.activeId));
  proj.server = new Map();
  proj.ports = new Set();
  proj.loaded = false;
  proj.published = false;
  repoInfo = null; // 换了服务器，远端是否指向这台机器要重新判断
  resetNginx();
  await loadConf(state.activeId);
  await syncConfFromServer();
  await refreshServerState({ quiet: true });
});

// ── tabs ────────────────────────────────────────────────────
const TABS = $$('.nav-item');
const PANELS = $$('.panel');

function showTab(name) {
  for (const t of TABS) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of PANELS) p.hidden = p.id !== `tab-${name}`;
  if (name === 'project' && !proj.loaded) {
    refreshServerState({ quiet: true });
    syncConfFromServer();
  }
}

for (const t of TABS) t.addEventListener('click', () => showTab(t.dataset.tab));
$('#btnManageConn').addEventListener('click', () => showTab('config'));

$('#projSteps').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-step]');
  if (!li) return;
  const key = li.dataset.step;
  if (key === 'connect') showTab('config');
  else if (key === 'conf') {
    $('#projTable').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const trs = document.querySelectorAll('#projTable tbody tr');
    trs[trs.length - 1]?.querySelector('input[data-field="name"]')?.focus();
  } else if (key === 'apply') {
    $('#btnApplyConf').focus();
    $('#btnApplyConf').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } else if (key === 'publish') openPub();
});

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

  // 新手关键一步：服务器缺依赖时，在状态卡里直接给出缺什么、怎么装，
  // 而不是等「应用更改」时神秘失败
  const isMissing = (s) => !s || /missing|not found|not installed|无法|找不到/i.test(String(s));
  const tips = [];
  if (isMissing(r.node)) tips.push('Node.js 20+（建议用 nvm 装）');
  if (isMissing(r.pnpm)) tips.push('pnpm（corepack enable 或 npm i -g pnpm）');
  if (isMissing(r.nginx)) tips.push('Nginx（apt install -y nginx）');
  const needMysql = proj.rows.some((x) => x.type === 'api' && x.db !== 'none');
  if (needMysql && isMissing(r.mysql)) tips.push('MySQL（apt install -y mysql-server）');
  const stHint = $('#stHint');
  if (tips.length) {
    stHint.textContent = `服务器还缺：${tips.join('；')}。装好再点「应用更改」。`;
    stHint.hidden = false;
  } else {
    stHint.hidden = true;
  }

  appendLog('ok', '状态采集完成\n');
  await refreshServerState({ quiet: true });
});

// ── projects ────────────────────────────────────────────────
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
  const seenPorts = new Map(); // 端口 → 先出现的项目名，与 apply.sh 的 by_port 一致
  const byDomain = new Map(); // 归一化域名 → 行数组
  for (const r of rows) {
    if (!NAME_RE.test(r.name)) r.problems.push('名称不合法');
    if (seen.has(r.name)) r.problems.push('项目重复');
    seen.add(r.name);
    if (r.type !== 'api' && r.type !== 'web') r.problems.push('类型只支持 api / web');
    if (r.port !== '-' && !/^\d+$/.test(r.port)) r.problems.push('端口不是数字');
    if (r.port !== '-' && /^\d+$/.test(r.port)) {
      const other = seenPorts.get(r.port);
      if (other) r.problems.push(`端口与 ${other} 重复`);
      else seenPorts.set(r.port, r.name);
    }
    // 和 apply.sh 一致：域名去掉 http(s):// 和结尾斜杠后再查重
    const dom = r.domain === '-' ? '' : r.domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (dom) {
      if (!byDomain.has(dom)) byDomain.set(dom, []);
      byDomain.get(dom).push(r);
    }
    if (r.type === 'web' && r.api !== '-' && !names.has(r.api)) r.problems.push(`上游 ${r.api} 未定义`);
    if (r.type === 'api' && !['mysql', 'none'].includes(r.db) && !DBNAME_RE.test(r.db)) {
      r.problems.push('db 只能是 mysql / none / 库名');
    }
  }
  // 同域名多行：只放行"每行都是 web 且都写了显式端口"的场合（nginx 按
  // listen 端口区分站点），与 apply.sh 的放行规则一致；端口互不相同由
  // 上面的端口查重保证。
  for (const group of byDomain.values()) {
    if (group.length < 2) continue;
    if (group.every((r) => r.type === 'web' && /^\d+$/.test(r.port))) continue;
    for (const r of group) {
      const other = group.find((x) => x !== r);
      r.problems.push(`域名与 ${other ? other.name : '其他项目'} 重复（共用域名需每行都是 web 且写不同端口）`);
    }
  }
  return rows;
}

function syncProjects() {
  proj.rows = parseConf($('#confText').value);
  renderProjects();
  $('#confDirty').hidden = $('#confText').value === proj.baseText;
}

// 清单第 pos 个项目对应文本框的物理行号（跳过注释/空行/残行，与 parseConf 一致）
function lineIndexAt(pos) {
  const lines = $('#confText').value.split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    if (!t.split(/\s+/)[1]) continue; // 只有名称没有类型的残行两边都跳过
    seen += 1;
    if (seen === pos) return i;
  }
  return -1;
}

function rowToLine(r) {
  return `${String(r.name).padEnd(11)} ${String(r.type).padEnd(5)} ${String(r.port).padEnd(6)} ${String(r.domain).padEnd(19)} ${String(r.api).padEnd(11)} ${String(r.db)}`;
}

// 已部署的行改「名称/数据库」= 服务器上会新建项目，需确认后才能落盘
function dangerousChange(r, field) {
  return (field === 'name' || field === 'db') && proj.server.has(r.name);
}

// 单元格编辑：改模型 → 精准替换那一行文本 → 轻量刷新（不重建表格，输入不打断）
function gridEdit(idx, field, raw) {
  const r = proj.rows[idx];
  if (!r || !['name', 'type', 'port', 'domain', 'api', 'db'].includes(field)) return;
  let v = String(raw).trim();
  if (field === 'name') {
    if (!v) return; // 空名不落盘
  } else if (v === '') {
    v = '-';
  }
  if (field === 'type') lastNewType = v; // 记住类型，下次新增行沿用
  r[field] = v;
  const ta = $('#confText');
  const i = lineIndexAt(idx);
  if (i >= 0) {
    const lines = ta.value.split('\n');
    lines[i] = rowToLine(r);
    ta.value = lines.join('\n');
  }
  $('#confDirty').hidden = ta.value === proj.baseText;
  proj.rows = parseConf(ta.value);
  updateRowBad(idx);
  updateDerivedUI();
}

function updateRowBad(idx) {
  const tr = document.querySelector(`#projTable tbody tr[data-idx="${idx}"]`);
  const row = proj.rows[idx];
  if (!tr || !row) return;
  tr.classList.toggle('bad', row.problems.length > 0);
  const nameInp = tr.querySelector('input[data-field="name"]');
  if (nameInp) {
    nameInp.classList.toggle('cell-bad', row.problems.length > 0);
    nameInp.title = row.problems.join('；');
  }
}

function statusCellOf(row) {
  const td = document.createElement('td');
  td.className = 'c-st';
  const st = document.createElement('span');
  st.className = 'st';
  const s = proj.server.get(row.name);
  const files = Number(s?.files);
  if (row.problems.length) {
    st.classList.add('bad');
    st.textContent = '配置有误';
    td.title = row.problems.join('；');
  } else if (!proj.loaded) {
    st.textContent = '未知';
  } else if (!proj.server.has(row.name)) {
    st.classList.add('warn');
    st.textContent = row.type === 'web' ? '未发布' : '待初始化';
  } else if (row.type === 'web' && Number.isFinite(files) && files === 0) {
    // apply.sh 建了目录但没上传过内容
    st.classList.add('warn');
    st.textContent = '空目录';
    td.title = `/var/www/${row.name} 还没有内容，点行内「发布」上传 dist`;
  } else if (row.type === 'api' && row.port !== '-' && proj.ports.size && !proj.ports.has(row.port)) {
    st.classList.add('warn');
    st.textContent = '未监听';
    td.title = `端口 ${row.port} 没有在监听，服务可能没起来`;
  } else {
    st.classList.add('ok');
    st.textContent = row.type === 'web' ? '已发布' : '已部署';
    if (row.type === 'web') td.title = `/var/www/${row.name}（${files} 个文件）`;
  }
  td.appendChild(st);
  // 数据库实况并进状态列：api 行小字显示表数/大小/缺库
  if (row.type === 'api' && s) {
    const sub = document.createElement('div');
    sub.className = 'psub';
    if (!s.db || s.db === '-') {
      sub.textContent = '无数据库';
    } else if (!s.exists) {
      sub.textContent = `缺库 ${s.db}`;
      sub.classList.add('missing');
    } else {
      sub.textContent = `${s.tables} 表 · ${s.size}`;
    }
    td.appendChild(sub);
  }
  return td;
}

function projectUrl(row) {
  if (!row.domain || row.domain === '-') return null;
  // api 站点固定 listen 80；web 的端口列就是对外端口（同域名多站点靠它区分），
  // 「复制」要把端口带上，不然复制出去的非 80 地址会打到别的站点去
  const m = String(row.domain).match(/^(https?):\/\/(.+?)(\/*)$/);
  const proto = m ? m[1] : 'http';
  const host = m ? m[2] : row.domain;
  const listen = row.type === 'web' && /^\d+$/.test(row.port || '') ? Number(row.port) : proto === 'https' ? 443 : 80;
  const dflt = proto === 'https' ? 443 : 80;
  return `${proto}://${host}${listen === dflt ? '' : `:${listen}`}`;
}

// 可编辑行：每列直接是输入框/下拉，改完即写回清单
function gridRowOf(row, idx) {
  const tr = document.createElement('tr');
  tr.dataset.idx = String(idx);
  if (row.problems.length) tr.className = 'bad';

  const apis = proj.rows.filter((r) => r.type === 'api' && r.name !== row.name).map((r) => r.name);

  const tdName = document.createElement('td');
  tdName.className = 'c-name';
  const nameInp = document.createElement('input');
  nameInp.dataset.field = 'name';
  nameInp.value = row.name;
  nameInp.spellcheck = false;
  if (row.problems.length) {
    nameInp.title = row.problems.join('；');
    nameInp.classList.add('cell-bad');
  }
  tdName.appendChild(nameInp);
  tr.appendChild(tdName);

  const tdType = document.createElement('td');
  tdType.className = 'c-type';
  const typeSel = document.createElement('select');
  typeSel.dataset.field = 'type';
  for (const [v, label] of [['web', 'web 前端'], ['api', 'api 后端']]) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    typeSel.appendChild(o);
  }
  typeSel.value = row.type === 'api' ? 'api' : 'web';
  tdType.appendChild(typeSel);
  tr.appendChild(tdType);

  const tdPort = document.createElement('td');
  tdPort.className = 'c-port';
  const portInp = document.createElement('input');
  portInp.dataset.field = 'port';
  portInp.value = row.port === '-' ? '' : row.port;
  portInp.placeholder = row.type === 'api' ? '自动' : '80';
  portInp.spellcheck = false;
  portInp.title = row.port === '-' ? '' : row.port; // 列窄被截断时悬停看全
  tdPort.appendChild(portInp);
  tr.appendChild(tdPort);

  tr.appendChild(statusCellOf(row));

  const tdDb = document.createElement('td');
  tdDb.className = 'c-db';
  if (row.type === 'api') {
    const dbSel = document.createElement('select');
    dbSel.dataset.field = 'db';
    for (const [v, label] of [['mysql', '自动'], ['none', '不建']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      dbSel.appendChild(o);
    }
    if (!['mysql', 'none'].includes(row.db)) {
      const o = document.createElement('option');
      o.value = row.db;
      o.textContent = row.db;
      dbSel.appendChild(o);
    }
    dbSel.value = row.db;
    tdDb.appendChild(dbSel);
  } else {
    const dash = document.createElement('span');
    dash.className = 'muted';
    dash.textContent = '—';
    tdDb.appendChild(dash);
  }
  tr.appendChild(tdDb);

  const tdDom = document.createElement('td');
  tdDom.className = 'c-domain';
  const domInp = document.createElement('input');
  domInp.dataset.field = 'domain';
  domInp.value = row.domain === '-' ? '' : row.domain;
  domInp.placeholder = '域名或 IP，可留空';
  domInp.spellcheck = false;
  domInp.title = row.domain === '-' ? '' : row.domain;
  tdDom.appendChild(domInp);
  tr.appendChild(tdDom);

  const tdApi = document.createElement('td');
  tdApi.className = 'c-api';
  if (row.type === 'web') {
    const apiSel = document.createElement('select');
    apiSel.dataset.field = 'api';
    const apiOpts = [['-', '不反代'], ...apis.map((n) => [n, `→ ${n}`])];
    // 上游指向已删除的 api 时，显式显示出来，不能静默回显成"不反代"
    if (row.api !== '-' && !apis.includes(row.api)) {
      apiOpts.push([row.api, `${row.api}（上游已删除，请重选）`]);
    }
    for (const [v, label] of apiOpts) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      apiSel.appendChild(o);
    }
    apiSel.value = row.api !== '-' ? row.api : '-';
    tdApi.appendChild(apiSel);
  } else {
    const dash = document.createElement('span');
    dash.className = 'muted';
    dash.textContent = '—';
    tdApi.appendChild(dash);
  }
  tr.appendChild(tdApi);

  const tdAct = document.createElement('td');
  tdAct.className = 'actions';
  const url = projectUrl(row);
  if (url) {
    const copy = document.createElement('button');
    copy.className = 'btn tiny';
    copy.textContent = '复制';
    copy.dataset.copy = url;
    copy.title = `复制站点地址 ${url}（含端口）`;
    tdAct.appendChild(copy);
  }
  const pub = document.createElement('button');
  pub.className = 'btn ghost tiny';
  pub.textContent = '发布';
  pub.dataset.pubOpen = row.name;
  pub.dataset.pubType = row.type === 'api' ? 'api' : 'web';
  pub.title = row.type === 'api'
    ? 'git push 这个项目；弹窗里会列出仓库真实的远端和分支'
    : `上传 dist 到 /var/www/${row.name}，弹窗里确认目录后上传`;
  tdAct.appendChild(pub);
  if (row.type === 'api') {
    const deployed = proj.server.has(row.name);
    for (const [action, label] of [['migrate', '迁移'], ['dump', '备份'], ['import', '导入']]) {
      const b = document.createElement('button');
      b.className = 'btn ghost tiny';
      b.textContent = label;
      b.dataset.action = action;
      b.dataset.app = row.name;
      b.disabled = !deployed;
      if (!deployed) b.title = '先在服务器上初始化并部署这个项目';
      else if (action === 'import') b.title = '把本地 .sql / .sql.gz 导入这个项目的数据库';
      tdAct.appendChild(b);
    }
  }
  const del = document.createElement('button');
  del.className = 'btn ghost tiny row-del';
  del.textContent = '✕';
  del.dataset.rowDel = '1';
  del.title = '从清单移除这一行（服务器上的文件和数据库不会动）';
  tdAct.appendChild(del);
  tr.appendChild(tdAct);
  return tr;
}

function renderProjects() {
  const tbody = $('#projTable tbody');
  tbody.textContent = '';

  if (!proj.rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'proj-empty';
    td.textContent = proj.loaded
      ? '服务器上还没有项目清单，点「+ 新增项目」加一个。'
      : state.activeId
        ? '还没有项目清单，可以从服务器下载，或点「+ 新增项目」手动建。'
        : '还没有选择服务器：先去「配置」页添加连接，或直接点「+ 新增项目」本地建好清单。';

    const actions = document.createElement('div');
    actions.className = 'empty-actions';
    const download = document.createElement('button');
    download.className = 'btn';
    download.textContent = '从服务器下载配置';
    download.dataset.emptyDownload = '1';
    const add = document.createElement('button');
    add.className = 'btn primary';
    add.textContent = '+ 新建项目';
    add.dataset.emptyAdd = '1';
    actions.append(download, add);
    td.appendChild(actions);

    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    proj.rows.forEach((row, idx) => tbody.appendChild(gridRowOf(row, idx)));
  }
  updateDerivedUI();
}

// 不重建表格的联动刷新：单元格编辑后调用，输入不丢焦点
function updateDerivedUI() {
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
  summary.classList.toggle('bad', bad > 0);

  $('#btnApplyConf').disabled = !proj.rows.length;
  syncWebTargets();
  syncPushProjects();
  renderSteps();
}

const STEP_KEYS = ['connect', 'conf', 'apply', 'publish'];

// 第 4 步不只看本次会话点没点过发布：重启面板后也按服务器实际状态打勾
//（有后端在监听，或前端目录里有内容）。
function hasPublishedAnything() {
  if (proj.published) return true;
  if (!proj.loaded) return false;
  return proj.rows.some((r) => {
    if (!proj.server.has(r.name)) return false;
    if (r.type === 'web') return Number(proj.server.get(r.name)?.files ?? 0) > 0;
    return r.port === '-' || proj.ports.has(r.port);
  });
}

function renderSteps() {
  const done = {
    connect: proj.loaded,
    conf: proj.rows.length > 0,
    apply: proj.rows.length > 0 && proj.loaded && proj.rows.every((r) => proj.server.has(r.name)),
    publish: hasPublishedAnything(),
  };
  const current = STEP_KEYS.find((k) => !done[k]) || '';

  for (const li of $$('#projSteps li')) {
    const key = li.dataset.step;
    li.classList.toggle('done', !!done[key]);
    li.classList.toggle('current', key === current);
    li.querySelector('.sn').textContent = done[key] ? '✓' : String(STEP_KEYS.indexOf(key) + 1);
  }
}

async function refreshServerState({ quiet = false } = {}) {
  if (!state.activeId) {
    if (!quiet) appendLog('err', '先在「配置」页选择一个连接\n');
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
  proj.ports = new Set(r.ports || []);
  proj.loaded = true;
  renderProjects();
  renderGitHint();
  return true;
}

async function runDbAction(action, app, btn) {
  if (!state.activeId) {
    appendLog('err', '先选择一个连接\n');
    return;
  }
  const label = { migrate: '迁移', dump: '备份', import: '导入' }[action];
  setBusy(btn, true, '…');
  const r = action === 'import'
    ? await window.api.db.importSql({ id: state.activeId, app })
    : await window.api.db.run({ id: state.activeId, app, action });
  setBusy(btn, false);
  if (r.canceled) return;
  if (!r.ok) {
    appendLog('err', `${app} ${label}失败: ${r.error || `退出码 ${r.code}`}\n`);
    return;
  }
  appendLog('ok', `${app} ${label}完成\n`);
  if (action !== 'dump') await refreshServerState({ quiet: true });
}

// The one and only web upload, invoked from the publish modal.
async function uploadWeb(name, btn) {
  if (!state.activeId) {
    appendLog('err', '先选择一个连接\n');
    return;
  }
  const localDir = $('#distDir').value.trim();
  if (!localDir) {
    appendLog('err', '先选一次前端 dist 目录\n');
    $('#distDir').focus();
    return;
  }
  const remoteDir = name ? webDirOf(name) : webRemoteDir();
  if (!remoteDir) {
    appendLog('err', '目标目录为空\n');
    return;
  }
  const clean = $('#webClean').checked;
  const ok = confirm(
    `${name ? `发布前端 ${name}？` : '上传到自定义目录？'}\n\n${localDir}\n→ ${remoteDir}${clean ? '\n\n上传前会清空目标目录' : ''}`,
  );
  if (!ok) return;

  setBusy(btn, true, '上传中…');
  const confRow = name ? proj.rows.find((r) => r.name === name && r.type === 'web') : null;
  const r = await window.api.web.upload({
    id: state.activeId,
    localDir,
    remoteDir,
    clean,
    port: confRow ? confRow.port : '',
  });
  setBusy(btn, false);
  if (r.ok) {
    proj.published = true;
    renderSteps();
    const failed = r.check && r.check.code !== '200';
    appendLog(
      failed ? 'err' : 'ok',
      `${name ? `${name} 前端已发布` : '已上传'}（${r.files} 个文件）→ ${remoteDir}${failed ? '，但站点自检未通过' : ''}\n`,
    );
    closePub(); // 让出右侧日志区
    await refreshServerState({ quiet: true });
  } else {
    appendLog('err', `${name ? `${name} 发布前端失败` : '上传失败'}: ${r.error}\n`);
  }
}

// ── projects.conf（清单数据源，表格与之双向同步；文本入口已下线）──
async function loadConf(id) {
  const r = await window.api.conf.load(id);
  $('#confText').value = r.text || '';
  proj.baseText = $('#confText').value;
  syncProjects();
}

function confDirty() {
  return $('#confText').value !== proj.baseText;
}

async function syncConfFromServer() {
  if (!state.activeId || confDirty()) return false;
  const r = await window.api.conf.remote(state.activeId);
  if (!r.ok) return false;
  if (r.text === $('#confText').value) return true;
  $('#confText').value = r.text;
  proj.baseText = r.text;
  syncProjects();
  return true;
}

$('#confText').addEventListener('input', syncProjects);

// ── 新增行：表尾插入模板行并聚焦名称，直接在表格里填 ──────────
let lastNewType = 'api'; // 记住上次新建的类型，下次新增沿用

function nextProjectName() {
  const used = new Set(proj.rows.map((r) => r.name));
  if (!used.has('new-api')) return 'new-api';
  for (let i = 2; i < 100; i += 1) {
    if (!used.has(`new-api-${i}`)) return `new-api-${i}`;
  }
  return 'new-api';
}

function addGridRow() {
  const ta = $('#confText');
  const name = nextProjectName();
  const sep = ta.value && !ta.value.endsWith('\n') ? '\n' : '';
  // 模板列与 lastNewType 对应：web 不建库，api 建库
  const tail = lastNewType === 'web' ? 'web   -      -                   -           none' : 'api   -      -                   -           mysql';
  ta.value += `${sep}${name.padEnd(11)} ${tail}\n`;
  syncProjects();
  const trs = document.querySelectorAll('#projTable tbody tr');
  const last = trs[trs.length - 1];
  // 模板默认 api；上次类型是 web 时切过去（change 会触发类型联动重建行）
  const sel = last?.querySelector('select[data-field="type"]');
  if (sel && lastNewType === 'web') {
    sel.value = 'web';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const inp = last?.querySelector('input[data-field="name"]');
  if (inp) {
    inp.focus();
    inp.select();
  }
}

$('#btnAddProject').addEventListener('click', addGridRow);

$('#btnApplyConf').addEventListener('click', async (e) => {
  if (!state.activeId) {
    appendLog('err', '先选择一个连接\n');
    return;
  }
  const text = $('#confText').value;
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
  const remote = await window.api.conf.remote(state.activeId);
  if (!remote.ok) {
    // 第一次在这台服务器上应用：预告将创建什么，新手不至于对着 root 操作发懵
    const apiN = proj.rows.filter((r) => r.type === 'api').length;
    const webN = proj.rows.filter((r) => r.type === 'web').length;
    const dbN = proj.rows.filter((r) => r.type === 'api' && r.db !== 'none').length;
    const go = confirm(
      `第一次在这台服务器上应用清单，将会：\n` +
      `· 初始化 ${apiN} 个后端服务（系统用户 / 裸仓库 / systemd 服务）\n` +
      `· 创建 ${dbN} 个 MySQL 库和账号\n` +
      `· 为 ${webN} 个前端建 nginx 站点\n\n` +
      `前提：服务器已装 Node 20+ / pnpm / Nginx（有数据库时还有 MySQL），不确定先点「采集状态」。\n` +
      `过程幂等，已存在的配置不会被覆盖。继续？`,
    );
    if (!go) {
      setBusy(btn, false);
      return;
    }
  }
  if (remote.ok && remote.text !== proj.baseText) {
    const overwrite = confirm(
      '服务器上的 projects.conf 和你加载时不一致。\n继续会用文本框内容覆盖服务器上的版本，确定吗？',
    );
    if (!overwrite) {
      setBusy(btn, false);
      return;
    }
  }
  await window.api.conf.save({ id: state.activeId, text });
  const r = await window.api.conf.apply({ id: state.activeId, text });
  setBusy(btn, false);
  if (r.ok) {
    proj.baseText = text;
    syncProjects();
    appendLog('ok', '\napply.sh 执行成功\n');
    proj.nginxLoaded = false;
    if (!$('#nginxBox').hidden) loadNginx();
    else {
      $('#nginxState').textContent = '配置已更新，点「查看」';
      $('#nginxState').className = 'hint';
    }
    await refreshServerState({ quiet: true });
  } else {
    appendLog('err', `\n执行失败: ${r.error || `退出码 ${r.code}`}\n`);
  }
});

async function downloadConf(btn) {
  if (!state.activeId) {
    appendLog('err', '先在「配置」页选择一个连接\n');
    return;
  }
  setBusy(btn, true, '下载中…');
  const r = await window.api.conf.download(state.activeId);
  setBusy(btn, false);
  if (r.ok) {
    $('#confText').value = r.text;
    proj.baseText = r.text;
    syncProjects();
    appendLog('ok', '已从服务器下载 projects.conf\n');
  } else appendLog('err', r.error + '\n');
}

// ── server nginx config ─────────────────────────────────────
function resetNginx() {
  proj.nginxLoaded = false;
  $('#nginxState').textContent = '未读取';
  $('#nginxState').className = 'hint';
  $('#nginxState').title = '';
  $('#nginxTest').textContent = '';
  $('#nginxTest').className = 'cfg-status';
  $('#nginxConf').textContent = '';
}

async function loadNginx() {
  if (!state.activeId) {
    appendLog('err', '先选择一个连接\n');
    return;
  }
  const btn = $('#btnLoadNginx');
  setBusy(btn, true, '读取中…');
  const r = await window.api.nginx.show(state.activeId);
  setBusy(btn, false);

  const stateEl = $('#nginxState');
  const testEl = $('#nginxTest');
  const pre = $('#nginxConf');

  if (!r.ok) {
    appendLog('err', `读取 nginx 配置失败: ${r.error}\n`);
    proj.nginxLoaded = false;
    stateEl.textContent = '读取失败';
    stateEl.className = 'hint bad';
    stateEl.title = r.error;
    testEl.className = 'cfg-status bad';
    testEl.textContent = r.error;
    pre.textContent = '';
    return;
  }

  proj.nginxLoaded = true;
  const tone = !r.pass ? 'bad' : r.warn ? 'warn' : 'ok';
  stateEl.textContent = !r.pass ? 'nginx -t 报错' : r.warn ? '通过，有告警' : 'nginx -t 通过';
  stateEl.className = `hint ${tone}`;
  stateEl.title = r.test;
  testEl.className = `cfg-status ${tone}`;
  testEl.textContent = r.test;
  pre.textContent = r.conf || '';
}

function openNginx() {
  const box = $('#nginxBox');
  const opening = box.hidden;
  box.hidden = !opening;
  $('#btnOpenNginx').textContent = opening ? '收起' : '查看';
  if (opening && !proj.nginxLoaded) loadNginx();
}

$('#btnOpenNginx').addEventListener('click', openNginx);
$('#btnLoadNginx').addEventListener('click', () => loadNginx());

// ── settings popover ────────────────────────────────────────
const settingsPop = $('#settingsPop');
const btnSettings = $('#btnSettings');

function openSettings() {
  const r = btnSettings.getBoundingClientRect();
  settingsPop.hidden = false;
  const pw = settingsPop.offsetWidth;
  const left = Math.min(r.right + 10, innerWidth - pw - 12);
  settingsPop.style.left = `${Math.max(12, left)}px`;
  settingsPop.style.bottom = `${Math.max(12, innerHeight - r.bottom)}px`;
  btnSettings.classList.add('active');
  btnSettings.setAttribute('aria-expanded', 'true');
  settingsPop.focus();
}

function closeSettings() {
  if (settingsPop.hidden) return;
  settingsPop.hidden = true;
  btnSettings.classList.remove('active');
  btnSettings.setAttribute('aria-expanded', 'false');
}

btnSettings.addEventListener('click', (e) => {
  e.stopPropagation();
  if (settingsPop.hidden) openSettings();
  else closeSettings();
});
$('#btnCloseSettings').addEventListener('click', closeSettings);

$('#btnGuide').addEventListener('click', async () => {
  closeSettings();
  const r = await window.api.guide.open();
  if (!r.ok) appendLog('err', `打开使用说明失败: ${r.error}\n`);
});
document.addEventListener('click', (e) => {
  if (settingsPop.hidden) return;
  if (!settingsPop.contains(e.target) && !btnSettings.contains(e.target)) closeSettings();
});
window.addEventListener('resize', closeSettings);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#pubModal').hidden) closePub();
  else closeSettings();
});

$('#btnProjRefresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  setBusy(btn, true, '刷新中…');
  const ok = await refreshServerState();
  setBusy(btn, false);
  if (ok) appendLog('ok', '服务器项目状态已刷新\n');
});

$('#projTable').addEventListener('click', async (e) => {
  const dl = e.target.closest('button[data-empty-download]');
  if (dl) {
    await downloadConf(dl);
    return;
  }
  if (e.target.closest('button[data-empty-add]')) {
    addGridRow();
    return;
  }
  const delBtn = e.target.closest('button[data-row-del]');
  if (delBtn) {
    const tr = delBtn.closest('tr');
    const idx = Number(tr?.dataset.idx);
    const row = proj.rows[idx];
    if (!row) return;
    if (!confirm(`把 ${row.name} 从清单移除？\n\n之后点「应用更改」，它的 nginx 站点会自动下线。`)) return;
    const onServer = proj.loaded && proj.server.has(row.name);
    const i = lineIndexAt(idx);
    if (i >= 0) {
      const lines = $('#confText').value.split('\n');
      lines.splice(i, 1);
      $('#confText').value = lines.join('\n');
    }
    syncProjects();
    appendLog('info', `已从清单移除 ${row.name}\n`);
    if (onServer && state.activeId) {
      const go = confirm(
        `服务器上有「${row.name}」。\n现在连服务器上的一起删除吗？\n\n` +
        `将删除：systemd 服务、/opt/apps 目录、裸仓库 /opt/git/...、网站目录 /var/www/...\n` +
        `（取消 = 只删清单行，服务器保持原样）`,
      );
      if (go) {
        const s = proj.server.get(row.name);
        let withDb = false;
        if (row.type === 'api' && s?.db && s.db !== '-' && s.exists) {
          withDb = confirm(
            `连数据库 ${s.db}（${s.tables} 表）一起删除？\n此操作不可恢复！建议先点行内「备份」。\n（取消 = 保留数据库，只删其他）`,
          );
        }
        const r = await window.api.project.remove({ id: state.activeId, name: row.name, withDb });
        if (r.ok) {
          appendLog('ok', `服务器上的 ${row.name} 已删除${withDb && s ? `（含数据库 ${s.db}）` : ''}\n`);
          await refreshServerState({ quiet: true });
        } else {
          appendLog('err', `服务器删除失败: ${r.error || `退出码 ${r.code}`}\n${r.out || ''}\n`);
        }
      }
    }
    return;
  }
  const copyBtn = e.target.closest('button[data-copy]');
  if (copyBtn) {
    const r = await window.api.clip.write(copyBtn.dataset.copy);
    if (r.ok) appendLog('info', `已复制 ${copyBtn.dataset.copy}\n`);
    else appendLog('err', `复制失败: ${r.error || ''}\n`);
    return;
  }
  const webBtn = e.target.closest('button[data-pub-open]');
  if (webBtn && !webBtn.disabled) {
    await openPub(webBtn.dataset.pubType, webBtn.dataset.pubOpen);
    return;
  }
  const btn = e.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;
  await runDbAction(btn.dataset.action, btn.dataset.app, btn);
});

// 单元格直接编辑：input 轻量联动（不打断输入）；已部署行的名称/数据库
// 属危险变更，等 change（失焦/选完）再弹确认；类型切换后重建行
$('#projTable').addEventListener('input', (e) => {
  const el = e.target.closest('[data-field]');
  if (!el) return;
  const tr = el.closest('tr');
  const idx = Number(tr?.dataset.idx);
  const field = el.dataset.field;
  const r = proj.rows[idx];
  if (!r) return;
  if (dangerousChange(r, field)) return; // 危险字段不逐键落盘，等 change 确认
  gridEdit(idx, field, el.value);
});
$('#projTable').addEventListener('change', (e) => {
  const el = e.target.closest('[data-field]');
  if (!el) return;
  const tr = el.closest('tr');
  const idx = Number(tr?.dataset.idx);
  const field = el.dataset.field;
  const r = proj.rows[idx];
  if (!r) return;
  const v = String(el.value).trim();
  if (dangerousChange(r, field)) {
    if (!v || v === r[field]) {
      renderProjects(); // 无实际变化，恢复单元格显示
      return;
    }
    const what = field === 'name' ? `改名为 ${v}` : `数据库改为 ${v}`;
    const go = confirm(
      `${r.name} 已在服务器部署。\n${what}后，点「应用更改」会在服务器**新建**对应的项目和库；\n服务器上已有的「${r.name}」目录、数据库不会被移动或删除（需手动清理）。\n\n确定要这样改吗？`,
    );
    if (!go) {
      renderProjects(); // 取消：从模型恢复单元格显示
      return;
    }
  }
  gridEdit(idx, field, el.value);
  if (field === 'type') renderProjects(); // 互换上游/数据库单元格
});
// Enter：跳到下一行同列，最后一行则失焦（触发确认/落定）
$('#projTable').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.matches('input[data-field]')) return;
  const el = e.target;
  const next = el.closest('tr').nextElementSibling;
  const target = next?.querySelector(`input[data-field="${el.dataset.field}"]`);
  if (target) {
    target.focus();
    target.select();
  } else {
    el.blur();
  }
});

// ── publish ─────────────────────────────────────────────────
let repoInfo = null;
let inspectSeq = 0;

// 发布弹窗：项目表每行的「发布」打开这里，内容**严格跟随行类型**——
// 点后端行只出现 git push，点前端行只出现 dist 上传；四步条第 4 步也落到
// 这里（没带类型时：有后端先看后端）。字段 ID 与旧发布页一致。
function showPubPane(type) {
  $('#pubBackend').hidden = type !== 'api';
  $('#pubFrontend').hidden = type !== 'web';
}

function closePub() {
  $('#pubModal').hidden = true;
}

async function openPub(type, projectName) {
  $('#pubModal').hidden = false;
  if (type !== 'api' && type !== 'web') {
    // 从步骤条等入口进来没带类型：有后端项目先看后端，否则看前端
    type = proj.rows.some((r) => r.type === 'api') ? 'api' : 'web';
  }
  showPubPane(type);

  if (type === 'api') {
    if (projectName && projectName !== pushProjectName) {
      rememberRepoDir(); // 记的是切换前那个项目的目录
      pushProjectName = projectName;
      const known = repoDirs.get(pushProjectName);
      if (known !== undefined) $('#repoDir').value = known;
      persistSettings({ pushProject: pushProjectName });
    }
    syncPushProjects();
    if (!repoInfo) await inspectRepo();
    else renderGitHint();
  } else if (projectName) {
    syncWebTargets();
    $('#webTargetProject').value = projectName;
    $('#webTargetRow').hidden = true;
  }
}

$('#btnClosePub').addEventListener('click', closePub);
$('#pubModal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closePub();
});

function fillSelect(sel, items, chosen) {
  sel.textContent = '';
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = it.value;
    opt.textContent = it.label;
    sel.appendChild(opt);
  }
  if (chosen && items.some((i) => i.value === chosen)) sel.value = chosen;
}

// 服务器上这个项目的裸仓库地址，和 add-project.sh 提示用户添加的 remote 一致。
function bareUrlOf(name) {
  const p = state.profiles.find((x) => x.id === state.activeId);
  if (!p || !name) return '';
  return `ssh://${p.username}@${p.host}:${p.port}/opt/git/${name}.git`;
}

function syncPushProjects() {
  const rows = proj.rows.filter((r) => r.type === 'api');
  if (!rows.some((r) => r.name === pushProjectName)) pushProjectName = rows[0]?.name || '';
  fillSelect(
    $('#pushProject'),
    rows.length
      ? rows.map((r) => ({ value: r.name, label: r.port === '-' ? r.name : `${r.name}  →  :${r.port}` }))
      : [{ value: '', label: '项目清单里还没有后端项目（先在配置里加一行）' }],
    pushProjectName,
  );
  renderGitHint();
}

function renderGitHint() {
  const hint = $('#gitHint');
  if (!repoInfo) {
    hint.textContent = '选好仓库目录后，这里自动列出该仓库真实的远端和分支。';
    return;
  }
  if (repoInfo.error) {
    hint.textContent = repoInfo.error;
    return;
  }
  const remote = $('#gitRemote').value;
  const branch = $('#gitBranch').value;
  if (!remote) {
    hint.textContent = pushProjectName
      ? `这个仓库还没有远端。在仓库目录里执行：git remote add deploy ${bareUrlOf(pushProjectName)}`
      : '这个仓库还没有远端，先在上面选好项目，再执行 git remote add。';
    return;
  }
  const url = (repoInfo.remotes.find((r) => r.name === remote) || {}).url || '';
  const parts = [`推送 = git push ${remote} ${branch || '?'}`];
  const bare = pushProjectName ? `/opt/git/${pushProjectName}.git` : '';
  if (bare && !url.endsWith(bare)) parts.push(`该远端指向 ${url}，不是 ${pushProjectName} 的裸仓库 ${bare}，推上去不会部署`);
  const serverBranch = proj.server.get(pushProjectName)?.branch;
  if (serverBranch && branch && branch !== serverBranch) {
    parts.push(`服务器只部署 ${serverBranch}，你推的是 ${branch}`);
  }
  hint.textContent = parts.join(' · ');
}

async function inspectRepo() {
  const seq = ++inspectSeq;
  const dir = $('#repoDir').value.trim();
  const remoteSel = $('#gitRemote');
  const branchSel = $('#gitBranch');
  repoInfo = null;
  if (!dir) {
    fillSelect(remoteSel, [{ value: '', label: '（未选仓库目录）' }]);
    fillSelect(branchSel, [{ value: '', label: '（未选仓库目录）' }]);
    renderGitHint();
    return;
  }
  const r = await window.api.deploy.inspect(dir);
  if (seq !== inspectSeq) return;
  if (!r.ok) {
    repoInfo = { error: r.error };
    fillSelect(remoteSel, [{ value: '', label: '—' }]);
    fillSelect(branchSel, [{ value: '', label: '—' }]);
    renderGitHint();
    return;
  }
  repoInfo = r;

  const names = r.remotes.map((x) => x.name);
  const bare = pushProjectName ? `/opt/git/${pushProjectName}.git` : '';
  const byBare = bare ? r.remotes.find((x) => x.url.endsWith(bare)) : null;
  const remote =
    (byBare && byBare.name) ||
    (names.includes(remoteSel.value) ? remoteSel.value : '') ||
    (names.includes(preferredRemote) ? preferredRemote : '') ||
    (r.remotes.find((x) => x.url.includes('/opt/git/')) || {}).name ||
    names[0] ||
    '';
  fillSelect(
    remoteSel,
    r.remotes.length ? r.remotes.map((x) => ({ value: x.name, label: x.name })) : [{ value: '', label: '（还没有远端）' }],
    remote,
  );

  // 默认选服务器钩子真正会部署的那个分支，其次上次用的、再退到当前分支。
  const serverBranch = proj.server.get(pushProjectName)?.branch;
  const branch =
    (serverBranch && r.branches.includes(serverBranch) ? serverBranch : '') ||
    (r.branches.includes(branchSel.value) ? branchSel.value : '') ||
    (r.branches.includes(preferredBranch) ? preferredBranch : '') ||
    (r.branches.includes(r.head) ? r.head : '') ||
    r.branches[0] ||
    '';
  fillSelect(
    branchSel,
    r.branches.length
      ? r.branches.map((b) => ({ value: b, label: b === r.head ? `${b}（当前）` : b === serverBranch ? `${b}（服务器部署）` : b }))
      : [{ value: '', label: '（还没有本地分支）' }],
    branch,
  );
  preferredRemote = remoteSel.value;
  preferredBranch = branchSel.value;
  persistSettings({ gitRemote: preferredRemote, gitBranch: preferredBranch });
  renderGitHint();
}

function rememberRepoDir() {
  const dir = $('#repoDir').value.trim();
  if (pushProjectName && dir) {
    repoDirs.set(pushProjectName, dir);
    persistSettings({ repoDirs: Object.fromEntries(repoDirs) });
  }
}

$('#btnPickRepo').addEventListener('click', async () => {
  const dir = await window.api.pickDir();
  if (!dir) return;
  $('#repoDir').value = dir;
  persistSettings({ repoDir: dir });
  rememberRepoDir();
  await inspectRepo();
});

$('#repoDir').addEventListener('change', () => {
  rememberRepoDir();
  inspectRepo();
});

$('#pushProject').addEventListener('change', async (e) => {
  rememberRepoDir(); // 记的是切换前那个项目的目录
  pushProjectName = e.target.value;
  const known = repoDirs.get(pushProjectName);
  if (known !== undefined) $('#repoDir').value = known;
  persistSettings({ pushProject: pushProjectName });
  await inspectRepo();
});

$('#gitRemote').addEventListener('change', (e) => {
  preferredRemote = e.target.value;
  persistSettings({ gitRemote: preferredRemote });
  renderGitHint();
});

$('#gitBranch').addEventListener('change', (e) => {
  preferredBranch = e.target.value;
  persistSettings({ gitBranch: preferredBranch });
  renderGitHint();
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
  const remote = $('#gitRemote').value.trim();
  const branch = $('#gitBranch').value.trim();
  if (!remote || !branch) {
    appendLog('err', '这个仓库没有可用的远端或本地分支，先看下方提示\n');
    return;
  }
  const btn = e.currentTarget;
  setBusy(btn, true, '推送中…');
  const r = await window.api.deploy.push({ repoDir, remote, branch });
  setBusy(btn, false);
  if (r.ok) {
    proj.published = true;
    renderSteps();
    closePub(); // 让出右侧日志区：构建结果全在 remote: 输出里
    appendLog('ok', '推送完成（git 退出码 0）。钩子构建失败不会让 push 失败，请核对上方 remote: 输出。\n');
  } else appendLog('err', `推送失败${r.code ? `（退出码 ${r.code}）` : ''}\n`);
});

$('#btnUpload').addEventListener('click', async (e) => {
  const sel = $('#webTargetProject');
  const name = sel.value === CUSTOM_TARGET || sel.value === '' ? null : sel.value;
  await uploadWeb(name, e.currentTarget);
});

$('#btnClear').addEventListener('click', () => {
  for (const t of logTimers.values()) clearTimeout(t);
  logTimers.clear();
  logTail.clear();
  consoleEl.textContent = '';
});

// ── app info & updates ──────────────────────────────────────
const upd = { check: $('#btnCheckUpdate'), download: $('#btnDownloadUpdate'), install: $('#btnInstallUpdate') };

function setUpdateStatus(text, tone) {
  const el = $('#updateStatus');
  el.textContent = text;
  el.className = tone ? `hint ${tone}` : 'hint';
}

function updateButtons({ download = false, install = false, checkDisabled = false } = {}) {
  upd.download.hidden = !download;
  upd.download.disabled = false;
  upd.download.textContent = '下载更新';
  upd.install.hidden = !install;
  upd.check.disabled = checkDisabled;
}

function mb(n) {
  return (Number(n || 0) / 1048576).toFixed(1);
}

async function loadAppInfo() {
  const info = await window.api.app.info();
  $('#appVersion').textContent = info.packaged
    ? `v${info.version} · ${info.platform}`
    : `v${info.version} · 开发模式（不检查更新）`;
  if (!info.packaged) setUpdateStatus('开发模式不检查更新；打包安装版后启动时自动检查');
}

window.api.onUpdate((msg) => {
  if (msg.status === 'checking') {
    updateButtons({ checkDisabled: true });
    setUpdateStatus('正在检查更新…');
  } else if (msg.status === 'available') {
    updateButtons({ download: true });
    setUpdateStatus(`发现新版本 v${msg.version}`, 'ok');
  } else if (msg.status === 'none') {
    updateButtons();
    setUpdateStatus(`已是最新版本（v${msg.version}）`, 'ok');
  } else if (msg.status === 'downloading') {
    upd.download.hidden = false;
    upd.download.disabled = true;
    upd.download.textContent = `下载中 ${msg.percent}%`;
    setUpdateStatus(`下载中 ${msg.percent}%（${mb(msg.transferred)} / ${mb(msg.total)} MB）`);
  } else if (msg.status === 'downloaded') {
    updateButtons({ install: true });
    setUpdateStatus(`v${msg.version} 已下载，点「重启安装」完成更新`, 'ok');
  } else if (msg.status === 'error') {
    updateButtons();
    setUpdateStatus(`更新失败：${msg.message}`, 'bad');
  }
});

upd.check.addEventListener('click', async () => {
  setBusy(upd.check, true, '检查中…');
  const r = await window.api.update.check();
  setBusy(upd.check, false);
  if (!r.ok) {
    updateButtons();
    setUpdateStatus(r.error || '检查更新失败', 'bad');
  } else if (r.version) {
    setUpdateStatus(`发现新版本 v${r.version}`, 'ok');
  } else {
    setUpdateStatus('已发出检查，稍等结果…');
  }
});

upd.download.addEventListener('click', async () => {
  updateButtons({ download: true });
  upd.download.disabled = true;
  upd.download.textContent = '下载中…';
  setUpdateStatus('开始下载…');
  const r = await window.api.update.download();
  if (!r.ok) {
    updateButtons();
    setUpdateStatus(r.error || '下载失败', 'bad');
  }
});

upd.install.addEventListener('click', async () => {
  upd.install.disabled = true;
  setUpdateStatus('正在退出并安装，请稍等…');
  await window.api.update.install();
});

// ── boot ────────────────────────────────────────────────────
(async () => {
  await refreshProfiles();
  if (!state.profiles.length) {
    appendLog('info', '第一次使用：先在「配置」页填服务器地址并保存；图文教程点左下角 ？\n');
  }
  await loadConf(state.activeId);
  loadAppInfo();
  syncAuthFields();
  showTab(state.activeId ? 'project' : 'config');
})();
