#!/usr/bin/env node
// AI Refrigerator — local server (zero dependencies, Node >= 18)
import http from 'node:http';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PRESETS_DIR = path.join(__dirname, 'presets');
const CATALOG_PATH = path.join(DATA_DIR, 'catalog.json');
const CUSTOM_PATH = path.join(DATA_DIR, 'custom-items.json');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const SESSION_DIR = path.join(os.homedir(), '.ai-refrigerator', 'session-presets');

const MAX_BODY = 2 * 1024 * 1024;
const ID_RE = /^[a-z0-9-]{1,64}$/;
const ITEM_TYPES = ['skill', 'plugin', 'mcp', 'agent', 'md', 'tool', 'cli'];
const DEFAULT_CONFIG = { githubToken: '', aiCommand: 'claude', aiArgs: ['-p'], defaultProjectPath: '' };
const DEFAULT_STATE = { lastApplied: null, history: [] };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ── CLI arguments ─────────────────────────────────────────
const argv = process.argv.slice(2);
let PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 4924;
const portIdx = argv.indexOf('--port');
if (portIdx !== -1 && Number(argv[portIdx + 1]) > 0) PORT = Number(argv[portIdx + 1]);
const NO_OPEN = argv.includes('--no-open');

// ── Common helpers ────────────────────────────────────────
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}
function fail(res, status, error) {
  sendJson(res, status, { ok: false, error });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const e = new Error('Request body is too large (max 2MB)');
      e.status = 413;
      req.destroy();
      throw e;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const e = new Error('Invalid JSON body');
    e.status = 400;
    throw e;
  }
}

async function readJsonOrNull(p) {
  try {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
  } catch {
    return null;
  }
}
async function readFileOrNull(p) {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}
async function writeJsonFile(p, obj) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(obj, null, 2) + '\n');
}
async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig() {
  const raw = await readJsonOrNull(CONFIG_PATH);
  const cfg = { ...DEFAULT_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (typeof cfg.githubToken !== 'string') cfg.githubToken = '';
  if (typeof cfg.aiCommand !== 'string' || !cfg.aiCommand.trim()) cfg.aiCommand = 'claude';
  if (!Array.isArray(cfg.aiArgs)) cfg.aiArgs = ['-p'];
  if (typeof cfg.defaultProjectPath !== 'string') cfg.defaultProjectPath = '';
  return cfg;
}
function maskConfig(cfg) {
  return {
    githubToken: cfg.githubToken ? '****' + cfg.githubToken.slice(-4) : '',
    githubTokenSet: Boolean(cfg.githubToken),
    aiCommand: cfg.aiCommand,
    aiArgs: cfg.aiArgs,
    defaultProjectPath: cfg.defaultProjectPath,
  };
}

async function loadMergedCatalog() {
  const builtinRaw = await readJsonOrNull(CATALOG_PATH);
  const customRaw = await readJsonOrNull(CUSTOM_PATH);
  const builtin = (Array.isArray(builtinRaw) ? builtinRaw : Array.isArray(builtinRaw?.items) ? builtinRaw.items : [])
    .filter((it) => it && typeof it === 'object' && it.id)
    .map((it) => ({ ...it, source: it.source || 'builtin' }));
  const custom = (Array.isArray(customRaw) ? customRaw : [])
    .filter((it) => it && typeof it === 'object' && it.id)
    .map((it) => ({ ...it, source: 'custom' }));
  return [...builtin, ...custom];
}

async function loadPreset(id) {
  if (!ID_RE.test(id)) return null;
  const p = await readJsonOrNull(path.join(PRESETS_DIR, id + '.json'));
  if (!p || typeof p !== 'object') return null;
  return { ...p, id, items: Array.isArray(p.items) ? p.items : [] };
}

async function recordApply(presetId, mode, target) {
  const raw = await readJsonOrNull(STATE_PATH);
  const state = raw && typeof raw === 'object' ? raw : { ...DEFAULT_STATE };
  const entry = { presetId, mode, target: target ?? null, at: new Date().toISOString() };
  state.lastApplied = entry;
  state.history = [entry, ...(Array.isArray(state.history) ? state.history : [])].slice(0, 20);
  await writeJsonFile(STATE_PATH, state);
}

function kebab(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function fmtStars(n) {
  const num = Number(n) || 0;
  if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(num);
}

function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}

function run(cmd, args, { timeout = 30000, maxBuffer = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: stdout || '',
          stderr: stderr || '',
          enoent: Boolean(error && error.code === 'ENOENT'),
          timedOut: Boolean(error && (error.killed || error.signal === 'SIGTERM')),
          error,
        });
      });
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: String(error.message || error), enoent: error.code === 'ENOENT', timedOut: false, error });
    }
  });
}

async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  return await fetch(url, { ...opts, signal: AbortSignal.timeout(ms), redirect: 'follow' });
}

