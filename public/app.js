'use strict';

/* ===== Helpers ===== */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
const esc = escapeHtml;

function safeUrl(u) {
  return (typeof u === 'string' && /^https?:\/\//i.test(u)) ? u : null;
}

function kebab(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toLocaleString('en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function isTouchLike() {
  return window.matchMedia('(hover: none)').matches || window.innerWidth <= 768;
}

/* ===== Constants ===== */
const TYPE_ORDER = ['skill', 'plugin', 'mcp', 'agent', 'md', 'tool', 'cli'];
const TYPE_LABELS = { skill: 'Skill', plugin: 'Plugin', mcp: 'MCP', agent: 'Agent', md: 'CLAUDE.md', tool: 'Tool', cli: 'CLI' };
const TYPE_FULL = { skill: 'Skill', plugin: 'Plugin', mcp: 'MCP Server', agent: 'Agent Repo', md: 'CLAUDE.md Template', tool: 'Tool', cli: 'CLI' };
const MODES = [
  { id: 'session', icon: '🎯', name: 'Session', desc: 'This session only. Nothing is permanently changed' },
  { id: 'project', icon: '📁', name: 'Project', desc: 'Create/merge config files in the project folder (after backup)' },
  { id: 'global', icon: '🌍', name: 'Global', desc: 'Switch ~/.claude global plugin state (caution)' },
];
const FORMATS = [
  { id: 'install.sh', label: 'install.sh', file: () => 'install.sh', mime: 'text/x-shellscript' },
  { id: 'settings.json', label: 'settings.json', file: () => 'settings.json', mime: 'application/json' },
  { id: 'mcp.json', label: 'mcp.json', file: () => 'mcp.json', mime: 'application/json' },
  { id: 'claude.md', label: 'CLAUDE.md', file: () => 'CLAUDE.md', mime: 'text/markdown' },
  { id: 'preset.json', label: 'preset.json', file: () => `${S.ui.apply.presetId || 'preset'}.preset.json`, mime: 'application/json' },
];

function badge(t) {
  const known = TYPE_LABELS[t] ? t : 'tool';
  return `<span class="badge type-${known}">${esc(TYPE_LABELS[t] || t || '?')}</span>`;
}

/* ===== State ===== */
const S = {
  catalog: [],
  itemMap: new Map(),
  presets: [],
  status: null,
  state: null,
  config: null,
  ui: {
    view: 'dashboard',
    pantry: { q: '', type: 'all', collapsed: new Set() },
    builder: { q: '', collapsed: new Set() },
    discover: {
      src: 'github',
      gh: null, ghLoading: false, sort: 'stars', range: 'all', ghLoaded: false,
      smp: null, smpLoading: false,
      ai: null, aiLoading: false, provider: '', clis: null,
    },
    apply: {
      presetId: '', mode: 'session',
      session: null,
      projectPath: '', projectPlan: null, projectResult: null,
      globalPlan: null, globalResult: null,
      fmt: 'install.sh', exportText: '',
    },
  },
};

/* ===== API ===== */
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let json;
  try {
    const res = await fetch(path, init);
    json = await res.json();
  } catch (e) {
    if (!opts.silent) toast('Cannot connect to the server. Make sure the server is running.', 'error');
    throw e;
  }
  if (!json || json.ok !== true) {
    const msg = (json && json.error) || 'The request failed';
    if (!opts.silent) toast(msg, 'error');
    const err = new Error(msg);
    err.handled = true;
    throw err;
  }
  return json.data;
}

async function reloadCatalog() {
  const d = await api('/api/catalog', { silent: true });
  S.catalog = d.items || [];
  S.itemMap = new Map(S.catalog.map(i => [i.id, i]));
}
async function reloadPresets() {
  const d = await api('/api/presets', { silent: true });
  S.presets = d.presets || [];
}
async function reloadStatus(silent = true) {
  try { S.status = await api('/api/status', { silent }); }
  catch { S.status = null; }
}
async function reloadState() {
  try { S.state = await api('/api/state', { silent: true }); }
  catch { S.state = null; }
}
async function reloadConfig() {
  try { S.config = await api('/api/config', { silent: true }); }
  catch { S.config = null; }
}

/* ===== Toast ===== */
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  $('#toastWrap').appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, type === 'error' ? 5000 : 2600);
}

/* ===== Modal / Confirm ===== */
function showModal(id) { $('#' + id).classList.add('show'); }
function hideModal(id) { $('#' + id).classList.remove('show'); }

let confirmResolve = null;
function openConfirm({ title, bodyHtml = '', okText = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    confirmResolve = resolve;
    $('#confirmTitle').textContent = title;
    $('#confirmBody').innerHTML = bodyHtml;
    const ok = $('#confirmOk');
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'btn-red' : 'btn-primary');
    showModal('confirmModal');
  });
}
function settleConfirm(v) {
  hideModal('confirmModal');
  const r = confirmResolve;
  confirmResolve = null;
  if (r) r(v);
}

/* ===== Picker (popover / bottom sheet) ===== */
let activePopover = null;
let pickerResolve = null;

function openPicker({ title, options, anchor, emptyHtml = 'No items' }) {
  return new Promise(resolve => {
    settlePicker(null);
    pickerResolve = resolve;
    const btnsHtml = options.length
      ? options.map(o => `<button class="picker-btn" data-picker-value="${esc(o.value)}">${esc(o.label)}</button>`).join('')
      : `<div class="popover-empty">${emptyHtml}</div>`;
    if (isTouchLike() || !anchor || !anchor.isConnected) {
      $('#sheetTitle').textContent = title;
      $('#sheetGrid').innerHTML = btnsHtml;
      $('#bottomSheet').classList.add('show');
      $('#sheetOverlay').classList.add('show');
    } else {
      const pop = document.createElement('div');
      pop.className = 'popover';
      pop.innerHTML = `<div class="popover-title">${esc(title)}</div>${btnsHtml}`;
      document.body.appendChild(pop);
      positionPopover(pop, anchor);
      activePopover = pop;
    }
  });
}

function positionPopover(pop, anchor) {
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
  let y = r.bottom + 6;
  if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 6);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
}

function settlePicker(v) {
  if (activePopover) { activePopover.remove(); activePopover = null; }
  $('#bottomSheet').classList.remove('show');
  $('#sheetOverlay').classList.remove('show');
  const r = pickerResolve;
  pickerResolve = null;
  if (r) r(v);
}

function pickPreset(anchor, itemId) {
  return openPicker({
    title: 'Where to add it?',
    anchor,
    options: S.presets.map(p => ({
      label: `${p.emoji || '📦'} ${p.name || p.id}${itemId && (p.items || []).includes(itemId) ? ' ✓' : ''}`,
      value: p.id,
    })),
    emptyHtml: 'No presets yet — <a href="#builder">create one in the builder</a>',
  });
}

function pickType(anchor, def) {
  return openPicker({
    title: 'Select type',
    anchor,
    options: TYPE_ORDER.map(t => ({ label: `${TYPE_FULL[t]}${t === def ? ' ✓' : ''}`, value: t })),
  });
}

/* ===== Copy / Download / Button busy ===== */
async function copyText(text, msg = 'Copied 📋') {
  try {
    await navigator.clipboard.writeText(text);
    toast(msg);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast(msg); }
    catch { toast('Copy failed — please select and copy manually', 'error'); }
    ta.remove();
  }
}

