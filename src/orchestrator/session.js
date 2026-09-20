import { lstat, readFile, readdir, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { safePath, knowledgeSettings } from '../knowledge/knowledge-manager.js';

const sessionSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(100),
  startedAt: z.string().datetime(),
  status: z.enum(['running', 'completed', 'failed', 'canceled']),
  steps: z.array(z.object({
    agent: z.string(), output: z.string(), startedAt: z.string().datetime(),
    status: z.enum(['completed', 'failed', 'canceled']), code: z.string().optional(),
  }).strict()).max(20),
}).strict();

export async function saveSession(session, { cwd = process.cwd(), create = false } = {}) {
  await knowledgeSettings(cwd, true);
  const data = sessionSchema.parse(session);
  const dir = join(cwd, '.oraculo/sessions');
  const file = join(dir, data.id + '.json');
  await safePath(cwd, file, { missing: true });
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await safePath(cwd, dir);
  if (create) {
    await writeFile(file, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } else {
    await readSession(data.id, { cwd });
    const temporary = join(dir, randomUUID() + '.tmp');
    try {
      await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

export async function readSession(id, { cwd = process.cwd() } = {}) {
  await knowledgeSettings(cwd);
  z.string().uuid().parse(id);
  const file = join(cwd, '.oraculo/sessions', id + '.json');
  await safePath(cwd, file);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 65536) throw new Error('Sessão inválida.');
  return sessionSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

export async function listSessions({ cwd = process.cwd() } = {}) {
  await knowledgeSettings(cwd);
  const dir = join(cwd, '.oraculo/sessions');
  try { await safePath(cwd, dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = await readdir(dir);
  const sessions = [];
  if (entries.length > 1000) throw new Error('Limite de 1000 sessões excedido.');
  for (const entry of entries.sort()) {
    if (entry.endsWith('.json')) sessions.push(await readSession(entry.slice(0, -5), { cwd }));
  }
  return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}