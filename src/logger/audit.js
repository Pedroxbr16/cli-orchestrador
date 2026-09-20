import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { requireAccess } from '../permissions/policies.js';
import { safePath } from '../knowledge/knowledge-manager.js';

// Append-only audit trail for engine executions. Never records prompt text,
// answers, tokens or credentials — only execution metadata.
export async function appendAudit(entry, { cwd = process.cwd() } = {}) {
  const config = await loadConfig({ cwd });
  requireAccess(config.permissions.filesystem, true, 'filesystem');
  const record = {
    ts: new Date().toISOString(),
    ...entry,
  };
  const dir = join(cwd, '.oraculo/logs');
  const file = join(dir, 'agents.jsonl');
  await safePath(cwd, file, { missing: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await safePath(cwd, dir);
  await writeFile(file, JSON.stringify(record) + '\n', { flag: 'a', mode: 0o600 });
}