function download(name, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function setBusy(btn, on, label) {
  if (!btn || !btn.isConnected) return;
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner sp-sm"></span> ${esc(label || 'Processing…')}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

/* ===== Routing ===== */
const VIEWS = ['dashboard', 'pantry', 'builder', 'discover', 'apply', 'settings'];

function route() {
  settlePicker(null);
  let h = (location.hash || '#dashboard').replace(/^#/, '');
  if (!VIEWS.includes(h)) h = 'dashboard';
  S.ui.view = h;
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + h));
  $$('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.view === h));
  renderView(h);
}

function renderView(v) {
  const fn = {
    dashboard: renderDashboard,
    pantry: renderPantry,
    builder: renderBuilder,
    discover: renderDiscover,
    apply: renderApply,
    settings: renderSettings,
  }[v];
  if (fn) fn();
}

/* ===== Dashboard ===== */
function renderDashboard() {
  const plugins = (S.status && S.status.plugins) || [];
  const enabled = plugins.filter(p => p.enabled).length;
  const stats = [
    { icon: '🧊', n: S.catalog.length, l: 'Refrigerator Ingredients' },
    { icon: '🍳', n: S.presets.length, l: 'Presets' },
    { icon: '🔌', n: S.status ? `${enabled}/${plugins.length}` : '—', l: 'Plugins (active/total)' },
    { icon: '📂', n: S.status ? ((S.status.skillsDirs || []).length) : '—', l: 'Skills Directories' },
  ];
  $('#dashStats').innerHTML = stats.map(s => `
    <div class="stat-card"><div class="stat-icon">${s.icon}</div>
      <div><div class="stat-num">${esc(s.n)}</div><div class="stat-label">${esc(s.l)}</div></div>
    </div>`).join('');

  const activeId = S.state && S.state.lastApplied && S.state.lastApplied.presetId;
  const qs = $('#quickSwitch');
  if (!S.presets.length) {
    qs.innerHTML = `<div class="empty-state" style="flex:1">No presets yet — create your first recipe in the <a href="#builder">Preset Builder</a> 🍳</div>`;
  } else {
    qs.innerHTML = S.presets.map(p => {
      const missing = (p.items || []).filter(id => !S.itemMap.has(id)).length;
      return `<div class="quick-card ${p.id === activeId ? 'active' : ''}">
        <div class="quick-top">
          <span class="quick-emoji">${esc(p.emoji || '📦')}</span>
          <div class="quick-names">
            <strong title="${esc(p.name || p.id)}">${esc(p.name || p.id)}</strong>
            <span class="muted">${(p.items || []).length} ingredients${missing ? ` · <span class="warn">${missing} missing</span>` : ''}</span>
          </div>
          ${p.id === activeId ? '<span class="active-badge">● Active</span>' : ''}
        </div>
        <div class="quick-actions">
          <button class="btn btn-sm" data-action="quick-session" data-preset="${esc(p.id)}">Copy session command</button>
          <button class="btn btn-sm btn-red" data-action="quick-global" data-preset="${esc(p.id)}">Apply globally</button>
        </div>
      </div>`;
    }).join('');
  }

  $('#pluginCount').textContent = S.status ? `(${enabled}/${plugins.length})` : '';
  $('#claudeVersion').textContent = S.status && S.status.claude && S.status.claude.version
    ? S.status.claude.version : '';
  const pl = $('#pluginList');
  if (!S.status) {
    pl.innerHTML = '<div class="empty-state">Failed to load status info. Try clicking refresh.</div>';
  } else {
    let html = '';
    if (S.status.claude && S.status.claude.available === false) {
      html += '<div class="warn-box">⚠️ claude CLI not found. Install it and refresh.</div>';
    }
    if (!plugins.length) {
      html += '<div class="empty-state">No plugins installed.</div>';
    } else {
      html += plugins.map(p => `<div class="row-item">
        <span class="plug-name"><strong>${esc(p.name || '')}</strong><span class="muted">${p.marketplace ? '@' + esc(p.marketplace) : ''}</span></span>
        <span class="muted">v${esc(p.version || '?')}</span>
        <span class="muted">${esc(p.scope || '')}</span>
        <span class="pill ${p.enabled ? 'pill-on' : 'pill-off'}">${p.enabled ? '● Active' : '○ Inactive'}</span>
      </div>`).join('');
    }
    pl.innerHTML = html;
  }

  const hist = ((S.state && S.state.history) || []).slice(0, 5);
  $('#historyList').innerHTML = hist.length ? hist.map(h => {
    const p = S.presets.find(x => x.id === h.presetId);
    const modeL = { session: '🎯 Session', project: '📁 Project', global: '🌍 Global' }[h.mode] || esc(h.mode || '');
    return `<div class="row-item">
      <span class="plug-name">${esc(p ? p.emoji : '🍳')} <strong>${esc(p ? p.name : (h.presetId || '?'))}</strong></span>
      <span class="muted">${modeL}${h.target ? ' · ' + esc(h.target) : ''}</span>
      <span class="muted">${esc(fmtTime(h.at))}</span>
    </div>`;
  }).join('') : '<div class="empty-state">No apply history yet.</div>';

  renderSessions();
}

async function renderSessions() {
  const el = $('#sessionsList');
  if (!el) return;
  el.innerHTML = loadingBox('Loading sessions…');
  let d;
  try {
    d = await api('/api/sessions', { silent: true });
  } catch {
    el.innerHTML = '<div class="empty-state">Failed to load sessions.</div>';
    return;
  }
  const running = d.running || [];
  const configs = d.configs || [];
  const cnt = $('#sessionCount');
  if (cnt) cnt.textContent = `(${running.length} running)`;
  const chip = (label, arr, cls) => (arr && arr.length) ? `<span class="sum-chip"><span class="badge ${cls}">${label}</span> ${arr.length}</span>` : '';
  const line = (k, arr) => (arr && arr.length) ? `<div class="kv"><span class="k">${k}</span><span class="muted small">${arr.map(esc).join(', ')}</span></div>` : '';
  const chips = (b) => `<div class="sum-chips">${chip('Plugin', b.plugin, 'type-plugin')}${chip('MCP', b.mcp, 'type-mcp')}${chip('Skill', b.skill, 'type-skill')}${chip('Agent', b.agent, 'type-agent')}${chip('CLAUDE.md', b.md, 'type-md')}${chip('Tool', b.tool, 'type-tool')}${chip('CLI', b.cli, 'type-cli')}</div>`;
  const modeBadge = { preset: '🎯 Preset', resume: '↩ Resumed', continue: '▸ Continued', fresh: '✦ New' };

  let html = '';
  html += running.length ? running.map(s => {
    const b = s.breakdown || {};
    const isPreset = s.mode === 'preset';
    return `<div class="item-card" style="margin-bottom:8px">
      <div class="item-top">
        <span class="item-name">🖥️ ${esc(s.presetName || s.label)} <span class="muted small">· pid ${esc(String(s.pid))}</span></span>
        <span class="pill pill-on">● Running</span>
      </div>
      <div class="kv"><span class="k">Folder</span><span class="muted small">${esc(s.cwd || 'unknown')}</span></div>
      <div class="kv"><span class="k">Type</span><span>${esc(modeBadge[s.mode] || 'Session')}${s.resume ? ' <span class="muted small">' + esc(s.resume.slice(0, 12)) + '</span>' : ''}</span></div>
      ${isPreset ? `${chips(b)}
        <div class="kv"><span class="k">Applied</span><span>${s.plugins.length} plugin(s) · ${s.mcpServers.length} MCP server(s)</span></div>
        ${line('Plugins', b.plugin)}${line('MCP', b.mcp)}${line('Skills', b.skill)}${line('Agents', b.agent)}${line('CLAUDE.md', b.md)}`
      : `<div class="muted small">Not launched from a refrigerator preset — its plugins/skills aren't tracked here.</div>`}
    </div>`;
  }).join('') : '<div class="empty-state">No running <code>claude</code> CLI sessions detected right now.</div>';

  const idle = configs.filter(c => !c.running);
  if (idle.length) {
    html += `<div class="muted small" style="margin:12px 0 6px">🎯 Generated session presets (not running)</div>`;
    html += idle.map(c => {
      const b = c.breakdown || {};
      return `<div class="item-card" style="margin-bottom:8px">
        <div class="item-top">
          <span class="item-name">🎯 ${esc(c.presetName)}${c.presetExists ? '' : ' <span class="muted small">(preset deleted)</span>'}</span>
          <span class="pill pill-off">○ Not running</span>
        </div>
        ${chips(b)}
        <div class="kv"><span class="k">Enables</span><span>${c.plugins.length} plugin(s) · ${c.mcpServers.length} MCP server(s)</span></div>
        <div class="code-row"><code>${esc(c.command)}</code><button class="btn btn-sm" data-action="copy-text" data-copy="${esc(c.command)}">Copy</button></div>
      </div>`;
    }).join('');
  }
  el.innerHTML = html;
}

async function quickSession(presetId, btn) {
  try {
    setBusy(btn, true, 'Generating…');
    const d = await api('/api/apply', { method: 'POST', body: { presetId, mode: 'session' } });
    if (d && d.command) {
      await copyText(d.command, `Session command copied (${d.pluginCount ?? 0} plugins) 🎯`);
    } else {
      toast('Session settings generated');
    }
    await reloadState();
    if (S.ui.view === 'dashboard') renderDashboard();
  } catch { /* api() handles the toast */ }
  finally { setBusy(btn, false); }
}

function confirmGlobalPlan(preset, plan) {
  const en = plan.enable || [], dis = plan.disable || [], mk = plan.marketplaceAdd || [];
  const li = arr => arr.length
    ? `<ul class="plan-list">${arr.map(x => `<li><code>${esc(x)}</code></li>`).join('')}</ul>`
    : '<p class="muted">None</p>';
  const body = `
    <p>Apply the <strong>${esc(preset ? preset.emoji + ' ' + preset.name : '')}</strong> preset globally (user settings).<br>
    <span class="warn">Active plugins not in the preset will be disabled.</span></p>
    ${mk.length ? `<h4>🛒 Marketplace additions (${mk.length})</h4>${li(mk)}` : ''}
    <h4 class="plan-en">✅ Enable (${en.length})</h4>${li(en)}
    <h4 class="plan-dis">⛔ Disable (${dis.length})</h4>${li(dis)}
    ${!en.length && !dis.length && !mk.length ? '<p class="muted">No changes — already in this preset\'s state.</p>' : ''}`;
  return openConfirm({ title: '🌍 Confirm Global Apply', bodyHtml: body, okText: 'Run global apply', danger: true });
}

async function globalApplyFlow(presetId, btn) {
  const preset = S.presets.find(x => x.id === presetId);
  try {
    setBusy(btn, true, 'Previewing…');
    const d = await api('/api/apply', { method: 'POST', body: { presetId, mode: 'global', dryRun: true } });
    setBusy(btn, false);
    const plan = (d && d.plan) || d || {};
    const ok = await confirmGlobalPlan(preset, plan);
    if (!ok) return;
    setBusy(btn, true, 'Applying…');
    const r = await api('/api/apply', { method: 'POST', body: { presetId, mode: 'global', dryRun: false } });
    const failed = ((r && r.executed) || []).filter(x => !x.ok).length;
    if (failed) toast(`Global apply done — ${failed} commands failed`, 'error');
    else toast(`🌍 "${preset ? preset.name : presetId}" applied globally`);
    await Promise.all([reloadState(), reloadStatus()]);
    renderView(S.ui.view);
  } catch { /* toast handled */ }
  finally { setBusy(btn, false); }
}

/* ===== Refrigerator (catalog) ===== */
function groupByType(items) {
  const g = new Map();
  items.forEach(i => {
    const t = i.type || 'tool';
    if (!g.has(t)) g.set(t, []);
    g.get(t).push(i);
  });
  const order = [...TYPE_ORDER, ...[...g.keys()].filter(t => !TYPE_ORDER.includes(t))];
  return order.filter(t => g.has(t)).map(t => [t, g.get(t)]);
}

function renderPantry() {
  const counts = { all: S.catalog.length };
  S.catalog.forEach(i => { const t = i.type || 'tool'; counts[t] = (counts[t] || 0) + 1; });
  const chipDefs = [['all', 'All'], ...TYPE_ORDER.map(t => [t, TYPE_LABELS[t]])];
  $('#pantryChips').innerHTML = chipDefs.map(([t, l]) =>
    `<button class="chip ${S.ui.pantry.type === t ? 'active' : ''}" data-action="pantry-chip" data-type="${t}">${esc(l)} <span class="chip-n">${counts[t] || 0}</span></button>`
  ).join('');
  renderPantryList();
}

function pantryFiltered() {
  const { q, type } = S.ui.pantry;
  const ql = q.trim().toLowerCase();
  return S.catalog.filter(i => {
    if (type !== 'all' && (i.type || 'tool') !== type) return false;
    if (!ql) return true;
    return [i.name, i.desc, i.id, ...(i.tags || [])].join(' ').toLowerCase().includes(ql);
  });
}

function renderPantryList() {
  const list = $('#pantryList');
  if (!S.catalog.length) {
    list.innerHTML = '<div class="empty-state">The catalog is empty. Check that the server is running.</div>';
    return;
  }
  const items = pantryFiltered();
  if (!items.length) {
    list.innerHTML = '<div class="empty-state">🔍 No results. Try a different keyword or filter.</div>';
    return;
  }
  list.innerHTML = groupByType(items).map(([type, arr]) => {
    const collapsed = S.ui.pantry.collapsed.has(type);
    return `<section class="cat-section ${collapsed ? 'collapsed' : ''}">
      <button class="cat-head" data-action="toggle-cat" data-scope="pantry" data-key="${esc(type)}">
        <span class="cat-title">${badge(type)} ${esc(TYPE_FULL[type] || type)}</span>
        <span class="cat-meta">${arr.length} items <span class="arrow">▾</span></span>
      </button>
      <div class="card-grid">${arr.map(pantryCard).join('')}</div>
    </section>`;
  }).join('');
}

function pantryCard(i) {
  const url = safeUrl(i.url);
  return `<div class="item-card">
    ${i.source === 'custom' ? `<button class="icon-btn card-del" title="Delete" data-action="del-custom" data-id="${esc(i.id)}">×</button>` : ''}
    <div class="item-top">
      <span class="item-name">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(i.name || i.id)}</a>` : esc(i.name || i.id)}</span>
      ${badge(i.type)}
    </div>
    <div class="item-desc">${esc(i.desc || '')}</div>
    <div class="item-meta">
      ${i.stars ? `<span class="stars">★ ${esc(i.stars)}</span>` : ''}
      ${(i.tags || []).slice(0, 4).map(t => `<span class="tag">#${esc(t)}</span>`).join('')}
      ${i.source === 'custom' ? '<span class="tag tag-custom">Custom</span>' : ''}
    </div>
    ${i.install ? `<button class="install-code" title="Click to copy" data-action="copy-install" data-id="${esc(i.id)}"><code>${esc(i.install)}</code></button>` : ''}
    <div class="item-actions"><button class="btn btn-sm" data-action="add-to-preset" data-id="${esc(i.id)}">🍳 Add to preset</button></div>
  </div>`;
}

async function submitCustom() {
  const name = $('#cmName').value.trim();
  if (!name) { toast('Enter a name', 'error'); return; }
  const body = {
    name,
    type: $('#cmType').value,
    url: $('#cmUrl').value.trim() || null,
    desc: $('#cmDesc').value.trim(),
    install: $('#cmInstall').value.trim() || null,
    tags: $('#cmTags').value.split(',').map(s => s.trim()).filter(Boolean),
  };
  try {
    await api('/api/catalog/items', { method: 'POST', body });
    hideModal('customModal');
    ['cmName', 'cmUrl', 'cmDesc', 'cmInstall', 'cmTags'].forEach(id => { $('#' + id).value = ''; });
    toast(`🧊 "${name}" added to the refrigerator`);
    await reloadCatalog();
    renderView(S.ui.view);
  } catch { /* toast handled */ }
}

async function deleteCustom(id) {
  const item = S.itemMap.get(id);
  const ok = await openConfirm({
    title: 'Delete custom ingredient',
    bodyHtml: `<p>Delete <strong>${esc(item ? item.name : id)}</strong> from the refrigerator?<br><span class="muted">References in presets will show as "missing".</span></p>`,
    okText: 'Delete', danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/catalog/items/' + encodeURIComponent(id), { method: 'DELETE' });
    toast('🗑 Deleted');
    await reloadCatalog();
    renderView(S.ui.view);
  } catch { /* toast handled */ }
}

async function onAddToPreset(anchor, itemId) {
  const pid = await pickPreset(anchor, itemId);
  if (!pid) return;
  await addItemToPreset(pid, itemId);
}

async function addItemToPreset(presetId, itemId) {
  const p = S.presets.find(x => x.id === presetId);
  if (!p) return;
  const item = S.itemMap.get(itemId);
  if ((p.items || []).includes(itemId)) {
    toast(`Already in "${p.name}"`, 'info');
    return;
  }
  const prev = p.items || [];
  p.items = [...prev, itemId];
  try {
    await api('/api/presets/' + encodeURIComponent(p.id), { method: 'PUT', body: p });
    toast(`🍳 ${item ? item.name : itemId} → ${p.name}`);
    if (S.ui.view === 'builder') renderBuilderCols();
    if (S.ui.view === 'apply') renderApply();
  } catch {
    p.items = prev;
  }
}

/* ===== Preset Builder ===== */
function renderBuilder() {
  renderBuilderPantry();
  renderBuilderCols();
}

function renderBuilderPantry() {
  const q = S.ui.builder.q.trim().toLowerCase();
  const items = S.catalog.filter(i => !q || [i.name, i.desc, i.id, ...(i.tags || [])].join(' ').toLowerCase().includes(q));
  const el = $('#builderPantryList');
  if (!items.length) {
    el.innerHTML = '<div class="empty-state" style="margin:10px;border:none">No ingredients</div>';
    return;
  }
  el.innerHTML = groupByType(items).map(([type, arr]) => {
    const collapsed = S.ui.builder.collapsed.has(type);
    return `<div class="mini-section ${collapsed ? 'collapsed' : ''}">
      <button class="cat-head mini" data-action="toggle-cat" data-scope="builder" data-key="${esc(type)}">
        <span>${esc(TYPE_LABELS[type] || type)}</span>
        <span class="cat-meta">${arr.length} <span class="arrow">▾</span></span>
      </button>
      <div class="mini-items">${arr.map(miniCard).join('')}</div>
    </div>`;
  }).join('');
}

function miniCard(i) {
  return `<div class="mini-item dnd-item" draggable="true" data-id="${esc(i.id)}" data-source="pantry" title="${esc(i.desc || '')}">
    <span class="mini-name">${esc(i.name || i.id)}</span>${badge(i.type)}
  </div>`;
}

function renderBuilderCols() {
  const el = $('#builderCols');
  let html = S.presets.map(p => {
    const items = p.items || [];
    const typeCount = {};
    items.forEach(id => {
      const i = S.itemMap.get(id);
      if (i) { const t = i.type || 'tool'; typeCount[t] = (typeCount[t] || 0) + 1; }
    });
    const missing = items.filter(id => !S.itemMap.has(id)).length;
    const stats = Object.entries(typeCount)
      .map(([t, c]) => `<span class="stat-chip">${badge(t)} ${c}</span>`).join('')
      || '<span class="muted">Empty</span>';
    return `<div class="preset-col">
      <div class="preset-col-head">
        <input class="emoji-input" data-field="emoji" data-preset="${esc(p.id)}" maxlength="4" value="${esc(p.emoji || '📦')}" title="Emoji">
        <input class="name-input" data-field="name" data-preset="${esc(p.id)}" value="${esc(p.name || '')}" placeholder="Name">
        <button class="icon-btn" title="Menu" data-action="col-menu" data-preset="${esc(p.id)}">⋯</button>
      </div>
      <div class="preset-col-stats">${stats}${missing ? `<span class="stat-chip warn">⚠ ${missing} missing</span>` : ''}</div>
      <div class="drop-zone" data-preset="${esc(p.id)}">
        ${items.length ? items.map(id => colItemHtml(p.id, id)).join('') : '<div class="drop-empty">Drag &amp; drop<br>ingredients here</div>'}
      </div>
    </div>`;
  }).join('');
  html += `<button class="add-col" data-action="new-preset"><span class="plus">+</span>New preset<br><small class="muted">Build combos by purpose</small></button>`;
  el.innerHTML = html;
}

function colItemHtml(presetId, id) {
  const i = S.itemMap.get(id);
  if (!i) {
    return `<div class="col-item missing">
      <button class="icon-btn col-remove" title="Remove" data-action="col-remove" data-preset="${esc(presetId)}" data-id="${esc(id)}">×</button>
      <span class="warn">⚠ Missing</span> <code>${esc(id)}</code>
    </div>`;
  }
  return `<div class="col-item dnd-item" draggable="true" data-id="${esc(id)}" data-source="${esc(presetId)}">
    <button class="icon-btn col-remove" title="Remove" data-action="col-remove" data-preset="${esc(presetId)}" data-id="${esc(id)}">×</button>
    <div class="item-top"><span class="item-name">${esc(i.name || i.id)}</span>${badge(i.type)}</div>
    <div class="item-desc small">${esc(i.desc || '')}</div>
  </div>`;
}

/* --- Auto-save (1s debounce) --- */
const saveTimers = new Map();
let saveStateTimer = null;

function schedulePresetSave(id) {
  setSaveState('saving');
  clearTimeout(saveTimers.get(id));
  saveTimers.set(id, setTimeout(async () => {
    saveTimers.delete(id);
    const p = S.presets.find(x => x.id === id);
    if (!p) return;
    try {
      await api('/api/presets/' + encodeURIComponent(id), { method: 'PUT', body: p });
      if (!saveTimers.size) setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  }, 1000));
}

function setSaveState(s) {
  const el = $('#saveIndicator');
  clearTimeout(saveStateTimer);
  if (s === 'saving') { el.textContent = 'Saving…'; el.className = 'save-indicator saving'; }
  else if (s === 'saved') {
    el.textContent = 'Saved ✓'; el.className = 'save-indicator saved';
    saveStateTimer = setTimeout(() => { el.textContent = ''; }, 2500);
  }
  else if (s === 'error') { el.textContent = 'Save failed'; el.className = 'save-indicator error'; }
}

function colRemove(presetId, itemId) {
  const p = S.presets.find(x => x.id === presetId);
  if (!p) return;
  p.items = (p.items || []).filter(x => x !== itemId);
  schedulePresetSave(presetId);
  renderBuilderCols();
}

function uniquePresetId(base) {
  base = base.slice(0, 58) || 'preset';
  let id = base, n = 2;
  while (S.presets.some(p => p.id === id)) id = base + '-' + (n++);
  return id;
}

function slugPresetId(name) {
  const s = kebab(name);
  return uniquePresetId(s || 'preset-' + Date.now().toString(36));
}

async function submitPreset() {
  const name = $('#npName').value.trim();
  if (!name) { toast('Enter a name', 'error'); return; }
  const id = slugPresetId(name);
  const now = new Date().toISOString();
  const preset = {
    id, name,
    emoji: $('#npEmoji').value.trim() || '📦',
    description: $('#npDesc').value.trim(),
    items: [], createdAt: now, updatedAt: now,
  };
  try {
    await api('/api/presets/' + encodeURIComponent(id), { method: 'PUT', body: preset });
    hideModal('presetModal');
    $('#npName').value = '';
    $('#npDesc').value = '';
    await reloadPresets();
    toast(`🍳 "${name}" preset created`);
    renderView(S.ui.view);
  } catch { /* toast handled */ }
}

async function colMenu(anchor, presetId) {
  const v = await openPicker({
    title: 'Preset menu',
    anchor,
    options: [
      { label: '📤 Export JSON', value: 'export' },
      { label: '📋 Duplicate', value: 'dup' },
      { label: '🗑 Delete', value: 'del' },
    ],
  });
  if (v === 'export') exportPresetJson(presetId);
  else if (v === 'dup') duplicatePreset(presetId);
  else if (v === 'del') deletePresetFlow(presetId);
}

function exportPresetJson(id) {
  const p = S.presets.find(x => x.id === id);
  if (!p) return;
  download(`${p.id}.json`, JSON.stringify(p, null, 2), 'application/json');
  toast('📤 Preset JSON downloaded');
}

async function duplicatePreset(id) {
  const p = S.presets.find(x => x.id === id);
  if (!p) return;
  const nid = uniquePresetId(kebab(p.id + '-copy'));
  const now = new Date().toISOString();
  const copy = { ...p, id: nid, name: (p.name || p.id) + ' copy', createdAt: now, updatedAt: now };
  try {
    await api('/api/presets/' + encodeURIComponent(nid), { method: 'PUT', body: copy });
    await reloadPresets();
    renderBuilder();
    toast(`📋 "${p.name}" duplicated`);
  } catch { /* toast handled */ }
}

async function deletePresetFlow(id) {
  const p = S.presets.find(x => x.id === id);
  if (!p) return;
  const ok = await openConfirm({
    title: 'Delete preset',
    bodyHtml: `<p>Delete the <strong>${esc(p.emoji || '')} ${esc(p.name || p.id)}</strong> preset?<br><span class="muted">The ingredients themselves stay in the refrigerator.</span></p>`,
    okText: 'Delete', danger: true,
  });
  if (!ok) return;
  try {
    await api('/api/presets/' + encodeURIComponent(id), { method: 'DELETE' });
    S.presets = S.presets.filter(x => x.id !== id);
    toast('🗑 Preset deleted');
    renderView(S.ui.view);
  } catch { /* toast handled */ }
}

async function importPresetFile(file) {
  let obj;
  try {
    obj = JSON.parse(await file.text());
  } catch (e) {
    toast('JSON parse failed: ' + e.message, 'error');
    return;
  }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.items)) {
    toast('Not a preset format (items array required)', 'error');
    return;
  }
  let id = (typeof obj.id === 'string' && /^[a-z0-9-]{1,64}$/.test(obj.id)) ? obj.id : slugPresetId(obj.name || 'preset');
  if (S.presets.some(p => p.id === id)) {
    const ok = await openConfirm({
      title: 'Overwrite preset',
      bodyHtml: `<p>The <code>${esc(id)}</code> preset already exists. Overwrite it with the imported content?</p>`,
      okText: 'Overwrite', danger: true,
    });
    if (!ok) return;
  }
  const now = new Date().toISOString();
  const preset = {
    id,
    name: String(obj.name || id),
    emoji: String(obj.emoji || '📦'),
    description: String(obj.description || ''),
    items: obj.items.filter(x => typeof x === 'string'),
    createdAt: obj.createdAt || now,
    updatedAt: now,
  };
  try {
    await api('/api/presets/' + encodeURIComponent(id), { method: 'PUT', body: preset });
    await reloadPresets();
    renderView(S.ui.view);
    toast(`📥 "${preset.name}" imported`);
  } catch { /* toast handled */ }
}

/* --- Drag & drop --- */
let dragCtx = null;

function initDnd() {
  document.addEventListener('dragstart', e => {
    const card = e.target.closest ? e.target.closest('.dnd-item') : null;
    if (!card) return;
    dragCtx = { id: card.dataset.id, source: card.dataset.source };
    card.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', card.dataset.id); } catch { /* ignore IE compatibility */ }
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  document.addEventListener('dragend', () => {
    $$('.dnd-item.dragging').forEach(x => x.classList.remove('dragging'));
    $$('.drop-zone.over').forEach(z => z.classList.remove('over'));
    dragCtx = null;
  });
  document.addEventListener('dragover', e => {
    const z = e.target.closest ? e.target.closest('.drop-zone') : null;
    if (z && dragCtx) {
      e.preventDefault();
      e.dataTransfer.dropEffect = dragCtx.source === 'pantry' ? 'copy' : 'move';
      z.classList.add('over');
    }
  });
  document.addEventListener('dragleave', e => {
    const z = e.target.closest ? e.target.closest('.drop-zone') : null;
    if (z && !z.contains(e.relatedTarget)) z.classList.remove('over');
  });
  document.addEventListener('drop', e => {
    const z = e.target.closest ? e.target.closest('.drop-zone') : null;
    if (!z || !dragCtx) return;
    e.preventDefault();
    const target = S.presets.find(p => p.id === z.dataset.preset);
    if (!target) return;
    const { id, source } = dragCtx;
    if (source !== 'pantry' && source !== target.id) {
      const src = S.presets.find(p => p.id === source);
      if (src) {
        src.items = (src.items || []).filter(x => x !== id);
        schedulePresetSave(src.id);
      }
    }
    if (!(target.items || []).includes(id)) {
      target.items = [...(target.items || []), id];
      schedulePresetSave(target.id);
      const item = S.itemMap.get(id);
      toast(`${item ? item.name : id} → ${target.name}`);
    } else if (source !== 'pantry' && source !== target.id) {
      toast('Already added', 'info');
    }
    renderBuilderCols();
  });
}

/* ===== Discover & AI Recommendation ===== */
const GH_TRENDING = 'claude code OR mcp server OR ai agent';

function renderDiscover() {
  const D = S.ui.discover;
  const src = D.src;
  $$('.src-tab', $('#srcTabs')).forEach(b => b.classList.toggle('active', b.dataset.src === src));
  ['github', 'skillsmp', 'ai'].forEach(s => $('#panel-' + s).classList.toggle('hidden', s !== src));
  if (src === 'github') {
    syncGhSegs();
    if (!D.ghLoaded) runGhQuery(GH_TRENDING);   // marketplace-style default browse
    else renderGhResults();
  } else if (src === 'skillsmp') {
    renderSmpResults();
  } else {
    loadAiClis();
    renderAiResults();
  }
}

function syncGhSegs() {
  const D = S.ui.discover;
  $$('#ghSort button').forEach(b => b.classList.toggle('active', b.dataset.sort === D.sort));
  $$('#ghRange button').forEach(b => b.classList.toggle('active', b.dataset.range === D.range));
}

async function loadAiClis() {
  const D = S.ui.discover;
  if (D.clis) { renderAiClis(); return; }
  try {
    const d = await api('/api/ai-clis', { silent: true });
    D.clis = d.clis || [];
    if (!D.provider && d.current) {
      const match = D.clis.find(c => c.cmd === d.current && c.available);
      if (match) D.provider = match.id;
    }
  } catch { D.clis = []; }
  renderAiClis();
}

function renderAiClis() {
  const D = S.ui.discover;
  const row = $('#aiCliRow');
  const sel = $('#aiProvider');
  if (!row || !sel) return;
  const clis = D.clis || [];
  const anyAvail = clis.some(c => c.available);
  row.innerHTML = clis.length
    ? clis.map(c => `<span class="ai-cli-pill ${c.available ? 'on' : ''}">${c.available ? '●' : '○'} ${esc(c.name)}</span>`).join('')
      + (anyAvail ? '' : '<span class="ai-cli-pill">No AI CLI detected — install one or set it in Settings</span>')
    : '';
  const cur = sel.value;
  sel.innerHTML = '<option value="">Auto-detect</option>'
    + clis.filter(c => c.available).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  sel.value = D.provider && clis.find(c => c.id === D.provider && c.available) ? D.provider : (cur || '');
}

function loadingBox(msg) {
  return `<div class="loading-box"><span class="spinner"></span><span>${esc(msg)}</span></div>`;
}

function extCard(r, src, idx) {
  const url = safeUrl(r.url);
  const inFridge = r.id && S.itemMap.has(r.id);
  return `<div class="item-card">
    <div class="item-top">
      <span class="item-name">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(r.name || '')}</a>` : esc(r.name || '')}</span>
      ${badge(r.type || 'skill')}
    </div>
    <div class="item-desc">${esc(r.desc || '')}</div>
    <div class="item-meta">
      ${r.stars ? `<span class="stars">★ ${esc(r.stars)}</span>` : ''}
      ${r.forks ? `<span class="tag">⑂ ${esc(r.forks)}</span>` : ''}
      ${r.author ? `<span class="tag">@${esc(r.author)}</span>` : ''}
      ${inFridge ? '<span class="tag tag-custom">In refrigerator</span>' : ''}
    </div>
    <div class="item-actions">
      <button class="btn btn-sm" data-action="ext-fridge" data-src="${src}" data-idx="${idx}">🧊 Add to refrigerator</button>
      <button class="btn btn-sm" data-action="ext-preset" data-src="${src}" data-idx="${idx}">🍳 Add to preset</button>
    </div>
  </div>`;
}

function ghSearch() {
  const q = $('#ghQuery').value.trim();
  if (!q) { toast('Enter a search term', 'error'); return; }
  runGhQuery(q);
}

async function runGhQuery(q) {
  const D = S.ui.discover;
  D.ghLoaded = true;
  D.ghLoading = true;
  renderGhResults();
  try {
    const params = new URLSearchParams({ q, sort: D.sort, range: D.range });
    const d = await api('/api/search/github?' + params.toString());
    D.gh = { q, results: d.results || [], isDefault: q === GH_TRENDING };
  } catch {
    D.gh = { q, results: null };
  }
  D.ghLoading = false;
  renderGhResults();
}

function renderGhResults() {
  const el = $('#ghResults');
  const D = S.ui.discover;
  if (D.ghLoading) { el.innerHTML = loadingBox('Searching GitHub…'); return; }
  if (!D.gh) { el.innerHTML = loadingBox('Loading trending repos…'); return; }
  if (D.gh.results === null) { el.innerHTML = '<div class="empty-state">Search failed. Try again later or add a GitHub token in <a href="#settings">Settings</a>.</div>'; return; }
  if (!D.gh.results.length) { el.innerHTML = `<div class="empty-state">No results for "${esc(D.gh.q)}".</div>`; return; }
  el.innerHTML = '<div class="card-grid" style="padding:0">' + D.gh.results.map((r, i) => extCard(r, 'gh', i)).join('') + '</div>';
}

async function smpSearch() {
  const q = $('#smpQuery').value.trim();
  if (!q) { toast('Enter a search term', 'error'); return; }
  const D = S.ui.discover;
  D.smpLoading = true;
  renderSmpResults();
  try {
    const d = await api('/api/search/skillsmp?q=' + encodeURIComponent(q));
    D.smp = { q, results: d.results || [], source: d.source, fallbackUrl: d.fallbackUrl };
  } catch {
    D.smp = { q, results: null };
  }
  D.smpLoading = false;
  renderSmpResults();
}

function renderSmpResults() {
  const el = $('#smpResults');
  const D = S.ui.discover;
  if (D.smpLoading) { el.innerHTML = loadingBox('Searching SkillsMP…'); return; }
  if (!D.smp) { el.innerHTML = '<div class="empty-state">🔎 Search community skills on SkillsMP</div>'; return; }
  if (D.smp.results === null) { el.innerHTML = '<div class="empty-state">Search failed. Please try again later.</div>'; return; }
  if (D.smp.source === 'fallback') {
    const fb = safeUrl(D.smp.fallbackUrl);
    el.innerHTML = `<div class="empty-state">
      <p>Can't connect directly to the SkillsMP API — try searching on the site.</p>
      <div class="row-center">
        ${fb ? `<a class="btn btn-primary" href="${esc(fb)}" target="_blank" rel="noopener">Search on SkillsMP ↗</a>` : ''}
        <button class="btn" data-action="fallback-gh" data-q="${esc(D.smp.q)}">Search GitHub instead</button>
      </div>
    </div>`;
    return;
  }
  if (!D.smp.results.length) { el.innerHTML = `<div class="empty-state">No results for "${esc(D.smp.q)}".</div>`; return; }
  el.innerHTML = '<div class="card-grid" style="padding:0">' + D.smp.results.map((r, i) => extCard(r, 'smp', i)).join('') + '</div>';
}

function switchToGithubSearch(q) {
  S.ui.discover.src = 'github';
  if (S.ui.view !== 'discover') location.hash = '#discover';
  renderDiscover();
  $('#ghQuery').value = q;
  if (q) ghSearch();
}

async function aiRecommend() {
  const goal = $('#aiGoal').value.trim();
  if (!goal) { toast('Describe what you want to build first', 'error'); return; }
  const D = S.ui.discover;
  if (D.aiLoading) return;
  const provider = ($('#aiProvider') && $('#aiProvider').value) || '';
  D.provider = provider;
  D.aiLoading = true;
  renderAiResults();
  try {
    D.ai = await api('/api/recommend', { method: 'POST', body: { goal, provider } });
  } catch { /* toast handled, keep previous results */ }
  D.aiLoading = false;
  renderAiResults();
}

function renderAiResults() {
  const el = $('#aiResults');
  const D = S.ui.discover;
  const btn = $('#aiBtn');
  if (btn) btn.disabled = D.aiLoading;
  if (D.aiLoading) {
    el.innerHTML = `<div class="loading-box"><span class="spinner"></span>
      <span><strong>Analyzing with your AI CLI… (up to 2-3 min)</strong><br>
      <span class="muted">Scanning the whole catalog to pick combos that fit your goal.</span></span></div>`;
    return;
  }
  if (!D.ai) {
    el.innerHTML = '<div class="empty-state">🤖 Enter a goal to get the best combo of your refrigerator ingredients plus new tools.</div>';
    return;
  }
  const recs = D.ai.recommendations || [];
  const extra = D.ai.extra || [];
  const kws = D.ai.keywords || [];
  const used = D.ai.usedCli;
  let html = '';
  if (used && used.name) html += `<div class="ai-cli-row" style="margin-bottom:12px"><span class="ai-cli-pill on">🤖 Recommended by ${esc(used.name)}</span></div>`;
  html += `<div class="panel"><div class="panel-head"><h2>🧊 Catalog recommendations (${recs.length})</h2></div>`;
  html += recs.length ? '<div class="card-grid" style="padding:0">' + recs.map(r => {
    const i = r.item || S.itemMap.get(r.id);
    if (!i) return '';
    const url = safeUrl(i.url);
    return `<div class="item-card">
      <div class="item-top">
        <span class="item-name">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(i.name || r.id)}</a>` : esc(i.name || r.id)}</span>
        ${badge(i.type)}
      </div>
      <div class="item-desc">${esc(i.desc || '')}</div>
      <div class="ai-reason">💡 ${esc(r.reason || '')}</div>
      <div class="item-actions"><button class="btn btn-sm" data-action="add-to-preset" data-id="${esc(r.id)}">🍳 Add to preset</button></div>
    </div>`;
  }).join('') + '</div>' : '<div class="empty-state">No recommendations from the catalog.</div>';
  html += '</div>';
  if (extra.length) {
    html += `<div class="panel"><div class="panel-head"><h2>🌐 Recommendations beyond the catalog (${extra.length})</h2></div><div class="card-grid" style="padding:0">`;
    html += extra.map((r, i) => {
      const url = safeUrl(r.url);
      return `<div class="item-card">
        <div class="item-top">
          <span class="item-name">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(r.name || '')}</a>` : esc(r.name || '')}</span>
          ${badge(r.type || 'tool')}
        </div>
        ${r.install ? `<div class="install-code static"><code>${esc(r.install)}</code></div>` : ''}
        <div class="ai-reason">💡 ${esc(r.reason || '')}</div>
        <div class="item-actions"><button class="btn btn-sm" data-action="ext-fridge" data-src="extra" data-idx="${i}">🧊 Add to refrigerator</button></div>
      </div>`;
    }).join('');
    html += '</div></div>';
  }
  if (kws.length) {
    html += `<div class="panel"><div class="panel-head"><h2>🔑 Suggested search keywords</h2><span class="muted small">Click to search in the GitHub tab</span></div><div class="chips" style="margin:0">`;
    html += kws.map(k => `<button class="chip" data-action="keyword" data-q="${esc(k)}">🔍 ${esc(k)}</button>`).join('');
    html += '</div></div>';
  }
  el.innerHTML = html;
}

