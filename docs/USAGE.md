# 🧊 AI Refrigerator — Detailed Usage

This document covers how to use each tab, the differences between the 3 apply modes, import/export, and troubleshooting for common issues.

## Getting Started

```bash
node server.js              # Default: http://127.0.0.1:4924, browser auto-opens on macOS
node server.js --no-open    # Disable auto-open
node server.js --port 5000  # Change port (the PORT=5000 environment variable works too)
```

The server binds only to 127.0.0.1, so it can only be accessed from the same machine.

---

## Using Each Tab

### 📊 Dashboard

- **4 stat cards**: See the number of Refrigerator ingredients, number of presets, installed plugins (enabled/total), and number of skill directories at a glance.
- **Preset Quick Switch**: Lists presets as horizontal cards. The most recently applied preset gets a `● Active` badge.
  - `[Copy Session Command]`: Copies the `claude --settings ...` command for that preset to the clipboard. Nothing on the system changes.
  - `[Apply Globally]`: First shows the dryRun result (the list of plugins that will be enabled/disabled) in a confirmation modal, and only runs after you confirm.
- **Installed plugins list**: Shows the output of `claude plugin list` in read-only form. Use the refresh button to update it.
- **Last applied history**: Shows the 5 most recent apply records.

### 🧊 Refrigerator (Catalog)

- Use the top search box to filter by name/description/tags, and narrow down with the type chips (All/Skill/Plugin/MCP/Agent/CLAUDE.md/Tool/CLI).
- Category sections can be collapsed/expanded and show a count.
- Item card: Clicking the name opens the GitHub page, and clicking the install code copies it.
- `[Add to Preset]` button → select the target preset from the dropdown to add it immediately.
- Use the `+ Custom Ingredient` button to add your own ingredient (name/type/URL/description/install command/tags). Custom ingredients are stored in `data/custom-items.json` and can be deleted via the × on the card. Built-in ingredients cannot be deleted.

### 🍳 Preset Builder

- Left: ingredient mini panel (search + type sections). Right: preset columns (horizontal scroll).
- **Drag & drop**: Drag from the left panel to a preset to copy, drag between presets to move, and use the × on a card to remove.
- Changes auto-save 1 second later. Confirm with the "Saved ✓" indicator at the top.
- Edit the name/emoji inline in the column header, and use `Export JSON` and `Duplicate` from the menu.
- Create with `+ New Preset`, and load a shared preset file with `Import JSON`.
- On touch devices, tapping a card opens a "Where should this go?" bottom sheet.
- If a preset contains an ingredient id that doesn't exist, it's simply shown as "Missing" — the app still works fine.

### 🔍 Discover & AI Recommendations

There are 3 source tabs.

- **GitHub**: Searches repositories by star count. From a result card, press `[Add to Refrigerator]` (adds it as a custom ingredient after you pick a type) or `[Add to Preset]`. If search fails often, register a GitHub token in the Settings tab.
- **SkillsMP**: Searches skills via the SkillsMP API. If the API can't be reached, a "Search on the site" link button is shown instead (see FAQ below).
- **🤖 AI Recommendations**: Write your goal freely and press `[Get Recommendations]` to receive 3-8 catalog-based recommendations + off-catalog suggestions + GitHub search keywords.

> ⚠️ **AI Recommendations do not call a remote service — they invoke your own machine's `claude` CLI (`claude -p`).**
> - This may be billed against your Claude account/API usage, so **be mindful of cost**.
> - The entire catalog is included in the prompt, so even a single recommendation uses a considerable number of tokens.
> - It can take up to 2-3 minutes to respond (3-minute timeout).
> - If the `claude` CLI is not installed, this feature won't work. You can also switch to a different AI command in the Settings tab.

### 🚀 Apply & Export

Selecting a preset shows a summary of its items, and you pick one of the 3 modes below (see the next section for a detailed comparison).

**Export section** — pick a format tab, then `[Copy]` or `[Download]`:

| Format | Purpose |
|---|---|
| `install.sh` | A bash script gathering the install command for each item (review it yourself before running) |
| `settings.json` | The `enabledPlugins` configuration for the preset's plugins |
| `mcp.json` | The `mcpServers` configuration for the preset's MCP servers |
| `CLAUDE.md` | A starter CLAUDE.md containing the list of preset items |
| `preset.json` | The original preset — for sharing/importing with others |

### ⚙️ Settings

- **GitHub token**: For easing search rate limits. Stored in `data/config.json` and gitignored. After saving, only the last 4 characters are shown.
- **AI command/args**: The CLI that AI Recommendations uses. Defaults to `claude` / `-p`.
- **Default project path**: The default path for Project apply mode.

Data locations: presets live in `presets/`, settings/state/custom ingredients in `data/`, and session settings files in `~/.ai-refrigerator/session-presets/`.

---

## The 3 Apply Modes — Differences and Caveats