function firstJsonBlock(s) {
  const text = String(s);
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function shq(s) {
  const str = String(s);
  return /^[A-Za-z0-9@%_+=:,./-]+$/.test(str) ? str : `'${str.replace(/'/g, `'\\''`)}'`;
}

function parsePluginList(out) {
  const plugins = [];
  let cur = null;
  for (const raw of stripAnsi(out).split('\n')) {
    const line = raw.trim();
    const head = line.match(/^(?:❯\s*)?([A-Za-z0-9._-]+)@([A-Za-z0-9._/-]+)$/);
    if (head) {
      cur = { name: head[1], marketplace: head[2], version: null, scope: null, enabled: false };
      plugins.push(cur);
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = line.match(/^Version:\s*(.+)$/i))) cur.version = m[1].trim();
    else if ((m = line.match(/^Scope:\s*(.+)$/i))) cur.scope = m[1].trim();
    else if ((m = line.match(/^Status:\s*(.+)$/i))) cur.enabled = /enabled/i.test(m[1]) && !/disabled/i.test(m[1]);
  }
  return plugins;
}

// ── Preset item classification ────────────────────────────
function classify(preset, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const resolved = [];
  const missing = [];
  for (const id of preset.items || []) {
    const it = byId.get(id);
    if (it) resolved.push(it);
    else missing.push(id);
  }
  const pluginItems = [];
  const mcpItems = [];
  const mdItems = [];
  const installItems = [];
  for (const it of resolved) {
    if (it.type === 'plugin' && it.plugin) pluginItems.push(it);
    else if (it.mcpConfig && typeof it.mcpConfig === 'object' && it.mcpConfig.command) mcpItems.push(it);
    else if (it.type === 'md') mdItems.push(it);
    else if (it.install) installItems.push(it);
  }
  return { resolved, missing, pluginItems, mcpItems, mdItems, installItems };
}

// ── export format builders ────────────────────────────────
// Collapse to a single line so untrusted names can't break out of an echo/comment
function oneLine(s) {
  return String(s).replace(/[\r\n]+/g, ' ').trim();
}
function buildInstallSh(preset, cls) {
  const lines = ['#!/bin/bash', 'set -e', '', `echo ${shq('🧊 AI Refrigerator — installing ' + oneLine(preset.name || preset.id))}`, ''];
  for (const it of cls.resolved) {
    const nameEcho = `echo ${shq('▶ ' + oneLine(it.name))}`;
    if (it.type === 'plugin' && it.plugin) {
      lines.push(nameEcho);
      if (it.marketplace) lines.push(`claude plugin marketplace add ${shq(it.marketplace)}`);
      lines.push(`claude plugin install ${shq(it.plugin)}`, '');
    } else if (it.mcpConfig && typeof it.mcpConfig === 'object' && it.mcpConfig.command) {
      const args = [it.mcpConfig.command, ...(Array.isArray(it.mcpConfig.args) ? it.mcpConfig.args : [])];
      lines.push(nameEcho, `claude mcp add ${shq(it.id)} -- ${args.map(shq).join(' ')}`, '');
    } else if (it.install) {
      // it.install is a literal command from the trusted builtin catalog or a
      // command the local user typed for their own custom item — runs as-is by design.
      lines.push(nameEcho, oneLine(it.install), '');
    } else {
      lines.push(`# ${oneLine(it.name)}: manual install — ${oneLine(it.url || 'no URL')}`, '');
    }
  }
  for (const id of cls.missing) lines.push(`# ${oneLine(id)}: item not in catalog (skipped)`, '');
  lines.push('echo "✅ Installation complete"');
  return lines.join('\n') + '\n';
}

function buildSettingsJson(cls) {
  return JSON.stringify({ enabledPlugins: Object.fromEntries(cls.pluginItems.map((i) => [i.plugin, true])) }, null, 2) + '\n';
}

function buildMcpJson(cls) {
  return JSON.stringify({ mcpServers: Object.fromEntries(cls.mcpItems.map((i) => [i.id, i.mcpConfig])) }, null, 2) + '\n';
}

function buildClaudeMdExport(preset, cls) {
  const L = [];
  L.push(`# ${preset.emoji || '🧊'} ${preset.name || preset.id} — CLAUDE.md starter`, '');
  L.push(`> A reference starter generated from the AI Refrigerator preset \`${preset.id}\`. Adapt it to your project.`);
  if (preset.description) L.push(`> ${preset.description}`);
  L.push('', '## CLAUDE.md template references', '');
  if (cls.mdItems.length) {
    for (const it of cls.mdItems) L.push(`- [${it.name}](${it.url || it.mdUrl || '#'}) — ${it.desc || ''}`);
  } else {
    L.push('- (This preset has no CLAUDE.md type items)');
  }
  L.push('', '## Preset items', '', '| Item | Type | Description | Link |', '|---|---|---|---|');
  for (const it of cls.resolved) {
    L.push(`| ${it.name} | ${it.type} | ${String(it.desc || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${it.url || ''} |`);
  }
  for (const id of cls.missing) L.push(`| ${id} | ? | not in catalog (missing) | |`);
  L.push('');
  return L.join('\n');
}

async function buildClaudeMdContent(preset, mdItems) {
  const parts = [
    `# CLAUDE.md — ${preset.name || preset.id}`,
    '',
    `<!-- File generated from the AI Refrigerator preset "${preset.id}". Adapt it to your project. -->`,
    '',
  ];
  for (const it of mdItems) {
    parts.push(`<!-- ─── ${it.name} · ${it.url || ''} ─── -->`, '');
    if (it.mdUrl) {
      try {
        const r = await fetchWithTimeout(it.mdUrl, { headers: { 'User-Agent': 'ai-refrigerator' } }, 8000);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        parts.push((await r.text()).trim(), '');
      } catch {
        parts.push(`<!-- ${it.name}: failed to fetch content — see ${it.mdUrl} -->`, '');
      }
    } else {
      parts.push(`<!-- ${it.name}: no source URL — see ${it.url || 'no link'} -->`, '');
    }
  }
  return parts.join('\n');
}