function getExt(src, idx) {
  const D = S.ui.discover;
  if (src === 'gh') return (D.gh && D.gh.results && D.gh.results[idx]) || null;
  if (src === 'smp') {
    const r = D.smp && D.smp.results && D.smp.results[idx];
    if (!r) return null;
    return { ...r, id: r.id || ('smp-' + (kebab(r.name) || Date.now().toString(36))), type: r.type || 'skill' };
  }
  if (src === 'extra') {
    const r = D.ai && D.ai.extra && D.ai.extra[idx];
    if (!r) return null;
    return { ...r, id: r.id || (kebab(r.name) || 'item-' + Date.now().toString(36)), type: r.type || 'tool' };
  }
  return null;
}

async function addExtToCatalog(r, type) {
  const body = {
    id: r.id,
    name: r.name,
    type,
    desc: r.desc || '',
    url: r.url || null,
    stars: r.stars || null,
    install: r.install || null,
    tags: r.tags || [],
  };
  try {
    await api('/api/catalog/items', { method: 'POST', body });
    toast(`🧊 "${r.name}" added to the refrigerator`);
    await reloadCatalog();
    return true;
  } catch {
    return false;
  }
}

async function extAddFridge(anchor, src, idx) {
  const r = getExt(src, idx);
  if (!r) return;
  if (r.id && S.itemMap.has(r.id)) { toast('Already in the refrigerator', 'info'); return; }
  const type = await pickType(anchor, r.type || 'skill');
  if (!type) return;
  const ok = await addExtToCatalog(r, type);
  if (ok) renderView(S.ui.view);
}

