import { mkdir, readFile, lstat, appendFile, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { loadConfig } from '../config/loader.js';
import { requireAccess } from '../permissions/policies.js';
import { safePath, projectName } from '../knowledge/knowledge-manager.js';

const categories = { decision: 'decisions', bug: 'bugs', change: 'changes' };
const entrySchema = z.object({
  id: z.string().uuid(), timestamp: z.string().datetime(),
  type: z.enum(['decision', 'bug', 'change']),
  text: z.string().trim().min(1).max(4000),
  solution: z.string().max(4000).optional(),
}).strict();

export function redact(text) {
  return text
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]')
    .replace(/\b(token|password|senha|secret|api[_-]?key)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]');
}

function error(message, code = 'MEMORY_INVALID') {
  return Object.assign(new Error(message), { code });
}

async function location(cwd, write) {
  const config = await loadConfig({ cwd });
  requireAccess(config.permissions.filesystem, write, 'filesystem');
  const path = join(cwd, '.oraculo', 'memory', projectName(config, cwd));
  await safePath(cwd, path, { missing: true });
  return path;
}

async function readEntries(cwd, path, type) {
  const file = join(path, categories[type] + '.jsonl');
  try {
    await safePath(cwd, file);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw error('Memória deve ser arquivo regular de até 2 MiB.');
    const text = await readFile(file, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim());
    if (lines.length > 10000) throw error('Memória excede 10000 registros.');
    return lines.map((line, index) => {
      try {
        const entry = entrySchema.parse(JSON.parse(line));
        if (entry.type !== type) throw error('Categoria incorreta.');
        return entry;
      } catch {
        throw error('Memória inválida em ' + categories[type] + '.jsonl, linha ' + (index + 1) + '.');
      }
    });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function listMemory({ cwd = process.cwd(), type, query, limit = 20 } = {}) {
  if (type && !Object.hasOwn(categories, type)) throw error('Tipo deve ser decision, bug ou change.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error('Limit deve estar entre 1 e 100.');
  const path = await location(cwd, false);
  const entries = [];
  for (const category of type ? [type] : Object.keys(categories)) {
    entries.push(...await readEntries(cwd, path, category));
  }
  const normalized = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return entries.filter((entry) => !query || normalized(entry.text + ' ' + (entry.solution ?? '')).includes(normalized(query)))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id))
    .slice(0, limit)
    .map((entry) => ({ ...entry, text: redact(entry.text), ...(entry.solution !== undefined ? { solution: redact(entry.solution) } : {}) }));
}

export async function addMemory(type, text, { cwd = process.cwd(), solution } = {}) {
  if (!Object.hasOwn(categories, type)) throw error('Tipo deve ser decision, bug ou change.');
  const entry = entrySchema.parse({ id: randomUUID(), timestamp: new Date().toISOString(),
    type, text, ...(solution !== undefined ? { solution } : {}) });
  entry.text = redact(entry.text);
  if (entry.solution) entry.solution = redact(entry.solution);
  const path = await location(cwd, true);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await safePath(cwd, path);
  const lock = join(path, '.lock');
  try { await mkdir(lock); } catch (err) {
    if (err.code === 'EEXIST') throw error('Memória em uso; tente novamente. Se não houver processo ativo, remova a pasta .lock.', 'MEMORY_BUSY');
    throw err;
  }
  try {
    const current = await readEntries(cwd, path, type);
    if (current.length >= 10000) throw error('Limite de registros atingido.');
    const file = join(path, categories[type] + '.jsonl');
    await safePath(cwd, file, { missing: true });
    const line = JSON.stringify(entry) + '\n';
    let prefix = '';
    let size = 0;
    try {
      const existing = await readFile(file);
      size = existing.length;
      if (size && existing.at(-1) !== 10) prefix = '\n';
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (size + Buffer.byteLength(prefix + line) > 2 * 1024 * 1024) throw error('Limite de 2 MiB atingido.');
    await appendFile(file, prefix + line, { encoding: 'utf8', mode: 0o600 });
    return entry;
  } finally {
    await rmdir(lock);
  }
}