// ── apply: project mode ───────────────────────────────────
async function applyProject(preset, cls, projectPath, dryRun) {
  const settingsPath = path.join(projectPath, '.claude', 'settings.json');
  const mcpPath = path.join(projectPath, '.mcp.json');
  const claudeMdPath = path.join(projectPath, 'CLAUDE.md');
  const refrigeratorMdPath = path.join(projectPath, 'CLAUDE.refrigerator.md');
  const installShPath = path.join(projectPath, 'ai-refrigerator-install.sh');
  const installScript = buildInstallSh(preset, cls);

  const writes = [];
  const out = { written: [], skipped: [], backups: [], installScriptPath: installShPath };
  const backup = async (p, raw) => {
    const b = `${p}.bak-${Date.now()}`;
    if (raw !== null && raw !== undefined) await fsp.writeFile(b, raw);
    else await fsp.copyFile(p, b);
    out.backups.push(b);
  };

  if (cls.pluginItems.length) {
    const raw = await readFileOrNull(settingsPath);
    let parsed = {};
    let broken = false;
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) broken = true;
      } catch {
        broken = true;
      }
    }
    if (broken) {
      writes.push({ path: settingsPath, action: 'skip', note: 'Failed to parse existing settings.json — manual merge required' });
      if (!dryRun) out.skipped.push(`${settingsPath} (parse failed — manual merge required)`);
    } else {
      writes.push({
        path: settingsPath,
        action: raw === null ? 'create' : 'merge',
        note: `Enable ${cls.pluginItems.length} plugin(s) in enabledPlugins (existing keys preserved)`,
      });
      if (!dryRun) {
        await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
        if (raw !== null) await backup(settingsPath, raw);
        const merged = {
          ...parsed,
          enabledPlugins: {
            ...(parsed.enabledPlugins && typeof parsed.enabledPlugins === 'object' ? parsed.enabledPlugins : {}),
            ...Object.fromEntries(cls.pluginItems.map((i) => [i.plugin, true])),
          },
        };
        await fsp.writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n');
        out.written.push(settingsPath);
      }
    }
  }

  if (cls.mcpItems.length) {
    const raw = await readFileOrNull(mcpPath);
    let parsed = {};
    let broken = false;
    if (raw !== null) {
      try {
        parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) broken = true;
      } catch {
        broken = true;
      }
    }
    if (broken) {
      writes.push({ path: mcpPath, action: 'skip', note: 'Failed to parse existing .mcp.json — manual merge required' });
      if (!dryRun) out.skipped.push(`${mcpPath} (parse failed — manual merge required)`);
    } else {
      const servers = parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
      const added = cls.mcpItems.filter((i) => !(i.id in servers));
      const kept = cls.mcpItems.filter((i) => i.id in servers);
      const action = raw === null ? 'create' : added.length ? 'merge' : 'skip';
      const note = `Add ${added.length} MCP server(s)${kept.length ? `, kept existing: ${kept.map((i) => i.id).join(', ')}` : ''}`;
      writes.push({ path: mcpPath, action, note });
      if (!dryRun) {
        for (const i of kept) out.skipped.push(`.mcp.json: ${i.id} (already exists — kept)`);
        if (added.length) {
          if (raw !== null) await backup(mcpPath, raw);
          const merged = { ...parsed, mcpServers: { ...servers, ...Object.fromEntries(added.map((i) => [i.id, i.mcpConfig])) } };
          await fsp.writeFile(mcpPath, JSON.stringify(merged, null, 2) + '\n');
          out.written.push(mcpPath);
        } else if (raw !== null) {
          out.skipped.push(`${mcpPath} (no changes)`);
        }
      }
    }
  }

  if (cls.mdItems.length) {
    const claudeMdExists = await exists(claudeMdPath);
    const target = claudeMdExists ? refrigeratorMdPath : claudeMdPath;
    writes.push({
      path: target,
      action: 'create',
      note: claudeMdExists
        ? 'CLAUDE.md already exists — leaving it untouched and creating a separate file'
        : `Combine content of ${cls.mdItems.length} md item(s) (fetch source, 8s timeout)`,
    });
    if (!dryRun) {
      const content = await buildClaudeMdContent(preset, cls.mdItems);
      if (await exists(target)) await backup(target);
      await fsp.writeFile(target, content);
      out.written.push(target);
    }
  }

  writes.push({ path: installShPath, action: 'create', note: 'Generate install script (not run automatically)' });
  if (!dryRun) {
    if (await exists(installShPath)) await backup(installShPath);
    await fsp.writeFile(installShPath, installScript);
    await fsp.chmod(installShPath, 0o755);
    out.written.push(installShPath);
  }

  if (dryRun) return { plan: { writes, installScript } };
  await recordApply(preset.id, 'project', projectPath);
  return out;
}

// ── API handlers ──────────────────────────────────────────
async function handleCatalogGet(res) {
  ok(res, { items: await loadMergedCatalog() });
}

async function handleCatalogAdd(req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'An item object is required');
  const name = String(body.name || '').trim();
  if (!name) return fail(res, 400, 'A name is required');
  const id = kebab(String(body.id || '').trim() || name);
  if (!id || !ID_RE.test(id)) return fail(res, 400, 'id must be 1-64 lowercase letters, digits, or hyphens');
  const type = body.type ? String(body.type) : 'tool';
  if (!ITEM_TYPES.includes(type)) return fail(res, 400, `type must be one of ${ITEM_TYPES.join('|')}`);
  const all = await loadMergedCatalog();
  if (all.some((i) => i.id === id)) return fail(res, 400, `id already exists: ${id}`);
  let tags = [];
  if (Array.isArray(body.tags)) tags = body.tags.map((t) => String(t).trim()).filter(Boolean);
  else if (typeof body.tags === 'string') tags = body.tags.split(',').map((t) => t.trim()).filter(Boolean);
  const item = {
    id,
    name,
    type,
    stars: body.stars === null || body.stars === undefined || body.stars === '' ? null : String(body.stars),
    desc: String(body.desc || ''),
    url: String(body.url || ''),
    install: body.install ? String(body.install) : null,
    plugin: body.plugin ? String(body.plugin) : null,
    marketplace: body.marketplace ? String(body.marketplace) : null,
    mcpConfig: body.mcpConfig && typeof body.mcpConfig === 'object' && !Array.isArray(body.mcpConfig) ? body.mcpConfig : null,
    mdUrl: body.mdUrl ? String(body.mdUrl) : null,
    tags,
    source: 'custom',
    addedAt: new Date().toISOString(),
  };
  const customRaw = await readJsonOrNull(CUSTOM_PATH);
  const custom = Array.isArray(customRaw) ? customRaw : [];
  custom.push(item);
  await writeJsonFile(CUSTOM_PATH, custom);
  ok(res, { item });
}

async function handleCatalogDelete(res, id) {
  const builtinRaw = await readJsonOrNull(CATALOG_PATH);
  const builtin = Array.isArray(builtinRaw) ? builtinRaw : Array.isArray(builtinRaw?.items) ? builtinRaw.items : [];
  if (builtin.some((i) => i && i.id === id)) return fail(res, 400, 'Builtin items cannot be deleted');
  const customRaw = await readJsonOrNull(CUSTOM_PATH);
  const custom = Array.isArray(customRaw) ? customRaw : [];
  const next = custom.filter((i) => i && i.id !== id);
  if (next.length === custom.length) return fail(res, 404, `Custom item not found: ${id}`);
  await writeJsonFile(CUSTOM_PATH, next);
  ok(res, { deleted: id });
}

async function handlePresetsGet(res) {
  let files = [];
  try {
    files = (await fsp.readdir(PRESETS_DIR)).filter((f) => f.endsWith('.json'));
  } catch {
    files = [];
  }
  const presets = [];
  for (const f of files) {
    const p = await readJsonOrNull(path.join(PRESETS_DIR, f));
    if (p && typeof p === 'object' && p.id) presets.push({ ...p, items: Array.isArray(p.items) ? p.items : [] });
  }
  presets.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ko'));
  ok(res, { presets });
}