async function extAddPreset(anchor, src, idx) {
  const r = getExt(src, idx);
  if (!r) return;
  if (!r.id || !S.itemMap.has(r.id)) {
    const ok = await addExtToCatalog(r, r.type || 'skill');
    if (!ok) return;
  }
  const pid = await pickPreset(anchor, r.id);
  if (pid) await addItemToPreset(pid, r.id);
  renderView(S.ui.view);
}

/* ===== Apply & Export ===== */
function currentApplyPreset() {
  return S.presets.find(p => p.id === S.ui.apply.presetId) || null;
}

function renderApply() {
  const A = S.ui.apply;
  if (A.presetId && !S.presets.some(p => p.id === A.presetId)) A.presetId = '';
  if (!A.presetId && S.presets.length) {
    const last = S.state && S.state.lastApplied && S.state.lastApplied.presetId;
    A.presetId = (last && S.presets.some(p => p.id === last)) ? last : S.presets[0].id;
  }
  if (!A.projectPath) A.projectPath = (S.config && S.config.defaultProjectPath) || '';
  const sel = $('#applyPreset');
  sel.innerHTML = S.presets.length
    ? S.presets.map(p => `<option value="${esc(p.id)}" ${p.id === A.presetId ? 'selected' : ''}>${esc((p.emoji || '📦') + ' ' + (p.name || p.id))}</option>`).join('')
    : '<option value="">No presets — create one in the builder</option>';
  renderApplySummary();
  renderModeCards();
  renderModePanel();
  renderFormatTabs();
  refreshExport();
}

