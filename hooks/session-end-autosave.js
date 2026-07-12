#!/usr/bin/env node
// AI Refrigerator — Claude Code SessionEnd hook.
// Reads the hook JSON on stdin and tells the local AI Refrigerator server that a
// session ended, so it can auto-save (or queue) it per the user's setting.
// Best-effort and silent: if the server isn't running, it just exits 0.
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', async () => {
  let d = {};
  try { d = JSON.parse(raw || '{}'); } catch {}
  const port = process.env.AI_REFRIGERATOR_PORT || 4924;
  const body = JSON.stringify({ sessionId: d.session_id || '', cwd: d.cwd || '' });
  try {
    await fetch(`http://127.0.0.1:${port}/api/sessions/ended`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch {}
  process.exit(0);
});
// Never block Claude Code's shutdown for long.
setTimeout(() => process.exit(0), 3000);