async function handlePresetPut(req, res, id) {
  if (!ID_RE.test(id)) return fail(res, 400, 'Preset id must be 1-64 lowercase letters, digits, or hyphens');
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'A preset object is required');
  const existing = await loadPreset(id);
  const now = new Date().toISOString();
  const preset = {
    id,
    name: String(body.name || id),
    emoji: String(body.emoji || '📦'),
    description: String(body.description || ''),
    items: Array.isArray(body.items) ? body.items.filter((x) => typeof x === 'string') : [],
    createdAt: (existing && existing.createdAt) || (typeof body.createdAt === 'string' && body.createdAt) || now,
    updatedAt: now,
  };
  await writeJsonFile(path.join(PRESETS_DIR, id + '.json'), preset);
  ok(res, { preset });
}

async function handlePresetDelete(res, id) {
  if (!ID_RE.test(id)) return fail(res, 400, 'Invalid preset id');
  try {
    await fsp.unlink(path.join(PRESETS_DIR, id + '.json'));
  } catch {
    return fail(res, 404, `Preset not found: ${id}`);
  }
  ok(res, { deleted: id });
}

async function handleStatus(res) {
  const home = os.homedir();
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const [ver, list, skillsDirs, settings] = await Promise.all([
    run('claude', ['--version'], { timeout: 10000 }),
    run('claude', ['plugin', 'list'], { timeout: 15000 }),
    (async () => {
      try {
        const entries = await fsp.readdir(path.join(home, '.claude', 'skills'), { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
      } catch {
        return [];
      }
    })(),
    readJsonOrNull(settingsPath),
  ]);
  ok(res, {
    claude: {
      available: ver.ok || list.ok,
      version: ver.ok ? stripAnsi(ver.stdout).trim().split('\n')[0] || null : null,
    },
    plugins: list.ok ? parsePluginList(list.stdout) : [],
    skillsDirs,
    enabledPluginsGlobal:
      settings && settings.enabledPlugins && typeof settings.enabledPlugins === 'object' ? settings.enabledPlugins : {},
    settingsPath,
  });
}

async function handleGithubSearch(res, q, sort, range) {
  if (!q) return fail(res, 400, 'A search query (q) is required');
  const cfg = await loadConfig();
  const sortKey = ['stars', 'forks', 'updated'].includes(sort) ? sort : 'stars';
  const days = { day: 1, week: 7, month: 30 }[range];
  let query = q;
  if (days) {
    const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    query += ` created:>=${since}`;
  }
  const gh = new URL('https://api.github.com/search/repositories');
  gh.searchParams.set('q', query);
  gh.searchParams.set('sort', sortKey);
  gh.searchParams.set('order', 'desc');
  gh.searchParams.set('per_page', '24');
  const headers = { 'User-Agent': 'ai-refrigerator', Accept: 'application/vnd.github+json' };
  if (cfg.githubToken) headers.Authorization = `Bearer ${cfg.githubToken}`;
  let r;
  try {
    r = await fetchWithTimeout(gh, { headers }, 10000);
  } catch {
    return fail(res, 502, 'Failed to connect to GitHub — check your network');
  }
  if (r.status === 403 || r.status === 429) return fail(res, 429, 'GitHub rate limit — add a token in Settings');
  if (!r.ok) return fail(res, 502, `GitHub API error (HTTP ${r.status})`);
  let j;
  try {
    j = await r.json();
  } catch {
    return fail(res, 502, 'Failed to parse GitHub response');
  }
  const results = (Array.isArray(j.items) ? j.items : []).map((repo) => {
    const hay = `${repo.full_name || ''} ${repo.description || ''} ${(repo.topics || []).join(' ')}`.toLowerCase();
    let type = 'tool';
    if (hay.includes('mcp')) type = 'mcp';
    else if (hay.includes('skill')) type = 'skill';
    else if (hay.includes('agent')) type = 'agent';
    else if (hay.includes('claude.md') || hay.includes('claude-md')) type = 'md';
    return {
      id: 'gh-' + kebab(repo.full_name || ''),
      name: repo.full_name || '',
      type,
      stars: fmtStars(repo.stargazers_count),
      forks: fmtStars(repo.forks_count),
      desc: repo.description || '',
      url: repo.html_url || '',
      install: null,
      tags: Array.isArray(repo.topics) ? repo.topics.slice(0, 5) : [],
    };
  });
  ok(res, { results, sort: sortKey, range: range || 'all' });
}

async function handleSkillsmpSearch(res, q) {
  if (!q) return fail(res, 400, 'A search query (q) is required');
  const urls = [
    `https://skillsmp.com/api/search?q=${encodeURIComponent(q)}`,
    `https://skillsmp.com/api/skills?q=${encodeURIComponent(q)}`,
  ];
  for (const u of urls) {
    try {
      const r = await fetchWithTimeout(u, { headers: { 'User-Agent': 'ai-refrigerator', Accept: 'application/json' } }, 8000);
      if (!r.ok) continue;
      const j = await r.json();
      const arr = Array.isArray(j) ? j : [j?.data, j?.skills, j?.results].find((x) => Array.isArray(x));
      if (!arr) continue;
      const results = arr
        .filter((e) => e && typeof e === 'object')
        .slice(0, 20)
        .map((e) => ({
          name: String(e.name || e.title || ''),
          desc: String(e.description || e.desc || e.summary || ''),
          url: String(e.url || e.link || e.href || (e.slug ? `https://skillsmp.com/skills/${e.slug}` : '')),
          author: e.author || e.owner || e.creator || null,
        }));
      return ok(res, { results, source: 'skillsmp' });
    } catch {
      // try the next candidate URL
    }
  }
  ok(res, { results: [], source: 'fallback', fallbackUrl: `https://skillsmp.com/?q=${encodeURIComponent(q)}` });
}

// Known AI coding CLIs and their non-interactive invocation (prompt appended as last arg)
const AI_CLIS = [
  { id: 'claude', name: 'Claude Code', cmd: 'claude', args: ['-p'] },
  { id: 'codex', name: 'Codex CLI', cmd: 'codex', args: ['exec'] },
  { id: 'gemini', name: 'Gemini CLI', cmd: 'gemini', args: ['-p'] },
  { id: 'cursor', name: 'Cursor Agent', cmd: 'cursor-agent', args: ['-p'] },
  { id: 'grok', name: 'Grok CLI', cmd: 'grok', args: ['-p'] },
  { id: 'opencode', name: 'OpenCode', cmd: 'opencode', args: ['run'] },
  { id: 'qwen', name: 'Qwen Code', cmd: 'qwen', args: ['-p'] },
];

async function detectAiClis() {
  return Promise.all(
    AI_CLIS.map(async (c) => {
      const w = await run('which', [c.cmd], { timeout: 5000 });
      return { id: c.id, name: c.name, cmd: c.cmd, available: w.ok && w.stdout.trim().length > 0 };
    }),
  );
}

async function handleAiClis(res) {
  const cfg = await loadConfig();
  ok(res, { clis: await detectAiClis(), current: cfg.aiCommand });
}

async function handleRecommend(req, res) {
  const body = await readJsonBody(req);
  const goal = String(body.goal || '').trim();
  if (!goal) return fail(res, 400, 'Please enter a goal');
  const cfg = await loadConfig();
  const items = await loadMergedCatalog();
  const catalogLines = items
    .map((i) => `${i.id}|${i.type || ''}|${i.name || ''}|${String(i.desc || '').replace(/\s*\n\s*/g, ' ')}`)
    .join('\n');
  const prompt = `You are an expert at setting up AI coding agents. Recommend a combination of tools that fits the user's goal.
[Catalog] (id|type|name|description)
${catalogLines}
[User goal]
${goal}
Output only the JSON below. No other text:
{"recommendations":[{"id":"catalog id","reason":"one-line reason"}],"extra":[{"name":"recommendation outside the catalog","type":"skill|mcp|tool","url":"https://...","install":"install command or null","reason":"reason"}],"keywords":["1-3 recommended GitHub search keywords"]}
recommendations should be 3-8 items, using only ids that actually exist in the catalog.`;
  // Resolve which AI CLI to use: explicit provider → configured command → first installed
  const detected = await detectAiClis();
  const availById = new Map(detected.filter((c) => c.available).map((c) => [c.id, c]));
  let aiCmd, aiArgs, usedName;
  const reg = AI_CLIS.find((c) => c.id === String(body.provider || '').trim());
  if (reg && availById.has(reg.id)) {
    aiCmd = reg.cmd;
    aiArgs = reg.args.slice();
    usedName = reg.name;
  }
  if (!aiCmd) {
    const cfgCmd = cfg.aiCommand || 'claude';
    if ((await run('which', [cfgCmd], { timeout: 5000 })).ok) {
      aiCmd = cfgCmd;
      aiArgs = Array.isArray(cfg.aiArgs) ? cfg.aiArgs.map(String) : ['-p'];
      usedName = (AI_CLIS.find((c) => c.cmd === cfgCmd) || {}).name || cfgCmd;
    }
  }
  if (!aiCmd) {
    const first = detected.find((c) => c.available);
    if (first) {
      const rg = AI_CLIS.find((c) => c.id === first.id);
      aiCmd = rg.cmd;
      aiArgs = rg.args.slice();
      usedName = rg.name;
    }
  }
  if (!aiCmd) {
    return fail(res, 503, 'No supported AI CLI found (claude, codex, gemini, cursor-agent, grok, opencode, qwen). Install one or set the command in Settings.');
  }
  const r = await run(aiCmd, [...aiArgs, prompt], { timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
  if (r.enoent) return fail(res, 503, `AI CLI (${aiCmd}) not found. Check the command in Settings.`);
  if (r.timedOut) return fail(res, 504, 'The AI response timed out (3 minutes). Please try again shortly.');
  const stdout = r.stdout || '';
  const parsed = firstJsonBlock(stdout);
  if (!parsed) {
    if (!r.ok) return fail(res, 502, `AI execution failed: ${(r.stderr || stdout || 'Unknown error').trim().slice(0, 200)}`);
    return fail(res, 502, `Failed to parse AI response: ${stdout.trim().slice(0, 200)}`);
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const recommendations = (Array.isArray(parsed.recommendations) ? parsed.recommendations : [])
    .filter((rec) => rec && typeof rec === 'object' && byId.has(rec.id))
    .map((rec) => ({ id: rec.id, reason: String(rec.reason || ''), item: byId.get(rec.id) }));
  ok(res, {
    recommendations,
    extra: Array.isArray(parsed.extra) ? parsed.extra.filter((e) => e && typeof e === 'object') : [],
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
    usedCli: { cmd: aiCmd, name: usedName },
  });
}

async function handleApply(req, res) {
  const body = await readJsonBody(req);
  const presetId = String(body.presetId || '');
  const mode = String(body.mode || '');
  if (!ID_RE.test(presetId)) return fail(res, 400, 'Invalid presetId');
  const preset = await loadPreset(presetId);
  if (!preset) return fail(res, 404, `Preset not found: ${presetId}`);
  if (!['session', 'project', 'global'].includes(mode)) return fail(res, 400, 'mode must be one of session|project|global');
  const dryRun = body.dryRun === true;
  const items = await loadMergedCatalog();
  const cls = classify(preset, items);

  if (mode === 'session') {
    await fsp.mkdir(SESSION_DIR, { recursive: true });
    const settingsPath = path.join(SESSION_DIR, `${preset.id}.settings.json`);
    await writeJsonFile(settingsPath, { enabledPlugins: Object.fromEntries(cls.pluginItems.map((i) => [i.plugin, true])) });
    // Session scope enables plugins AND MCP servers: plugins via --settings,
    // MCP servers via --mcp-config (both are per-session, nothing permanent).
    let command = `claude --settings ${settingsPath}`;
    let mcpPath = null;
    if (cls.mcpItems.length) {
      mcpPath = path.join(SESSION_DIR, `${preset.id}.mcp.json`);
      await writeJsonFile(mcpPath, { mcpServers: Object.fromEntries(cls.mcpItems.map((i) => [i.id, i.mcpConfig])) });
      command += ` --mcp-config ${mcpPath}`;
    }
    await recordApply(preset.id, 'session', settingsPath);
    // Skills / tools / agents / md can't be "enabled" per-session — they must be
    // installed. Surface them so the UI can point the user to the install script.
    const needInstall = cls.resolved.filter(
      (it) => !(it.type === 'plugin' && it.plugin) && !(it.mcpConfig && typeof it.mcpConfig === 'object' && it.mcpConfig.command),
    );
    return ok(res, {
      settingsPath,
      mcpPath,
      command,
      aliasLine: `alias cc-${preset.id}='${command}'`,
      pluginCount: cls.pluginItems.length,
      mcpCount: cls.mcpItems.length,
      needInstall: needInstall.map((i) => ({ id: i.id, name: i.name, type: i.type, install: i.install || null })),
    });
  }

  if (mode === 'project') {
    let projectPath = String(body.projectPath || '').trim();
    if (!projectPath) return fail(res, 400, 'projectPath is required');
    if (projectPath === '~' || projectPath.startsWith('~/')) projectPath = path.join(os.homedir(), projectPath.slice(1));
    projectPath = path.resolve(projectPath);
    // Resolve symbolic links to the real path to prevent path spoofing (symlink)
    try {
      projectPath = await fsp.realpath(projectPath);
    } catch {
      return fail(res, 400, `Not an existing directory: ${projectPath}`);
    }
    let st = null;
    try {
      st = await fsp.stat(projectPath);
    } catch {
      st = null;
    }
    if (!st || !st.isDirectory()) return fail(res, 400, `Not an existing directory: ${projectPath}`);
    return ok(res, await applyProject(preset, cls, projectPath, dryRun));
  }

  // mode === 'global'
  const list = await run('claude', ['plugin', 'list'], { timeout: 15000 });
  if (list.enoent) return fail(res, 503, 'claude CLI not found. Install claude and try again.');
  const current = list.ok ? parsePluginList(list.stdout) : [];
  const installed = new Set(current.map((p) => `${p.name}@${p.marketplace}`));
  const currentEnabled = current.filter((p) => p.enabled).map((p) => `${p.name}@${p.marketplace}`);
  const presetPlugins = cls.pluginItems.map((i) => i.plugin);
  const presetSet = new Set(presetPlugins);
  const plan = {
    enable: presetPlugins.filter((p) => !currentEnabled.includes(p)),
    disable: currentEnabled.filter((p) => !presetSet.has(p)),
    marketplaceAdd: [...new Set(cls.pluginItems.filter((i) => i.marketplace && !installed.has(i.plugin)).map((i) => i.marketplace))],
  };
  if (dryRun) return ok(res, { plan });
  const executed = [];
  const doRun = async (args) => {
    const r = await run('claude', args, { timeout: 30000 });
    executed.push({
      cmd: ['claude', ...args].join(' '),
      ok: r.ok,
      output: (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim().slice(0, 2000) || (r.ok ? 'Done' : 'Failed'),
    });
  };
  for (const mk of plan.marketplaceAdd) await doRun(['plugin', 'marketplace', 'add', mk]);
  for (const p of plan.enable) await doRun(['plugin', 'enable', '-s', 'user', p]);
  for (const p of plan.disable) await doRun(['plugin', 'disable', '-s', 'user', p]);
  if (executed.every((e) => e.ok)) await recordApply(preset.id, 'global', null);
  ok(res, { plan, executed });
}

async function handleExport(res, presetId, format) {
  if (!ID_RE.test(presetId || '')) return fail(res, 400, 'Invalid presetId');
  const preset = await loadPreset(presetId);
  if (!preset) return fail(res, 404, `Preset not found: ${presetId}`);
  const items = await loadMergedCatalog();
  const cls = classify(preset, items);
  let text;
  switch (format) {
    case 'install.sh':
      text = buildInstallSh(preset, cls);
      break;
    case 'settings.json':
      text = buildSettingsJson(cls);
      break;
    case 'mcp.json':
      text = buildMcpJson(cls);
      break;
    case 'claude.md':
      text = buildClaudeMdExport(preset, cls);
      break;
    case 'preset.json':
      text = JSON.stringify(preset, null, 2) + '\n';
      break;
    default:
      return fail(res, 400, 'format must be one of install.sh|settings.json|mcp.json|claude.md|preset.json');
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function handleConfigGet(res) {
  ok(res, maskConfig(await loadConfig()));
}

async function handleConfigPost(req, res) {
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'A settings object is required');
  const cfg = await loadConfig();
  if (typeof body.githubToken === 'string' && !body.githubToken.startsWith('****')) cfg.githubToken = body.githubToken.trim();
  if (typeof body.aiCommand === 'string' && body.aiCommand.trim()) cfg.aiCommand = body.aiCommand.trim();
  if (Array.isArray(body.aiArgs)) cfg.aiArgs = body.aiArgs.map(String);
  if (typeof body.defaultProjectPath === 'string') cfg.defaultProjectPath = body.defaultProjectPath.trim();
  await writeJsonFile(CONFIG_PATH, cfg);
  ok(res, maskConfig(cfg));
}

async function handleStateGet(res) {
  const raw = await readJsonOrNull(STATE_PATH);
  ok(res, raw && typeof raw === 'object' ? raw : { ...DEFAULT_STATE });
}

function emptyBreakdown() {
  return { plugin: [], mcp: [], skill: [], agent: [], md: [], tool: [], cli: [] };
}
function buildBreakdown(preset, byId) {
  const b = emptyBreakdown();
  for (const iid of (preset && preset.items) || []) {
    const it = byId.get(iid);
    if (it && b[it.type]) b[it.type].push(it.name || iid);
  }
  return b;
}
function parseClaudeArgs(args) {
  const settings = args.match(/--settings\s+(\S+)/);
  const mcp = args.match(/--mcp-config\s+(\S+)/);
  const resume = args.match(/--resume\s+(\S+)/) || args.match(/(?:^|\s)-r\s+(\S+)/);
  const cont = /(?:^|\s)(--continue|-c)(?:\s|$)/.test(args);
  return { settingsPath: settings ? settings[1] : null, mcpPath: mcp ? mcp[1] : null, resume: resume ? resume[1] : null, continue: cont };
}

// Compute the config actually active for a running Claude Code session by reading
// its real config sources: global ~/.claude, the project's .claude/.mcp.json/CLAUDE.md,
// and any --settings/--mcp-config files it was launched with.
async function listDirNames(dir) {
  try {
    // Include symlinked entries too — plugin-provided skills/agents are symlinks.
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}
async function inspectClaude(cwd, settingsFlag, mcpFlag) {
  const home = os.homedir();
  const b = emptyBreakdown();
  // Plugins: merge enabledPlugins from global + project (+ local) + --settings flag
  const pluginMap = {};
  const settingsSources = [path.join(home, '.claude', 'settings.json'), path.join(home, '.claude', 'settings.local.json')];
  if (cwd && cwd !== home) {
    settingsSources.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  }
  if (settingsFlag) settingsSources.push(settingsFlag);
  for (const s of settingsSources) {
    const j = await readJsonOrNull(s);
    if (j && j.enabledPlugins && typeof j.enabledPlugins === 'object') Object.assign(pluginMap, j.enabledPlugins);
  }
  b.plugin = Object.entries(pluginMap).filter(([, v]) => v).map(([k]) => k);
  // Skills & agents: global + project directories
  const skillDirs = [path.join(home, '.claude', 'skills')];
  const agentDirs = [path.join(home, '.claude', 'agents')];
  if (cwd && cwd !== home) {
    skillDirs.push(path.join(cwd, '.claude', 'skills'));
    agentDirs.push(path.join(cwd, '.claude', 'agents'));
  }
  const skillSet = new Set();
  for (const d of skillDirs) (await listDirNames(d)).forEach((n) => skillSet.add(n));
  const agentSet = new Set();
  for (const d of agentDirs) (await listDirNames(d)).forEach((n) => agentSet.add(n));
  b.skill = [...skillSet];
  b.agent = [...agentSet];
  // MCP servers: global ~/.claude.json + project .mcp.json + --mcp-config flag
  const mcpSet = new Set();
  const globalMcp = await readJsonOrNull(path.join(home, '.claude.json'));
  if (globalMcp && globalMcp.mcpServers) Object.keys(globalMcp.mcpServers).forEach((k) => mcpSet.add(k));
  if (cwd) {
    const projMcp = await readJsonOrNull(path.join(cwd, '.mcp.json'));
    if (projMcp && projMcp.mcpServers) Object.keys(projMcp.mcpServers).forEach((k) => mcpSet.add(k));
  }
  if (mcpFlag) {
    const flagMcp = await readJsonOrNull(mcpFlag);
    if (flagMcp && flagMcp.mcpServers) Object.keys(flagMcp.mcpServers).forEach((k) => mcpSet.add(k));
  }
  b.mcp = [...mcpSet];
  // CLAUDE.md in the project and/or global
  if (cwd && (await exists(path.join(cwd, 'CLAUDE.md')))) b.md.push('CLAUDE.md');
  if (await exists(path.join(home, '.claude', 'CLAUDE.md'))) b.md.push('~/.claude/CLAUDE.md');
  return b;
}

async function handleSessions(res) {
  const items = await loadMergedCatalog();
  const byId = new Map(items.map((i) => [i.id, i]));

  // 1) Enumerate ALL running `claude` CLI processes (not the desktop app / plugin procs / this server)
  const ps = await run('ps', ['-Ao', 'pid=,args='], { timeout: 6000 });
  const procs = [];
  if (ps.ok) {
    for (const raw of (ps.stdout || '').split('\n')) {
      const line = raw.trim();
      const m = line.match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = m[1];
      const args = m[2];
      const isCli =
        /(^|\/)claude(\s|$)/.test(args) &&
        !args.includes('/Applications/Claude.app') &&
        !args.includes('Claude Helper') &&
        !/\bbun run\b/.test(args) &&
        !args.includes('AI-refrigerator/server.js') &&
        !/claude (plugin|mcp)\b/.test(args) &&
        !args.includes('--version');
      if (isCli) procs.push({ pid, args });
    }
  }

  // 2) Working directory per process (best effort, batched)
  const cwds = {};
  if (procs.length) {
    const ls = await run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', procs.map((p) => p.pid).join(',')], { timeout: 6000 });
    if (ls.ok) {
      let cur = null;
      for (const l of (ls.stdout || '').split('\n')) {
        if (l.startsWith('p')) cur = l.slice(1);
        else if (l.startsWith('n') && cur) cwds[cur] = l.slice(1);
      }
    }
  }

  // 3) Shape each running session with its EFFECTIVE (actually active) config,
  //    read from that session's real config sources — even if not from a preset.
  const running = [];
  for (const p of procs) {
    const a = parseClaudeArgs(p.args);
    const cwd = cwds[p.pid] || null;
    let mode = 'fresh';
    let label = 'New session';
    let presetName = null;
    if (a.settingsPath && a.settingsPath.includes(path.join('.ai-refrigerator', 'session-presets'))) {
      mode = 'preset';
      const base = path.basename(a.settingsPath);
      const id = base.endsWith('.settings.json') ? base.slice(0, -'.settings.json'.length) : null;
      const preset = id ? await loadPreset(id) : null;
      presetName = preset ? preset.name || id : id;
      label = presetName || 'Preset session';
    } else if (a.resume) {
      mode = 'resume';
      label = `Resumed · ${a.resume.slice(0, 8)}`;
    } else if (a.continue) {
      mode = 'continue';
      label = 'Continued session';
    }
    const breakdown = await inspectClaude(cwd, a.settingsPath, a.mcpPath);
    running.push({
      pid: p.pid,
      cwd,
      mode,
      label,
      presetName,
      settingsPath: a.settingsPath,
      mcpPath: a.mcpPath,
      resume: a.resume || null,
      plugins: breakdown.plugin,
      mcpServers: breakdown.mcp,
      breakdown,
    });
  }

  // 4) Refrigerator-generated session configs (available to launch), flagged if running
  const configs = [];
  try {
    for (const f of (await fsp.readdir(SESSION_DIR)).filter((x) => x.endsWith('.settings.json'))) {
      const id = f.slice(0, -'.settings.json'.length);
      const settingsPath = path.join(SESSION_DIR, f);
      const settings = (await readJsonOrNull(settingsPath)) || {};
      const plugins = Object.entries(settings.enabledPlugins || {}).filter(([, v]) => v).map(([k]) => k);
      const mcpPath = path.join(SESSION_DIR, `${id}.mcp.json`);
      const mcpRaw = await readJsonOrNull(mcpPath);
      const mcpServers = mcpRaw && mcpRaw.mcpServers ? Object.keys(mcpRaw.mcpServers) : [];
      const preset = await loadPreset(id);
      let command = `claude --settings ${settingsPath}`;
      if (mcpServers.length) command += ` --mcp-config ${mcpPath}`;
      configs.push({
        id,
        presetName: preset ? preset.name || id : id,
        presetExists: Boolean(preset),
        command,
        plugins,
        mcpServers,
        breakdown: preset ? buildBreakdown(preset, byId) : emptyBreakdown(),
        running: running.some((r) => r.settingsPath === settingsPath),
      });
    }
  } catch {}

  ok(res, { running, configs });
}

// ── Static files ──────────────────────────────────────────
async function serveStatic(res, pathname) {
  let p;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return fail(res, 400, 'Invalid path');
  }
  if (p.includes('\0')) return fail(res, 400, 'Invalid path');
  if (p === '/' || p === '') p = '/index.html';
  const filePath = path.resolve(PUBLIC_DIR, '.' + p);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return fail(res, 403, 'Access denied');
  }
  try {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    fail(res, 404, 'File not found');
  }
}

// ── Security guard (DNS rebinding + CSRF protection) ───────
// Even for a local-only app, binding to 127.0.0.1 alone does not stop
// cross-origin requests (CSRF) or DNS rebinding from a malicious web page on the same machine.
// 1) Restrict the Host header to local hostnames → blocks DNS rebinding
// 2) If an Origin header is present, compare it against local origins → blocks browser cross-origin requests
// 3) Force application/json on state-changing POST/PUT
//    → blocks text/plain <form> CSRF (simple requests without preflight)
function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  let hostname, port;
  if (hostHeader.startsWith('[')) {
    const idx = hostHeader.indexOf(']');
    hostname = hostHeader.slice(0, idx + 1);
    port = hostHeader.slice(idx + 2);
  } else {
    const idx = hostHeader.lastIndexOf(':');
    if (idx === -1) { hostname = hostHeader; port = ''; }
    else { hostname = hostHeader.slice(0, idx); port = hostHeader.slice(idx + 1); }
  }
  const okHost = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
  const okPort = port === '' || port === String(PORT);
  return okHost && okPort;
}
function allowedOrigin(origin) {
  return [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`].includes(origin);
}
function guardRequest(req, method, pathname) {
  if (!hostAllowed(req.headers.host)) return 'Host header not allowed (DNS rebinding blocked)';
  const origin = req.headers.origin;
  if (origin && !allowedOrigin(origin)) return 'Origin not allowed (CSRF blocked)';
  if ((method === 'POST' || method === 'PUT') && pathname.startsWith('/api/')) {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return 'This request requires Content-Type: application/json';
  }
  return null;
}

// ── Routing ───────────────────────────────────────────────
async function handle(req, res) {
  const u = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = u.pathname;
  const method = (req.method || 'GET').toUpperCase();

  const guardError = guardRequest(req, method, pathname);
  if (guardError) return fail(res, 403, guardError);

  if (!pathname.startsWith('/api/')) {
    if (method === 'GET' || method === 'HEAD') return serveStatic(res, pathname);
    return fail(res, 404, 'The requested path was not found');
  }

  if (method === 'GET' && pathname === '/api/catalog') return handleCatalogGet(res);
  if (method === 'POST' && pathname === '/api/catalog/items') return handleCatalogAdd(req, res);
  if (method === 'DELETE' && pathname.startsWith('/api/catalog/items/')) {
    const id = decodeURIComponent(pathname.slice('/api/catalog/items/'.length));
    return handleCatalogDelete(res, id);
  }
  if (method === 'GET' && pathname === '/api/presets') return handlePresetsGet(res);
  if (pathname.startsWith('/api/presets/')) {
    const id = decodeURIComponent(pathname.slice('/api/presets/'.length));
    if (method === 'PUT') return handlePresetPut(req, res, id);
    if (method === 'DELETE') return handlePresetDelete(res, id);
  }
  if (method === 'GET' && pathname === '/api/status') return handleStatus(res);
  if (method === 'GET' && pathname === '/api/ai-clis') return handleAiClis(res);
  if (method === 'GET' && pathname === '/api/search/github') {
    return handleGithubSearch(res, (u.searchParams.get('q') || '').trim(), u.searchParams.get('sort'), u.searchParams.get('range'));
  }
  if (method === 'GET' && pathname === '/api/search/skillsmp') return handleSkillsmpSearch(res, (u.searchParams.get('q') || '').trim());
  if (method === 'POST' && pathname === '/api/recommend') return handleRecommend(req, res);
  if (method === 'POST' && pathname === '/api/apply') return handleApply(req, res);
  if (method === 'GET' && pathname === '/api/export') {
    return handleExport(res, u.searchParams.get('presetId') || '', u.searchParams.get('format') || '');
  }
  if (method === 'GET' && pathname === '/api/config') return handleConfigGet(res);
  if (method === 'POST' && pathname === '/api/config') return handleConfigPost(req, res);
  if (method === 'GET' && pathname === '/api/state') return handleStateGet(res);
  if (method === 'GET' && pathname === '/api/sessions') return handleSessions(res);

  fail(res, 404, 'The requested API path was not found');
}

// ── Initialization & startup ──────────────────────────────
async function ensureRuntimeFiles() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(PRESETS_DIR, { recursive: true });
  const defaults = [
    [CONFIG_PATH, DEFAULT_CONFIG],
    [STATE_PATH, DEFAULT_STATE],
    [CUSTOM_PATH, []],
  ];
  for (const [p, def] of defaults) {
    if (!(await exists(p))) await writeJsonFile(p, def);
  }
}

await ensureRuntimeFiles();

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : `Server error: ${e.message}`);
    else res.end();
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Specify a different port via the PORT environment variable or --port.`);
    process.exit(1);
  }
  throw e;
});

// Open in a standalone app window (Chromium-family --app mode) so it feels like a native
// desktop app à la cc-switch; fall back to a normal browser tab if none is installed.
function openAppWindow(url) {
  // Launch the browser binary directly (not `open -na`), so an app window opens
  // even when the browser is already running (singleton mode drops --app otherwise).
  const browsers = ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Vivaldi'];
  let i = 0;
  const tryNext = () => {
    if (i >= browsers.length) return execFile('open', [url], () => {});
    const b = browsers[i++];
    const bin = `/Applications/${b}.app/Contents/MacOS/${b}`;
    execFile(bin, [`--app=${url}`, '--new-window'], (err) => {
      if (err) tryNext();
    });
  };
  tryNext();
}

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`🧊 AI Refrigerator → ${url}`);
  if (process.platform === 'darwin' && !NO_OPEN) {
    if (argv.includes('--app')) openAppWindow(url);
    else execFile('open', [url], { timeout: 5000 }, () => {});
  }
});