function renderApplySummary() {
  const el = $('#applySummary');
  const p = currentApplyPreset();
  if (!p) {
    el.innerHTML = '<div class="empty-state" style="margin-top:12px">Create a preset first in the <a href="#builder">Preset Builder</a>.</div>';
    return;
  }
  const chips = (p.items || []).map(id => {
    const i = S.itemMap.get(id);
    return i
      ? `<span class="sum-chip">${badge(i.type)} ${esc(i.name || id)}</span>`
      : `<span class="sum-chip missing">⚠ Missing: ${esc(id)}</span>`;
  }).join('');
  el.innerHTML = `${p.description ? `<div class="muted small" style="margin-top:8px">${esc(p.description)}</div>` : ''}
    <div class="sum-chips">${chips || '<span class="muted small">No items — add ingredients in the builder</span>'}</div>`;
}

function renderModeCards() {
  $('#modeCards').innerHTML = MODES.map(m => `
    <button class="mode-card ${S.ui.apply.mode === m.id ? 'selected' : ''} ${m.id === 'global' ? 'danger' : ''}" data-action="mode-card" data-mode="${m.id}">
      <span class="mode-radio">${S.ui.apply.mode === m.id ? '●' : '○'}</span>
      <span class="mode-icon">${m.icon}</span>
      <span class="mode-name">${m.name}</span>
      <span class="mode-desc">${m.desc}</span>
    </button>`).join('');
}

