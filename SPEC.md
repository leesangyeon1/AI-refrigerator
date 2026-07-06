# AI Refrigerator — Technical Spec v1.0

A CC Switch-style local web app. A tool that collects **Skills / Plugins / MCP servers / Agent repos / CLAUDE.md templates** for AI coding agents into a "Refrigerator (ingredient store)" and lets you combine them into purpose-built **Presets (recipes)** to save/load/apply/export.

- Built-in recommendation feature using GitHub search + SkillsMP search + **the user's own AI CLI (claude -p)**.
- Anyone else must be able to use it with a single line: `git clone && node server.js`.

## 0. Principles

- **Zero dependencies.** Uses only Node.js built-in modules (`node:http`, `node:fs/promises`, `node:path`, `node:os`, `node:child_process`, `node:url`, and the global `fetch`). Node >= 18.
- ESM (`"type": "module"` in `package.json`).
- The server **binds only to 127.0.0.1** (no external exposure).
- Default port **4924** (change via the `PORT` environment variable or `--port N`).
- All UI text is in **English**. Code comments are kept to a minimum.
- Shell execution must always use `spawn`/`execFile` + an argument array (no string shell interpolation).
- File path validation: preset id allows only `/^[a-z0-9-]{1,64}$/`, and the project path must be verified to be an existing directory.
- When the server starts it prints the URL and, on macOS (darwin), automatically runs `open <url>` (disabled with the `--no-open` flag).

## 1. File Structure

```
AI-refrigerator/
├── server.js              # HTTP server + all APIs (builder A)
├── package.json           # type:module, scripts.start (builder A)
├── start.sh               # exec node server.js (builder A)
├── public/
│   ├── index.html         # SPA markup (builder B)
│   ├── style.css          # styles (builder B)
│   └── app.js             # frontend logic (builder B)
├── data/
│   ├── catalog.json       # built-in catalog (builder C)
│   ├── custom-items.json  # user-added ingredients (created by the server at runtime)
│   ├── config.json        # settings: token/AI command (created by the server at runtime, gitignored)
│   └── state.json         # last applied history (created by the server at runtime, gitignored)
├── presets/               # preset store: <id>.json (builder D generates 5 samples)
├── docs/USAGE.md          # detailed usage (builder D)
├── README.md              # (builder D)
├── SPEC.md                # this file
└── .gitignore
```

If a runtime-generated file is missing, the server automatically creates it with defaults. The `~/.ai-refrigerator/session-presets/` directory is also created automatically on session apply.

## 2. Data Schema

### 2.1 Catalog item (item)

```json
{
  "id": "context7",
  "name": "Context7",
  "type": "skill",
  "stars": "56.5K",
  "desc": "Injects up-to-date docs directly into context. Prevents hallucination.",
  "url": "https://github.com/upstash/context7",
  "install": "npx -y @upstash/context7-mcp@latest",
  "plugin": null,
  "marketplace": null,
  "mcpConfig": { "command": "npx", "args": ["-y", "@upstash/context7-mcp@latest"] },
  "mdUrl": null,
  "tags": ["all"],
  "source": "builtin"
}
```

- `type` ∈ `skill | plugin | mcp | agent | md | tool | cli`
- `plugin`: Claude Code plugin identifier (e.g. `"vercel@claude-plugins-official"`). Only when type=plugin.
- `marketplace`: `"owner/repo"` if a marketplace addition is needed (e.g. `"cloudflare/skills"`).
- `mcpConfig`: The object that goes verbatim into `mcpServers.<name>` in `.mcp.json` (`command`, `args`, optional `env`). null/omitted if unknown.
- `mdUrl`: The raw source URL of the CLAUDE.md (when possible for type=md).
- Omitted fields are treated as null. Both the server and UI must handle missing fields safely.
- `source`: `builtin` (catalog.json) | `custom` (custom-items.json, includes an ISO `addedAt`).

### 2.2 Preset (preset) — `presets/<id>.json`

```json
{
  "id": "frontend",
  "name": "Frontend React",
  "emoji": "🎨",
  "description": "A combination for frontend development",
  "items": ["taste", "context7", "plugin-frontend-design"],
  "createdAt": "2026-07-05T00:00:00.000Z",
  "updatedAt": "2026-07-05T00:00:00.000Z"
}
```

