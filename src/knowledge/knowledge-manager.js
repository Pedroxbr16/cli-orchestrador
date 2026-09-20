import { lstat, readdir, readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve, relative, join, basename, extname, isAbsolute } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { requireAccess } from '../permissions/policies.js';

export function knowledgeError(message, code = 'KNOWLEDGE_INVALID') {
  return Object.assign(new Error(message), { code });
}

export function projectName(config, cwd) {
  const name = config.project?.name ?? basename(resolve(cwd));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name) || name.includes('..')) {
    throw knowledgeError('project.name deve ser um identificador simples para usar knowledge de projeto.');
  }
  return name;
}

function validateId(id) {
  if (typeof id !== 'string' || !/^(global|projects)\//.test(id) ||
      id.split('/').some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part) || part.includes('..'))) {
    throw knowledgeError('ID de knowledge inválido.');
  }
  return id;
}

// Inspect each path component: no symlink traversal, including parent directories.
export async function safePath(root, path, { missing = false } = {}) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(path);
  const rel = relative(absoluteRoot, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw knowledgeError('Caminho fora do projeto.');
  let current = absoluteRoot;
  for (const part of ['', ...rel.split('/').filter(Boolean)]) {
    if (part) current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw knowledgeError('Symlinks não são permitidos: ' + current);
    } catch (error) {
      if (missing && error.code === 'ENOENT') return absolute;
      throw error;
    }
  }
  return absolute;
}

export async function readDocument(cwd, path) {
  await safePath(cwd, path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 262144 || !['.md', '.txt'].includes(extname(path).toLowerCase())) {
    throw knowledgeError('Documento deve ser Markdown/texto regular com até 256 KiB.');
  }
  const buffer = await readFile(path);
  if (buffer.length > 262144) throw knowledgeError('Documento excede 256 KiB.');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw knowledgeError('Documento deve usar UTF-8 válido.'); }
  if (text.includes('\0') || !text.trim()) throw knowledgeError('Documento vazio ou binário.');
  return text.replace(/\r\n/g, '\n');
}

export async function knowledgeSettings(cwd, write = false) {
  const config = await loadConfig({ cwd });
  requireAccess(config.permissions.filesystem, write, 'filesystem');
  return config;
}

export function scopeDirectory(scope, config, cwd) {
  if (scope === 'global') return 'global';
  if (scope === 'project') return 'projects/' + projectName(config, cwd);
  throw knowledgeError('Scope deve ser global ou project.');
}

export async function listDocuments({ cwd = process.cwd(), scope } = {}) {
  const config = await knowledgeSettings(cwd);
  const root = join(cwd, 'knowledge');
  const scopes = scope ? [scopeDirectory(scope, config, cwd)] : ['global', scopeDirectory('project', config, cwd)];
  const documents = [];
  let total = 0;
  let entriesSeen = 0;
  async function walk(path, depth = 0) {
    if (depth > 12) throw knowledgeError('Knowledge excede 12 níveis de pastas.');
    try { await safePath(cwd, path); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    const stat = await lstat(path);
    if (!stat.isDirectory()) throw knowledgeError('Pasta de knowledge inválida: ' + path);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entriesSeen > 2000) throw knowledgeError('Knowledge excede 2000 entradas.');
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) throw knowledgeError('Symlinks não são permitidos: ' + file);
      if (entry.isDirectory()) { await walk(file, depth + 1); continue; }
      if (!['.md', '.txt'].includes(extname(entry.name).toLowerCase())) continue;
      const id = relative(root, file).split('\\').join('/');
      validateId(id);
      const text = await readDocument(cwd, file);
      total += Buffer.byteLength(text);
      if (total > 5 * 1024 * 1024 || documents.length >= 500) {
        throw knowledgeError('Knowledge excede o limite de 500 documentos ou 5 MiB.');
      }
      documents.push({ id, text, title: text.match(/^#\s+(.+)$/m)?.[1] ?? entry.name });
    }
  }
  for (const dir of scopes) await walk(join(root, dir));
  return documents;
}

export async function addDocument(source, { cwd = process.cwd(), scope = 'project' } = {}) {
  const config = await knowledgeSettings(cwd, true);
  const sourcePath = resolve(cwd, source);
  const text = await readDocument(cwd, sourcePath);
  const id = validateId(scopeDirectory(scope, config, cwd) + '/' + basename(sourcePath));
  const destination = join(cwd, 'knowledge', id);
  await safePath(cwd, destination, { missing: true });
  await mkdir(resolve(destination, '..'), { recursive: true });
  await safePath(cwd, resolve(destination, '..'));
  try { await writeFile(destination, text, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw knowledgeError('Documento já existe; nada foi sobrescrito: ' + id, 'KNOWLEDGE_EXISTS');
    throw error;
  }
  return id;
}

export async function removeDocument(id, { cwd = process.cwd() } = {}) {
  const config = await knowledgeSettings(cwd, true);
  validateId(id);
  const allowed = id.startsWith('global/') || id.startsWith(scopeDirectory('project', config, cwd) + '/');
  if (!allowed) throw knowledgeError('Documento não pertence ao projeto atual.');
  const file = join(cwd, 'knowledge', id);
  await readDocument(cwd, file);
  await unlink(file);
  return id;
}

export function selectDocuments(documents, selectors, config, cwd) {
  const selected = new Map();
  for (const source of selectors) {
    const selector = source === 'project/current' ? scopeDirectory('project', config, cwd) : source;
    if (selector !== 'global') validateId(selector);
    const matches = documents.filter(({ id }) => id === selector ||
      id.startsWith(selector + '/') || id === selector + '.md' || id === selector + '.txt');
    if (!matches.length) throw knowledgeError('Fonte de knowledge não encontrada: ' + source, 'KNOWLEDGE_NOT_FOUND');
    for (const doc of matches) selected.set(doc.id, doc);
  }
  return [...selected.values()];
}