function renderModePanel() {
  const A = S.ui.apply;
  const el = $('#modePanel');
  const p = currentApplyPreset();
  if (!p) { el.innerHTML = ''; return; }

  if (A.mode === 'session') {
    let html = `<div class="panel"><div class="panel-head"><h2>🎯 Session Apply</h2></div>
      <p class="muted small">Enables the preset's <strong>plugins</strong> (via <code>--settings</code>) and <strong>MCP servers</strong> (via <code>--mcp-config</code>) for one <code>claude</code> session. Nothing is permanently changed. Skills, tools and agents can't be session-enabled — install them with the <strong>install.sh</strong> export (Export section below) or Project apply.</p>
      <div class="row-end"><button class="btn btn-primary" data-action="apply-session">Generate session settings</button></div>`;
    if (A.session) {
      const S2 = A.session;
      const ni = S2.needInstall || [];
      html += `<div class="result-box ok">
        <h4>✅ Session settings generated</h4>
        <div class="kv"><span class="k">Applied</span><span>${esc(String(S2.pluginCount ?? 0))} plugin(s) · ${esc(String(S2.mcpCount ?? 0))} MCP server(s)</span></div>
        <div class="kv"><span class="k">Settings file</span><code>${esc(S2.settingsPath || '')}</code></div>
        ${S2.mcpPath ? `<div class="kv"><span class="k">MCP config</span><code>${esc(S2.mcpPath)}</code></div>` : ''}
        <div class="code-row"><code>${esc(S2.command || '')}</code><button class="btn btn-sm" data-action="copy-text" data-copy="${esc(S2.command || '')}">Copy</button></div>
        <div class="code-row"><code>${esc(S2.aliasLine || '')}</code><button class="btn btn-sm" data-action="copy-text" data-copy="${esc(S2.aliasLine || '')}">Copy</button></div>
        ${ni.length ? `<div class="warn-box" style="margin-top:6px">⚠️ ${ni.length} item(s) can't be session-enabled (skills/tools/agents) and need installation: ${ni.map(i => esc(i.name)).join(', ')}. Use the install.sh export below.</div>` : ''}
      </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
    return;
  }

  if (A.mode === 'project') {
    let html = `<div class="panel"><div class="panel-head"><h2>📁 Project Apply</h2></div>
      <p class="muted small">Creates/merges <code>.claude/settings.json</code> · <code>.mcp.json</code> · <code>CLAUDE.md</code> in the project folder. Existing files are backed up as <code>.bak</code>. Preview the plan first.</p>
      <label class="field-label" for="projPath">Project path</label>
      <div class="row">
        <input class="input grow" id="projPath" value="${esc(A.projectPath)}" placeholder="/absolute/path/to/project">
        <button class="btn" data-action="project-preview">Preview</button>
        <button class="btn btn-primary" data-action="project-apply" ${A.projectPlan ? '' : 'disabled'}>Apply</button>
      </div>`;
    if (A.projectPlan) html += projectPlanHtml(A.projectPlan);
    if (A.projectResult) html += projectResultHtml(A.projectResult);
    html += '</div>';
    el.innerHTML = html;
    return;
  }

  let html = `<div class="panel"><div class="panel-head"><h2>🌍 Global Apply</h2></div>
    <p class="muted small">Switches <strong>user-global</strong> plugins via the claude CLI. <span class="warn">Active plugins not in the preset get disabled.</span> Flow: preview → confirm modal → run.</p>
    <div class="row-end">
      <button class="btn" data-action="global-preview">Preview</button>
      <button class="btn btn-red" data-action="global-apply" ${A.globalPlan ? '' : 'disabled'}>Apply globally…</button>
    </div>`;
  if (A.globalPlan) html += globalPlanHtml(A.globalPlan);
  if (A.globalResult) html += globalLogHtml(A.globalResult);
  html += '</div>';
  el.innerHTML = html;
}

function projectPlanHtml(plan) {
  const writes = plan.writes || [];
  const actLabel = { create: 'Create', merge: 'Merge', skip: 'Skip' };
  let html = '<div class="result-box"><h4>📋 Execution plan (dryRun)</h4>';
  html += writes.length
    ? `<div class="table-wrap"><table class="plan-table">
        <thead><tr><th>File</th><th>Action</th><th>Note</th></tr></thead><tbody>` +
      writes.map(w => `<tr>
        <td><code>${esc(w.path || '')}</code></td>
        <td><span class="pill act-${esc(w.action || 'skip')}">${esc(actLabel[w.action] || w.action || '')}</span></td>
        <td class="muted">${esc(w.note || '')}</td>
      </tr>`).join('') + '</tbody></table></div>'
    : '<p class="muted">No files to write.</p>';
  if (plan.installScript) {
    html += `<h5>install.sh preview <span class="muted">(not run automatically)</span></h5><pre class="code-view small">${esc(plan.installScript)}</pre>`;
  }
  html += '</div>';
  return html;
}

function projectResultHtml(r) {
  const li = arr => (arr && arr.length)
    ? `<ul class="plan-list">${arr.map(x => `<li><code>${esc(x)}</code></li>`).join('')}</ul>`
    : '<p class="muted">None</p>';
  return `<div class="result-box ok"><h4>✅ Project apply done</h4>
    <h5>Written (${((r.written) || []).length})</h5>${li(r.written)}
    <h5>Skipped (${((r.skipped) || []).length})</h5>${li(r.skipped)}
    <h5>Backups (${((r.backups) || []).length})</h5>${li(r.backups)}
    ${r.installScriptPath ? `<p>Install script: <code>${esc(r.installScriptPath)}</code> <span class="muted">— run it manually</span></p>` : ''}
  </div>`;
}

function globalPlanHtml(plan) {
  const sec = (title, arr, cls) => `<h4 class="${cls}">${title} (${(arr || []).length})</h4>` +
    ((arr || []).length
      ? `<ul class="plan-list">${arr.map(x => `<li><code>${esc(x)}</code></li>`).join('')}</ul>`
      : '<p class="muted">None</p>');
  return `<div class="result-box">
    ${sec('🛒 Marketplace additions', plan.marketplaceAdd, '')}
    ${sec('✅ Enable', plan.enable, 'plan-en')}
    ${sec('⛔ Disable', plan.disable, 'plan-dis')}
  </div>`;
}

function globalLogHtml(r) {
  const ex = (r && r.executed) || [];
  return '<div class="result-box"><h4>🧾 Execution log</h4>' + (ex.length
    ? ex.map(x => `<div class="log-row ${x.ok ? 'ok' : 'fail'}">
        <span class="log-badge">${x.ok ? '✓' : '✗'}</span><code>${esc(x.cmd || '')}</code>
        ${x.output ? `<pre class="code-view small">${esc(x.output)}</pre>` : ''}
      </div>`).join('')
    : '<p class="muted">No commands were run.</p>') + '</div>';
}

async function applySession(btn) {
  const A = S.ui.apply;
  try {
    setBusy(btn, true, 'Generating…');
    A.session = await api('/api/apply', { method: 'POST', body: { presetId: A.presetId, mode: 'session' } });
    toast('🎯 Session settings generated');
    await reloadState();
  } catch { /* toast handled */ }
  finally { setBusy(btn, false); renderModePanel(); }
}

async function projectPreview(btn) {
  const A = S.ui.apply;
  const input = $('#projPath');
  const path = (input ? input.value : A.projectPath).trim();
  if (!path) { toast('Enter a project path', 'error'); return; }
  A.projectPath = path;
  try {
    setBusy(btn, true, 'Computing…');
    const d = await api('/api/apply', { method: 'POST', body: { presetId: A.presetId, mode: 'project', projectPath: path, dryRun: true } });
    A.projectPlan = (d && d.plan) || d || { writes: [] };
    A.projectResult = null;
  } catch {
    A.projectPlan = null;
  } finally {
    setBusy(btn, false);
    renderModePanel();
  }
}

async function projectApply(btn) {
  const A = S.ui.apply;
  if (!A.projectPlan) { toast('Run a preview first', 'error'); return; }
  try {
    setBusy(btn, true, 'Applying…');
    A.projectResult = await api('/api/apply', { method: 'POST', body: { presetId: A.presetId, mode: 'project', projectPath: A.projectPath, dryRun: false } });
    toast('📁 Project apply done');
    await reloadState();
  } catch { /* toast handled */ }
  finally { setBusy(btn, false); renderModePanel(); }
}

async function globalPreview(btn) {
  const A = S.ui.apply;
  try {
    setBusy(btn, true, 'Computing…');
    const d = await api('/api/apply', { method: 'POST', body: { presetId: A.presetId, mode: 'global', dryRun: true } });
    A.globalPlan = (d && d.plan) || d || {};
    A.globalResult = null;
  } catch {
    A.globalPlan = null;
  } finally {
    setBusy(btn, false);
    renderModePanel();
  }
}

async function globalApplyFromPanel(btn) {
  const A = S.ui.apply;
  if (!A.globalPlan) { toast('Run a preview first', 'error'); return; }
  const ok = await confirmGlobalPlan(currentApplyPreset(), A.globalPlan);
  if (!ok) return;
  try {
    setBusy(btn, true, 'Applying…');
    const d = await api('/api/apply', { method: 'POST', body: { presetId: A.presetId, mode: 'global', dryRun: false } });
    A.globalResult = d;
    const failed = ((d && d.executed) || []).filter(x => !x.ok).length;
    if (failed) toast(`Global apply done — ${failed} commands failed`, 'error');
    else toast('🌍 Global apply done');
    await Promise.all([reloadState(), reloadStatus()]);
  } catch { /* toast handled */ }
  finally { setBusy(btn, false); renderModePanel(); }
}

/* --- Export --- */
function renderFormatTabs() {
  $('#formatTabs').innerHTML = FORMATS.map(f =>
    `<button class="src-tab sm ${S.ui.apply.fmt === f.id ? 'active' : ''}" data-action="fmt-tab" data-fmt="${f.id}">${esc(f.label)}</button>`
  ).join('');
}

let exportSeq = 0;
async function refreshExport() {
  const A = S.ui.apply;
  const pre = $('#exportCode');
  if (!A.presetId) {
    A.exportText = '';
    pre.textContent = 'Select a preset to see the export content.';
    return;
  }
  const seq = ++exportSeq;
  pre.textContent = 'Loading…';
  try {
    const res = await fetch(`/api/export?presetId=${encodeURIComponent(A.presetId)}&format=${encodeURIComponent(A.fmt)}`);
    const text = await res.text();
    if (seq !== exportSeq) return;
    let errMsg = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      try {
        const j = JSON.parse(text);
        if (j && j.ok === false) errMsg = j.error || 'Export failed';
      } catch { /* if not JSON, use raw text */ }
    }
    if (!res.ok && !errMsg) errMsg = `Export failed (HTTP ${res.status})`;
    if (errMsg) {
      toast(errMsg, 'error');
      A.exportText = '';
      pre.textContent = '⚠ ' + errMsg;
      return;
    }
    A.exportText = text;
    pre.textContent = text || '(empty)';
  } catch {
    if (seq !== exportSeq) return;
    A.exportText = '';
    pre.textContent = 'Cannot connect to the server.';
    toast('Export request failed', 'error');
  }
}