`items` is an array of catalog ids. Non-existent ids are shown as "Missing" in the UI but don't break anything.

### 2.3 Config — `data/config.json`

```json
{ "githubToken": "", "aiCommand": "claude", "aiArgs": ["-p"], "defaultProjectPath": "" }
```

### 2.4 State — `data/state.json`

```json
{ "lastApplied": { "presetId": "frontend", "mode": "global", "target": null, "at": "ISO" }, "history": [] }
```

`history` holds at most 20 entries (newest first).

## 3. API (every response: `{"ok":true,"data":...}` or `{"ok":false,"error":"message"}`)

Content-Type: `application/json; charset=utf-8` (except export). Body max 2MB.

| Method/Path | Action |
|---|---|
| `GET /` and static files | Serve `public/` (path traversal prevented) |
| `GET /api/catalog` | `{items:[...]}` — merges catalog.json + custom-items.json |
| `POST /api/catalog/items` | Add a custom ingredient. body=item (partial). If no id, kebab-case the name. Duplicate id → 400 |
| `DELETE /api/catalog/items/:id` | Only custom items can be deleted. builtin → 400 |
| `GET /api/presets` | `{presets:[...]}` — all presets/*.json, name ascending |
| `PUT /api/presets/:id` | Upsert. body=full preset. id format validated. `updatedAt` refreshed by the server |
| `DELETE /api/presets/:id` | Delete the preset file |
| `GET /api/status` | See 3.1 below |
| `GET /api/search/github?q=...` | See 3.2 below |
| `GET /api/search/skillsmp?q=...` | See 3.3 below |
| `POST /api/recommend` | See 3.4 below |
| `POST /api/apply` | See 3.5 below |
| `GET /api/export?presetId=..&format=..` | See 3.6 below. Returns the raw content as **text/plain; charset=utf-8** |
| `GET /api/config` | Returns config but with `githubToken` masked (`"****abcd"`, last 4 chars) + `githubTokenSet:true/false` |
| `POST /api/config` | Partial update. If githubToken starts with `"****"`, ignore it (keep existing) |
| `GET /api/state` | Return state.json |

### 3.1 GET /api/status

```json
{
  "claude": { "available": true, "version": "claude 2.x.x" },
  "plugins": [ { "name": "vercel", "marketplace": "claude-plugins-official", "version": "0.44.0", "scope": "user", "enabled": false } ],
  "skillsDirs": ["dataviz", "verify"],
  "enabledPluginsGlobal": { "vercel@claude-plugins-official": false },
  "settingsPath": "/Users/x/.claude/settings.json"
}
```

- Parses the output of `claude plugin list` (`execFile('claude', ['plugin','list'])`, 15s timeout). Format:
  ```
    ❯ vercel@claude-plugins-official
      Version: 0.44.0
      Scope: user
      Status: ✔ enabled   (or ✘ disabled)
  ```
- `skillsDirs`: subdirectory names under `~/.claude/skills/` (empty [] if none).
- `enabledPluginsGlobal`: the `enabledPlugins` from `~/.claude/settings.json` ({} if none).
- If the claude CLI is absent, respond with `claude.available=false` and fill in the rest as much as possible.

### 3.2 GET /api/search/github?q=...

`https://api.github.com/search/repositories?q=<q>&sort=stars&order=desc&per_page=12`
Headers: `User-Agent: ai-refrigerator`, `Accept: application/vnd.github+json`, and `Authorization: Bearer <token>` if a token exists.

Response: `{results:[item...]}` — mapped into item form:
- `id`: `gh-` + kebab-cased full_name
- `name`: full_name, `desc`: description (left as-is, not translated), `url`: html_url
- `stars`: formatted `stargazers_count` (1234→"1.2K", 999→"999")
- `type` inference: if name/desc/topics contain `mcp`→mcp, `skill`→skill, `agent`→agent, `claude.md|claude-md`→md, otherwise→tool
- `install`: null
If GitHub returns 403/429: `{ok:false,error:"GitHub rate limit — add a token in Settings"}`.

### 3.3 GET /api/search/skillsmp?q=...

Tries candidate URLs in order (8-second timeout each):
1. `https://skillsmp.com/api/search?q=<q>`
2. `https://skillsmp.com/api/skills?q=<q>`

If it finds a JSON array (or an array under the `data`/`skills`/`results` key), it maps to `{name, desc, url, author}` as `{results:[...], source:"skillsmp"}`.
If all fail: `{ok:true, data:{results:[], source:"fallback", fallbackUrl:"https://skillsmp.com/?q=<q>"}}` — the UI shows a link button.

### 3.4 POST /api/recommend  body: `{"goal":"I want to build a Next.js frontend app and save tokens"}`

1. Build a list compressing the catalog into one `id|type|name|desc` line each.
2. Prompt (English):

```
You are an expert at setting up AI coding agents. Recommend a combination of tools that fits the user's goal.
[Catalog] (id|type|name|description)
<list>
[User goal]
<goal>
Output only the JSON below. No other text:
{"recommendations":[{"id":"catalog-id","reason":"one-line reason"}],"extra":[{"name":"off-catalog suggestion","type":"skill|mcp|tool","url":"https://...","install":"install command or null","reason":"reason"}],"keywords":["1-3 recommended GitHub search keywords"]}
recommendations must be 3-8, and only ids that actually exist in the catalog.
```

3. `execFile(config.aiCommand, [...config.aiArgs, prompt], {timeout:180000, maxBuffer:10*1024*1024})`.
4. Find the **first balanced `{...}` block** in stdout and JSON.parse it. On failure: `{ok:false,error:"Failed to parse AI response: <first 200 chars>"}`.
5. Response: `{recommendations:[{id,reason,item:<full catalog item>}], extra:[...], keywords:[...]}` (ids not in the catalog are excluded).
6. CLI absent/timeout → a clear English error (`"AI CLI (claude) not found. Check the command in Settings."`).

### 3.5 POST /api/apply  body: `{"presetId":"frontend","mode":"session|project|global","projectPath":"...","dryRun":true|false}`

Classify the preset items: `pluginItems` (type=plugin & plugin field), `mcpItems` (has mcpConfig), `mdItems` (type=md), `installItems` (the rest that have an install field).

**mode=session** (dryRun ignored, always safe):
- Write `{"enabledPlugins":{"<plugin>":true,...}}` to `~/.ai-refrigerator/session-presets/<id>.settings.json`.
- Response: `{settingsPath, command:"claude --settings <path>", aliasLine:"alias cc-<id>='claude --settings <path>'", pluginCount}`

**mode=project** (projectPath required, an existing directory):
- Compute the plan:
  - `.claude/settings.json`: read the existing JSON and merge the preset plugins as `true` into `enabledPlugins` (preserving other existing keys)
  - `.mcp.json`: merge existing `mcpServers` + add `{ "<item.id>": mcpConfig }` (existing same keys are preserved and marked skipped)
  - `CLAUDE.md`: create if absent — header + the fetched content of each md item's `mdUrl` (8s timeout, a link comment on failure) concatenated. If it already exists, leave it untouched and write to `CLAUDE.refrigerator.md`
- dryRun=true → `{plan:{writes:[{path,action:"create|merge|skip",note}], installScript:"<install.sh content>"}}`
- dryRun=false → before actually writing, back up existing files to `<file>.bak-<timestamp>`. Response `{written:[...], skipped:[...], backups:[...], installScriptPath}` (install.sh is `<projectPath>/ai-refrigerator-install.sh`, chmod +x, **not run automatically**)

**mode=global**:
- Read the current `claude plugin list` state and compare against the preset plugin set →
  `plan = { enable:[...], disable:[...], marketplaceAdd:[...] }` (disable targets = currently enabled but not in the preset)
- dryRun=true → return only the plan.
- dryRun=false → run in order via execFile: `claude plugin marketplace add <mk>` (if needed), `claude plugin enable -s user <p>`, `claude plugin disable -s user <p>` (30s timeout each). Response `{plan, executed:[{cmd,ok,output}]}`.
- On success, update lastApplied/history in state.json (same for session/project).

### 3.6 GET /api/export?presetId=..&format=..

| format | Content |
|---|---|
| `install.sh` | `#!/bin/bash`, `set -e`, echo + command per item. Plugin: marketplace add (if any) + `claude plugin install <plugin>`. mcp (has mcpConfig): `claude mcp add <id> -- <command> <args...>`. Others: item.install. For items without install: a `# <name>: manual install — <url>` comment |
| `settings.json` | `{"enabledPlugins":{...true}}` (preset plugins) |
| `mcp.json` | `{"mcpServers":{"<id>":mcpConfig,...}}` |
| `claude.md` | Preset header + md item links/comments + a table of preset items (a starter for reference) |
| `preset.json` | The original preset JSON (for sharing/importing) |

## 4. UI Spec (public/)

### 4.1 Layout — CC Switch style

- Left fixed sidebar (220px): logo `🧊 AI Refrigerator` at the top, navigation below:
  1. `📊 Dashboard` (#dashboard)
  2. `🧊 Refrigerator` (#pantry)
  3. `🍳 Preset Builder` (#builder)
  4. `🔍 Discover & AI Recommendations` (#discover)
  5. `🚀 Apply & Export` (#apply)
  6. `⚙️ Settings` (#settings)
  Bottom: server status dot (green) + version `v1.0.0`.
- Hash routing (`location.hash`) for tab switching. The hash persists across refreshes.
- Mobile (<768px): the sidebar turns into a top horizontal-scroll tab bar.
- Dark GitHub theme (same tokens as dashboard.html):
  `--bg:#0d1117 --card:#161b22 --border:#30363d --text:#e6edf3 --muted:#8b949e --accent:#58a6ff --green:#3fb950 --orange:#d29922 --red:#f85149 --purple:#bc8cff --pink:#f778ba --cyan:#39d2c0`
- Type badge colors: skill=orange, mcp=green, agent=purple, md=red, tool=cyan, plugin=accent(blue), cli=pink.
- Shared components: toast notifications (bottom center), confirmation modal (for risky actions), loading spinner.

### 4.2 Dashboard

- 4 stat cards at the top: Refrigerator ingredient count / preset count / installed plugins (enabled/total) / skill directory count.
- **Preset Quick Switch** (the core CC Switch UX): lists presets as horizontal cards, with a `● Active` badge on the most recently applied preset. Each card has [Copy Session Command] and [Apply Globally] buttons. Apply Globally shows the dryRun result (enable/disable list) in a confirmation modal before running.
- Installed plugins list (shows name/version/enabled toggle — read-only badge) + refresh button.
- Last applied history (5 most recent from state.history).

### 4.3 Refrigerator (Catalog)

- Top: search input (name/description/tag filter) + type filter chips (All/Skill/Plugin/MCP/Agent/CLAUDE.md/Tool/CLI) + `+ Custom Ingredient` button.
- Sections per category (collapse/expand, show count). Item card: name (GitHub link), type badge, ★ stars, description, install code (click to copy), and a delete × if custom.
- An `Add to Preset` button on the card → a preset-select dropdown popover.
- Custom ingredient modal: name/type/URL/description/install command/tags (comma-separated).

### 4.4 Preset Builder (inherits the drag & drop from dashboard.html)

- Left: ingredient mini panel (search + type sections, draggable cards). Right: preset columns (horizontal scroll).
- Column: emoji + name (inline edit) + delete, per-type count summary, drop zone. Drag to copy pantry→preset, move preset↔preset, remove with ×.
- Changes auto-save via `PUT /api/presets/:id` with a 1-second debounce (the "saved" toast is quiet, with a "Saved ✓" indicator at the top).
- `+ New Preset` (name/emoji modal), `Import JSON` (file select → PUT), and the column header menu has `Export JSON` (download) and `Duplicate`.
- Touch devices: tap a card → "Where should this go?" bottom sheet (the dashboard.html approach).

### 4.5 Discover & AI Recommendations

- 3 source tabs: `GitHub` / `SkillsMP` / `🤖 AI Recommendations`.
- GitHub/SkillsMP: search box + result cards (name/description/★/link) + [Add to Refrigerator] (type-select mini popover → POST custom item) + [Add to Preset].
- On SkillsMP fallback: "Can't connect directly to the SkillsMP API — search on the site" link button + a suggestion to use GitHub results instead.
- AI Recommendations: textarea ("Describe what you want to build...") + [Get Recommendations]. While loading, shows "Analyzing with my claude CLI... (up to 2-3 min)". Results: catalog recommendations (with reasons, [Add to Preset]) / off-catalog suggestions (extra, [Add to Refrigerator]) / recommended search keyword chips (click to search in the GitHub tab).

### 4.6 Apply & Export

- Preset select dropdown + item summary.
- 3 mode cards (radio):
  - `🎯 Session` — "This session only. Nothing changes permanently" → [Create] → show/copy command/alias
  - `📁 Project` — path input (defaults to config.defaultProjectPath) → [Preview (dryRun)] plan table → [Apply] → result report
  - `🌍 Global` — [Preview] enable/disable/marketplaceAdd list → red confirmation modal → [Apply] → execution log
- Export section: format tabs (install.sh / settings.json / mcp.json / CLAUDE.md / preset.json) → code view + [Copy] [Download].

### 4.7 Settings

- GitHub token (password input, masked display), AI command (default `claude`) + args (default `-p`), default project path. [Save] → POST /api/config.
- Data location guidance (presets/, data/, ~/.ai-refrigerator/).

### 4.8 Frontend Implementation Rules

- No framework. A single `app.js` file, with a `fetch` helper `api(path, opts)` — shows an error toast on `{ok:false}`.
- On startup, load `catalog / presets / status / state / config` (5) via `Promise.allSettled`. The app works even if status fails.
- XSS prevention: insert user/external strings via `textContent` or an escape helper.

## 5. Core Built-in Catalog Items (ids are fixed — never change)

Builder C includes the JSON below **verbatim** and appends additional items (14 CLIs, token tools, skill repos, awesome lists, etc. — see `/Users/isang-yeon/ai-tools-guide/index.html`) to reach a total of 70-90. The sample presets (builder D) reference only the ids below.

```json
[
{"id":"caveman","name":"Caveman","type":"skill","stars":"76.6K","desc":"Cuts output tokens by 65-75%. 4-stage compression.","url":"https://github.com/JuliusBrussee/caveman","install":"npx skills add JuliusBrussee/caveman","tags":["token"],"source":"builtin"},
{"id":"taste","name":"taste-skill","type":"skill","stars":"48.7K","desc":"Anti-slop frontend. Prevents AI generic UI.","url":"https://github.com/Leonxlnx/taste-skill","install":"npx skills add Leonxlnx/taste-skill","tags":["frontend"],"source":"builtin"},
{"id":"last30","name":"last30days","type":"skill","stars":"46.2K","desc":"Searches 12+ sources at once. Access to the latest info.","url":"https://github.com/mvanhorn/last30days-skill","install":"npx skills add mvanhorn/last30days-skill -g -y","tags":["research"],"source":"builtin"},
{"id":"ponytail","name":"Ponytail","type":"skill","stars":"55.7K","desc":"Code −54%, cost −22%. 7-step decision ladder.","url":"https://github.com/DietrichGebert/ponytail","install":"npx skills add DietrichGebert/ponytail","tags":["token"],"source":"builtin"},
{"id":"grillme","name":"grill-me","type":"skill","stars":"143K","desc":"Design validation. Removes ambiguity with Socratic questioning.","url":"https://github.com/mattpocock/skills","install":"npx skills add mattpocock/grill-me","tags":["architecture"],"source":"builtin"},
{"id":"antigravity","name":"antigravity-skills","type":"skill","stars":"41.5K","desc":"A library of 1,684+ skills. Bundle selection available.","url":"https://github.com/sickn33/antigravity-awesome-skills","install":"npx antigravity-awesome-skills --claude","tags":["library"],"source":"builtin"},
{"id":"webwright","name":"Webwright","type":"skill","stars":"5.6K","desc":"Microsoft web automation. Generates Playwright code.","url":"https://github.com/microsoft/Webwright","install":"npx skills add microsoft/Webwright","tags":["frontend","automation"],"source":"builtin"},
{"id":"tokensave","name":"TokenSave","type":"skill","stars":"253","desc":"Code intelligence MCP. Semantic search token savings.","url":"https://github.com/aovestdipaperino/tokensave","install":"npx skills add aovestdipaperino/tokensave","tags":["token"],"source":"builtin"},
{"id":"context7","name":"Context7","type":"mcp","stars":"56.5K","desc":"Injects up-to-date docs directly into context. Prevents hallucination.","url":"https://github.com/upstash/context7","install":"npx -y @upstash/context7-mcp@latest","mcpConfig":{"command":"npx","args":["-y","@upstash/context7-mcp@latest"]},"tags":["docs"],"source":"builtin"},
{"id":"litellm","name":"LiteLLM","type":"mcp","stars":"51.4K","desc":"Gateway to 140+ LLM providers. Load balancing, caching.","url":"https://github.com/BerriAI/litellm","install":"pip install litellm","tags":["backend","gateway"],"source":"builtin"},
{"id":"headroom","name":"Headroom","type":"mcp","stars":"48K","desc":"A proxy that compresses context by 60-95%.","url":"https://github.com/headroomlabs-ai/headroom","install":"headroom wrap claude","tags":["token"],"source":"builtin"},
{"id":"rtk","name":"RTK","type":"mcp","stars":"48.1K","desc":"CLI proxy. Rust binary. Auto-compresses dev output.","url":"https://github.com/rtk-ai/rtk","install":"brew install rtk-ai/tap/rtk","tags":["token"],"source":"builtin"},
{"id":"repomix","name":"Repomix","type":"mcp","stars":"26.5K","desc":"Packs an entire repo into an AI-friendly file.","url":"https://github.com/yamadashy/repomix","install":"npx repomix","mcpConfig":{"command":"npx","args":["-y","repomix","--mcp"]},"tags":["context"],"source":"builtin"},
{"id":"leanctx","name":"LeanCTX","type":"mcp","stars":"2.9K","desc":"76 MCP tools. 10 read modes (AST/diff).","url":"https://github.com/yvgude/lean-ctx","install":"npm install -g lean-ctx","tags":["token","backend"],"source":"builtin"},
{"id":"gptcache","name":"GPTCache","type":"mcp","stars":"7.9K","desc":"Semantic caching. Reuses responses for similar queries.","url":"https://github.com/zilliztech/GPTCache","install":"pip install gptcache","tags":["backend","cache"],"source":"builtin"},
{"id":"composio","name":"Composio","type":"mcp","stars":"28.5K","desc":"250+ tool integrations. Auth, sandbox.","url":"https://github.com/ComposioHQ/composio","install":"pip install composio-core","tags":["automation"],"source":"builtin"},
{"id":"omo","name":"oh-my-openagent","type":"agent","stars":"63.5K","desc":"11-agent orchestration. Multi-model.","url":"https://github.com/code-yeongyu/oh-my-openagent","install":"bunx oh-my-openagent install","tags":["orchestration"],"source":"builtin"},
{"id":"omc","name":"oh-my-claudecode","type":"agent","stars":"36.7K","desc":"19 agents. 6 modes. Tokens −30-50%.","url":"https://github.com/yeachan-heo/oh-my-claudecode","install":"npm i -g oh-my-claude-sisyphus@latest && omc setup","tags":["orchestration"],"source":"builtin"},
{"id":"omx","name":"oh-my-codex","type":"agent","stars":"30.5K","desc":"Structured workflows for the Codex CLI.","url":"https://github.com/Yeachan-Heo/oh-my-codex","install":"npm install -g oh-my-codex && omx setup","tags":["orchestration"],"source":"builtin"},
{"id":"ecc","name":"Everything Claude Code","type":"agent","stars":"214K","desc":"An agent harness OS. 48 agents, 184 skills.","url":"https://github.com/affaan-m/everything-claude-code","install":"git clone https://github.com/affaan-m/everything-claude-code","tags":["harness"],"source":"builtin"},
{"id":"superpowers","name":"Superpowers","type":"agent","stars":"237K","desc":"An agentic skill framework & development methodology.","url":"https://github.com/obra/superpowers","install":"git clone https://github.com/obra/superpowers","tags":["framework"],"source":"builtin"},
{"id":"agentfarm","name":"Agent Farm","type":"agent","stars":"2K+","desc":"Runs 20+ Claude Code instances in parallel. tmux.","url":"https://github.com/Dicklesworthstone/claude_code_agent_farm","install":"git clone https://github.com/Dicklesworthstone/claude_code_agent_farm","tags":["automation"],"source":"builtin"},
{"id":"md-karpathy","name":"Karpathy CLAUDE.md","type":"md","stars":"109K+","desc":"65 lines, 4 core rules. The gold standard of minimalism.","url":"https://github.com/forrestchang/andrej-karpathy-skills","install":"curl -o CLAUDE.md https://raw.githubusercontent.com/forrestchang/andrej-karpathy-skills/main/CLAUDE.md","mdUrl":"https://raw.githubusercontent.com/forrestchang/andrej-karpathy-skills/main/CLAUDE.md","tags":["minimal"],"source":"builtin"},
{"id":"md-bestpractice","name":"claude-code-best-practice","type":"md","stars":"48.8K","desc":"69 tips. Command→Agent→Skill pattern.","url":"https://github.com/shanraisshan/claude-code-best-practice","install":"git clone https://github.com/shanraisshan/claude-code-best-practice","tags":["guide"],"source":"builtin"},
{"id":"md-airulez","name":"ai-rulez","type":"md","stars":"3K+","desc":"Auto-generates native config for 19 tools.","url":"https://github.com/Goldziher/ai-rulez","install":"npx ai-rulez init","tags":["generator"],"source":"builtin"},
{"id":"md-claudeforge","name":"ClaudeForge","type":"md","stars":"388","desc":"Auto-generates CLAUDE.md. 150-line cap.","url":"https://github.com/alirezarezvani/claudeforge","install":"npx claudeforge init","tags":["generator"],"source":"builtin"},
{"id":"md-templates","name":"claude-md-templates","type":"md","stars":"250","desc":"Per-stack rules for Go/Rust/Rails/Django.","url":"https://github.com/abhishekray07/claude-md-templates","install":"git clone https://github.com/abhishekray07/claude-md-templates","tags":["templates"],"source":"builtin"},
{"id":"routellm","name":"RouteLLM","type":"tool","stars":"4.3K","desc":"Auto-routes models by query difficulty. 85%+ cost cut.","url":"https://github.com/lm-sys/routellm","install":"pip install routellm","tags":["token","routing"],"source":"builtin"},
{"id":"optillm","name":"OptiLLM","type":"tool","stars":"3.4K","desc":"Inference optimization proxy. 2-10x accuracy gain.","url":"https://github.com/codelion/optillm","install":"pip install optillm","tags":["backend"],"source":"builtin"},
{"id":"tokencost","name":"TokenCost","type":"tool","stars":"2K","desc":"Real-time tracking of LLM API costs.","url":"https://github.com/AgentOps-AI/tokencost","install":"pip install tokencost","tags":["monitoring"],"source":"builtin"},
{"id":"n8n","name":"n8n","type":"tool","stars":"194K","desc":"Visual workflow automation. 400+ integrations.","url":"https://github.com/n8n-io/n8n","install":"npx n8n","tags":["automation"],"source":"builtin"},
{"id":"browseruse","name":"browser-use","type":"tool","stars":"100K","desc":"AI browser automation.","url":"https://github.com/browser-use/browser-use","install":"pip install browser-use","tags":["frontend","automation"],"source":"builtin"},
{"id":"plugin-cloudflare","name":"Cloudflare Plugin","type":"plugin","stars":null,"desc":"Cloudflare official: Workers·R2·D1·KV skills + 5 MCPs (API/docs/bindings/build/observability).","url":"https://github.com/cloudflare/skills","install":"claude plugin marketplace add cloudflare/skills && claude plugin install cloudflare@cloudflare","plugin":"cloudflare@cloudflare","marketplace":"cloudflare/skills","tags":["deploy","backend"],"source":"builtin"},
{"id":"plugin-vercel","name":"Vercel Plugin","type":"plugin","stars":null,"desc":"~40 skills for deploy, env, Next.js, AI SDK, etc. + 3 specialized agents.","url":"https://github.com/anthropics/claude-plugins","install":"claude plugin install vercel@claude-plugins-official","plugin":"vercel@claude-plugins-official","tags":["deploy","frontend"],"source":"builtin"},
{"id":"plugin-frontend-design","name":"Frontend Design Plugin","type":"plugin","stars":null,"desc":"Injects a guide for deliberate UI design that doesn't look templated.","url":"https://github.com/anthropics/claude-plugins","install":"claude plugin install frontend-design@claude-plugins-official","plugin":"frontend-design@claude-plugins-official","tags":["frontend","design"],"source":"builtin"},
{"id":"plugin-discord","name":"Discord Plugin","type":"plugin","stars":null,"desc":"Chat with Claude via a Discord channel. Bot token based.","url":"https://github.com/anthropics/claude-plugins","install":"claude plugin install discord@claude-plugins-official","plugin":"discord@claude-plugins-official","tags":["messaging"],"source":"builtin"},
{"id":"plugin-telegram","name":"Telegram Plugin","type":"plugin","stars":null,"desc":"Chat with Claude via a Telegram bot.","url":"https://github.com/anthropics/claude-plugins","install":"claude plugin install telegram@claude-plugins-official","plugin":"telegram@claude-plugins-official","tags":["messaging"],"source":"builtin"},
{"id":"plugin-imessage","name":"iMessage Plugin","type":"plugin","stars":null,"desc":"Chat with Claude via iMessage (macOS).","url":"https://github.com/anthropics/claude-plugins","install":"claude plugin install imessage@claude-plugins-official","plugin":"imessage@claude-plugins-official","tags":["messaging"],"source":"builtin"},
{"id":"plugin-swift-lsp","name":"Swift LSP Plugin","type":"plugin","stars":null,"desc":"SourceKit-LSP integration for Swift code (iOS/macOS development).","url":"https://github.com/anthropics/claude-plugins","install":"claude plugin install swift-lsp@claude-plugins-official","plugin":"swift-lsp@claude-plugins-official","tags":["mobile"],"source":"builtin"}
]
```

## 6. Sample Presets (builder D — uses only the core ids above)

1. `frontend` 🎨 Frontend React — taste, context7, plugin-frontend-design, plugin-vercel, md-karpathy, grillme, browseruse
2. `backend-api` ⚙️ Backend API — context7, leanctx, litellm, gptcache, repomix, md-bestpractice
3. `token-saver` 🪙 Token Saver — caveman, ponytail, rtk, headroom, tokensave, routellm, tokencost
4. `cloudflare-edge` ☁️ Cloudflare Edge — plugin-cloudflare, context7, repomix, md-bestpractice
5. `research` 🔬 Research & Automation — last30, context7, repomix, browseruse, n8n
6. `messaging` 💬 Messaging Assistant — plugin-imessage, plugin-telegram, plugin-discord

## 7. Acceptance Criteria (Smoke Test)

1. `node server.js --no-open` (PORT=4939) starts → `GET /` returns 200 + HTML.
2. `GET /api/catalog` → ok:true, items ≥ 39, core ids present (`context7`, `plugin-cloudflare`).
3. `GET /api/presets` → 6 sample presets.
4. `PUT /api/presets/test-x` (valid body) → ok → reflected in `GET` → `DELETE` → confirm removal.
5. `GET /api/status` → ok (keeps the ok:true structure even without claude).
6. `GET /api/export?presetId=frontend&format=install.sh` → text/plain, contains `claude plugin install`.
7. `POST /api/apply` `{presetId:"frontend",mode:"session"}` → the settingsPath file is actually created.
8. `POST /api/apply` `{presetId:"frontend",mode:"project",projectPath:"<mktemp>",dryRun:true}` → returns a plan, no files created.
9. `GET /api/search/github?q=repomix` → ok or a rate-limit error message (no crash).
10. `GET /api/config` → confirm token masking. `POST /api/config` → confirm it's reflected.
11. Non-existent path `/api/nope` → 404 JSON. `../` path traversal attempt → 403/404.
