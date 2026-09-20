import { lstat, readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';

const nameSchema = z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
  .refine((name) => !['codex', 'opencode'].includes(name), 'Nome reservado para engine.');
const level = z.enum(['disabled', 'read-only', 'read-write']);
export const agentSchema = z.object({
  name: nameSchema,
  description: z.string().trim().min(1).max(1000),
  engine: z.enum(['codex', 'opencode']),
  model: z.string().trim().min(1).max(200).optional(),
  role: z.string().trim().min(1).max(100).default('developer'),
  skills: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  knowledge: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
  permissions: z.object({
    filesystem: level.optional(), gitLocal: level.optional(), gitRemote: level.optional(),
  }).strict().default({}),
  prompt: z.string().default('./prompt.md'),
}).strict();

function agentError(message, code = 'AGENT_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function validateAgentName(name) {
  const result = nameSchema.safeParse(name);
  if (!result.success) throw agentError('Nome de agent inválido: use letras minúsculas, números e hífens; codex e opencode são reservados.');
  return name;
}

async function directory(path) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw agentError('Diretório de agents deve ser uma pasta real: ' + path);
}

async function readLocalFile(dir, name) {
  // Restrict prompt files to direct children; no symlinks or path traversal.
  const normalized = name.startsWith('./') ? name.slice(2) : name;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(normalized)) {
    throw agentError('O prompt deve ser um arquivo diretamente na pasta do agent.');
  }
  const path = join(dir, normalized);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) {
    throw agentError('Arquivo deve ser regular, sem symlink e ter no máximo 64 KiB: ' + path);
  }
  const text = await readFile(path, 'utf8');
  if (!text.trim()) throw agentError('Arquivo vazio: ' + path);
  return text;
}

export async function loadAgent(name, { cwd = process.cwd() } = {}) {
  validateAgentName(name);
  const dir = join(cwd, 'agents', name);
  try {
    await directory(join(cwd, 'agents'));
    await directory(dir);
    const source = await readLocalFile(dir, 'agent.yaml');
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) {
      throw agentError('YAML inválido em ' + name + ': ' +
        [...document.errors, ...document.warnings].map((issue) => issue.message).join('; '));
    }
    const result = agentSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
    if (!result.success) throw agentError('Agent inválido em ' + name + ': ' +
      result.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('; '));
    if (result.data.name !== name) throw agentError('O campo name deve corresponder à pasta do agent.');
    const promptText = await readLocalFile(dir, result.data.prompt);
    return { ...result.data, promptText };
  } catch (error) {
    if (error.code?.startsWith('AGENT_')) throw error;
    throw agentError('Não foi possível carregar agent "' + name + '": ' +
      (error.code === 'ENOENT' ? 'agent.yaml ou prompt não encontrado.' : error.message));
  }
}

export async function listAgents({ cwd = process.cwd() } = {}) {
  const root = join(cwd, 'agents');
  try { await directory(root); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = await readdir(root, { withFileTypes: true });
  const agents = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try { agents.push({ name: entry.name, agent: await loadAgent(entry.name, { cwd }) }); }
    catch (error) { agents.push({ name: entry.name, error: error.message }); }
  }
  return agents;
}

export async function createAgent(name, { cwd = process.cwd(), engine = 'opencode', role = 'developer', model } = {}) {
  validateAgentName(name);
  const definition = agentSchema.parse({
    name, engine, role, description: 'Agent personalizado: ' + name, prompt: './prompt.md',
    ...(model === undefined ? {} : { model }),
    permissions: { gitRemote: 'disabled' },
  });
  const root = join(cwd, 'agents');
  try { await mkdir(root); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await directory(root);
  const dir = join(root, name);
  try { await mkdir(dir); } catch (error) {
    if (error.code === 'EEXIST') throw agentError('Agent já existe; nenhum arquivo foi sobrescrito: ' + name, 'AGENT_EXISTS');
    throw error;
  }
  // Exclusive creation: never overwrite user files.
  await writeFile(join(dir, 'prompt.md'),
    '# ' + name + '\n\nDescreva aqui as responsabilidades, critérios de qualidade e limites deste agent.\n',
    { encoding: 'utf8', flag: 'wx' });
  await writeFile(join(dir, 'agent.yaml'), stringify(definition), { encoding: 'utf8', flag: 'wx' });
  return loadAgent(name, { cwd });
}