function exportDownload() {
  const A = S.ui.apply;
  if (!A.exportText) { toast('Nothing to download', 'error'); return; }
  const f = FORMATS.find(x => x.id === A.fmt) || FORMATS[0];
  download(f.file(), A.exportText, f.mime);
  toast('⬇ Download started');
}

/* ===== Settings ===== */
function renderSettings() {
  const c = S.config;
  $('#cfgToken').value = (c && c.githubToken) || '';
  $('#tokenState').textContent = c ? (c.githubTokenSet ? `(saved: ${c.githubToken})` : '(not set)') : '';
  $('#cfgAiCmd').value = (c && c.aiCommand) || 'claude';
  $('#cfgAiArgs').value = c && Array.isArray(c.aiArgs) ? c.aiArgs.join(' ') : '-p';
  $('#cfgProjPath').value = (c && c.defaultProjectPath) || '';
}

async function saveConfig(btn) {
  const body = {
    githubToken: $('#cfgToken').value.trim(),
    aiCommand: $('#cfgAiCmd').value.trim() || 'claude',
    aiArgs: $('#cfgAiArgs').value.trim().split(/\s+/).filter(Boolean),
    defaultProjectPath: $('#cfgProjPath').value.trim(),
  };
  try {
    setBusy(btn, true, 'Saving…');
    await api('/api/config', { method: 'POST', body });
    toast('⚙️ Settings saved');
    await reloadConfig();
    renderSettings();
  } catch { /* toast handled */ }
  finally { setBusy(btn, false); }
}