| | 🎯 Session | 📁 Project | 🌍 Global |
|---|---|---|---|
| What changes | Nothing (only creates 1 file) | Files inside that project folder | The plugin state of your entire account |
| How to undo | Just don't use it | Restore from the `.bak-<timestamp>` backup | Re-apply a different preset or enable manually |
| Requires claude CLI | No | No | Yes |
| Risk | None | Low (preview + backup) | **High — see caution below** |

### 🎯 Session Mode

Creates just one file, `~/.ai-refrigerator/session-presets/<id>.settings.json`. Copy and use the command shown.

```bash
claude --settings ~/.ai-refrigerator/session-presets/frontend.settings.json
# Or register an alias:
alias cc-frontend='claude --settings ~/.ai-refrigerator/session-presets/frontend.settings.json'
```

The preset's plugins are enabled only for that session, and no system settings change at all. This is the safest mode.

### 📁 Project Mode

Applies the following to the specified project directory.

- `.claude/settings.json` — merges the preset's plugins into `enabledPlugins` while preserving existing content
- `.mcp.json` — preserves existing `mcpServers` + adds the preset's MCP (skips a key if it already exists)
- `CLAUDE.md` — creates it if absent; **if it already exists, leaves it untouched** and writes to `CLAUDE.refrigerator.md` separately
- `ai-refrigerator-install.sh` — generates an install script (not run automatically — review its contents and run it yourself)

Always confirm the plan table (create/merge/skip) first with `[Preview (dryRun)]`. When actually applying, existing files that get modified are automatically backed up to `<file>.bak-<timestamp>`.

### 🌍 Global Mode — ⚠️ Caution

Actually runs `claude plugin enable/disable` to make **your entire account's (user scope)** plugin state match the preset.

> **Most important caveat: Global apply disables every other plugin not in the preset.**
> This is because it treats "preset = the complete list of plugins that should be on." If a plugin you normally use is missing from the preset, it gets turned off.

- Always check the enable / disable / marketplaceAdd lists with `[Preview]`, read the red confirmation modal, and then apply.
- Add any plugins you want to keep using to the preset beforehand.
- If needed, marketplace additions (`claude plugin marketplace add`) are also run automatically.
- This mode requires the `claude` CLI to be installed.

---

## Custom Ingredients / Importing & Exporting Presets

### Custom Ingredients

- Add them via `+ Custom Ingredient` in the Refrigerator tab or `[Add to Refrigerator]` in the Discover tab.
- They are stored in `data/custom-items.json`. Copy this whole file to the same location on another machine to move your ingredient set.
- If an id collides with a built-in ingredient, the addition is rejected (400).

### Sharing Presets

1. **Export**: `Export JSON` from the Preset Builder column menu, or download `preset.json` from the Apply & Export tab.
2. **Import**: Select a file via `Import JSON` in the Preset Builder — if the same id exists, it's overwritten (upsert).
3. You can also drop the file directly into the `presets/` folder and refresh. The filename is `<id>.json`, and the id allows only lowercase letters, digits, and hyphens (`a-z0-9-`, up to 64 characters).

---

## Troubleshooting FAQ

### It says the port is already in use (EADDRINUSE)

Another process is using the default port 4924.

```bash
lsof -i :4924            # Check who's using it
node server.js --port 4925   # Or run on a different port
```

### I get an "AI CLI (claude) not found" error

- AI Recommendations / Global apply require the local `claude` CLI. Install: https://claude.com/claude-code
- If it's already installed, check the PATH with `which claude`. claude must be visible from the shell where you ran the server.
- If you want to use a different CLI, change the AI command/args in the Settings tab (e.g. the full path `/usr/local/bin/claude`).
- Even without claude, Session/Project apply, the catalog, the Preset Builder, and export all work fine.

### GitHub search returns a "rate limit" error

- The GitHub search API without a token is limited to 10 requests per minute.
- Registering a GitHub token (Personal Access Token, no permissions needed — only public repo read) in the Settings tab raises it to 30 per minute.
- The token is stored only in `data/config.json` and is gitignored, so it's never committed.

### SkillsMP search says "can't connect directly"

- SkillsMP's public API can be unstable, so it tries 2 candidate APIs and, if both fail, switches to a fallback.
- In that case a "Search on the site" link button is shown — clicking it opens the skillsmp.com search page in a new tab.
- Searching the same keyword in the GitHub tab is also a good alternative.

### AI Recommendations take too long or fail to parse

- Depending on the model's response, it can take up to 2-3 minutes (180-second timeout).
- "Failed to parse AI response" means the CLI output only non-JSON text. Try again, or write your goal more specifically.

### A preset shows a "Missing" label

- It means an ingredient id the preset references isn't in the catalog (you deleted the custom ingredient, or imported someone else's preset).
- Add a custom ingredient with the same id in the Refrigerator, or remove that card in the builder.
