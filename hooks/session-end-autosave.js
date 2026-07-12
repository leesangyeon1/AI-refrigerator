#!/usr/bin/env node
// AI Refrigerator — Claude Code SessionEnd hook.
// Durably records the ended session to an on-device inbox file. The app absorbs
// it on its next start (or when the dashboard loads), so nothing is lost even if
// the server was closed — and there is no dependency on a fixed server port.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw || '{}'); } catch {}
  try {
    const dir = path.join(os.homedir(), '.ai-refrigerator', 'data');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ sessionId: d.session_id || '', cwd: d.cwd || '', endedAt: new Date().toISOString() }) + '\n';
    fs.appendFileSync(path.join(dir, 'ended-inbox.jsonl'), line);
  } catch {}
  process.exit(0);
});
// Never block Claude Code's shutdown for long.
setTimeout(() => process.exit(0), 3000);