/* ===== Event delegation ===== */
function initEvents() {
  document.addEventListener('click', e => {
    const pick = e.target.closest('[data-picker-value]');
    if (pick) { settlePicker(pick.dataset.pickerValue); return; }

    const seg = e.target.closest('#ghSort [data-sort], #ghRange [data-range]');
    if (seg) {
      const D = S.ui.discover;
      if (seg.dataset.sort) D.sort = seg.dataset.sort;
      if (seg.dataset.range) D.range = seg.dataset.range;
      syncGhSegs();
      runGhQuery($('#ghQuery').value.trim() || (D.gh && D.gh.q) || GH_TRENDING);
      return;
    }

    const el = e.target.closest('[data-action]');
    if (el) {
      const a = el.dataset.action;
      switch (a) {
        case 'refresh-status':
          (async () => {
            setBusy(el, true, 'Checking…');
            await Promise.all([reloadStatus(false), reloadState()]);
            setBusy(el, false);
            renderDashboard();
            toast('Status refreshed');
          })();
          break;
        case 'refresh-sessions': renderSessions(); break;
        case 'quick-session': quickSession(el.dataset.preset, el); break;
        case 'quick-global': globalApplyFlow(el.dataset.preset, el); break;
        case 'open-custom-modal': showModal('customModal'); $('#cmName').focus(); break;
        case 'custom-submit': submitCustom(); break;
        case 'modal-close': hideModal(el.dataset.modal); break;
        case 'toggle-cat': {
          const set = el.dataset.scope === 'builder' ? S.ui.builder.collapsed : S.ui.pantry.collapsed;
          const key = el.dataset.key;
          if (set.has(key)) set.delete(key); else set.add(key);
          const sec = el.closest('.cat-section, .mini-section');
          if (sec) sec.classList.toggle('collapsed');
          break;
        }
        case 'pantry-chip': S.ui.pantry.type = el.dataset.type; renderPantry(); break;
        case 'copy-install': {
          const it = S.itemMap.get(el.dataset.id);
          if (it && it.install) copyText(it.install, 'Install command copied 📋');
          break;
        }
        case 'copy-text': copyText(el.dataset.copy || ''); break;
        case 'add-to-preset': onAddToPreset(el, el.dataset.id); break;
        case 'del-custom': deleteCustom(el.dataset.id); break;
        case 'new-preset': showModal('presetModal'); $('#npName').focus(); break;
        case 'preset-submit': submitPreset(); break;
        case 'import-preset': $('#importFile').click(); break;
        case 'col-menu': colMenu(el, el.dataset.preset); break;
        case 'col-remove': colRemove(el.dataset.preset, el.dataset.id); break;
        case 'src-tab': S.ui.discover.src = el.dataset.src; renderDiscover(); break;
        case 'gh-search': ghSearch(); break;
        case 'smp-search': smpSearch(); break;
        case 'fallback-gh': switchToGithubSearch(el.dataset.q || ''); break;
        case 'keyword': switchToGithubSearch(el.dataset.q || ''); break;
        case 'ai-recommend': aiRecommend(); break;
        case 'ext-fridge': extAddFridge(el, el.dataset.src, +el.dataset.idx); break;
        case 'ext-preset': extAddPreset(el, el.dataset.src, +el.dataset.idx); break;
        case 'mode-card': S.ui.apply.mode = el.dataset.mode; renderModeCards(); renderModePanel(); break;
        case 'apply-session': applySession(el); break;
        case 'project-preview': projectPreview(el); break;
        case 'project-apply': projectApply(el); break;
        case 'global-preview': globalPreview(el); break;
        case 'global-apply': globalApplyFromPanel(el); break;
        case 'fmt-tab': S.ui.apply.fmt = el.dataset.fmt; renderFormatTabs(); refreshExport(); break;
        case 'export-copy':
          if (S.ui.apply.exportText) copyText(S.ui.apply.exportText);
          else toast('Nothing to copy', 'error');
          break;
        case 'export-download': exportDownload(); break;
        case 'save-config': saveConfig(el); break;
        case 'sheet-cancel': settlePicker(null); break;
      }
      return;
    }

    // Touch devices: tap builder mini card → bottom sheet
    const mini = e.target.closest('.mini-item');
    if (mini && isTouchLike()) onAddToPreset(mini, mini.dataset.id);
  });

  // Close popover when clicking outside
  document.addEventListener('pointerdown', e => {
    if (activePopover && !activePopover.contains(e.target)) settlePicker(null);
  });

  // ESC
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    settlePicker(null);
    if ($('#confirmModal').classList.contains('show')) settleConfirm(false);
    $$('.modal-overlay.show').forEach(m => { if (m.id !== 'confirmModal') m.classList.remove('show'); });
  });

  // Close modal on overlay click
  $$('.modal-overlay').forEach(m => m.addEventListener('click', e => {
    if (e.target !== m) return;
    if (m.id === 'confirmModal') settleConfirm(false);
    else m.classList.remove('show');
  }));
  $('#confirmOk').addEventListener('click', () => settleConfirm(true));
  $('#confirmCancel').addEventListener('click', () => settleConfirm(false));

  // Search/input
  $('#pantrySearch').addEventListener('input', e => { S.ui.pantry.q = e.target.value; renderPantryList(); });
  $('#builderSearch').addEventListener('input', e => { S.ui.builder.q = e.target.value; renderBuilderPantry(); });
  $('#ghQuery').addEventListener('keydown', e => { if (e.key === 'Enter') ghSearch(); });
  $('#smpQuery').addEventListener('keydown', e => { if (e.key === 'Enter') smpSearch(); });

  // Builder column name/emoji inline edit → auto-save
  $('#builderCols').addEventListener('input', e => {
    const inp = e.target.closest('input[data-preset]');
    if (!inp) return;
    const p = S.presets.find(x => x.id === inp.dataset.preset);
    if (!p) return;
    p[inp.dataset.field] = inp.value;
    schedulePresetSave(p.id);
  });

  // Apply tab: invalidate preview when project path changes
  $('#modePanel').addEventListener('input', e => {
    if (e.target.id !== 'projPath') return;
    S.ui.apply.projectPath = e.target.value;
    S.ui.apply.projectPlan = null;
    S.ui.apply.projectResult = null;
    const btn = $('#modePanel [data-action="project-apply"]');
    if (btn) btn.disabled = true;
  });

  // Preset selection change
  $('#applyPreset').addEventListener('change', e => {
    const A = S.ui.apply;
    A.presetId = e.target.value;
    A.session = null;
    A.projectPlan = null;
    A.projectResult = null;
    A.globalPlan = null;
    A.globalResult = null;
    renderApplySummary();
    renderModePanel();
    refreshExport();
  });

  // Import JSON
  $('#importFile').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importPresetFile(f);
  });

  window.addEventListener('hashchange', route);
  initDnd();
}

/* ===== Initialization ===== */
async function init() {
  initEvents();
  const [cat, pre, stat, st, cfg] = await Promise.allSettled([
    api('/api/catalog', { silent: true }),
    api('/api/presets', { silent: true }),
    api('/api/status', { silent: true }),
    api('/api/state', { silent: true }),
    api('/api/config', { silent: true }),
  ]);
  if (cat.status === 'fulfilled') {
    S.catalog = cat.value.items || [];
    S.itemMap = new Map(S.catalog.map(i => [i.id, i]));
  }
  if (pre.status === 'fulfilled') S.presets = pre.value.presets || [];
  if (stat.status === 'fulfilled') S.status = stat.value;
  if (st.status === 'fulfilled') S.state = st.value;
  if (cfg.status === 'fulfilled') S.config = cfg.value;

  const online = cat.status === 'fulfilled' && pre.status === 'fulfilled';
  $('#serverDot').classList.toggle('ok', online);
  $('#serverDot').classList.toggle('bad', !online);
  $('#serverText').textContent = online ? 'Online' : 'Connection failed';
  if (!online) toast('Failed to load server data. Check that the server is running.', 'error');

  if (!location.hash) history.replaceState(null, '', '#dashboard');
  route();
}

init();
