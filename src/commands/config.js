import { access, lstat, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/loader.js';
import { configSchema } from '../config/schema.js';
import { requireAccess } from '../permissions/policies.js';
import { safePath } from '../knowledge/knowledge-manager.js';

async function source(cwd) {
  try {
    await access(join(cwd, 'oraculo.config.json'));
    return 'oraculo.config.json';
  } catch (error) {
    if (error.code === 'ENOENT') return 'defaults (arquivo ausente)';
    throw error;
  }
}

export async function configCommand(path, { cwd = process.cwd() } = {}) {
  const config = await loadConfig({ cwd });
  requireAccess(config.permissions.filesystem, false, 'filesystem');
  if (path === undefined) {
    const report = { source: await source(cwd), config };
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  let value = config;
  for (const part of splitPath(path)) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) {
      throw new Error(`Caminho de configuração desconhecido: ${path}`);
    }
    value = value[part];
  }
  console.log(JSON.stringify(value, null, 2));
  return value;
}

const PATH_PATTERN = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function splitPath(path) {
  if (typeof path !== 'string' || !PATH_PATTERN.test(path)) {
    throw new Error('Caminho inválido: use segmentos separados por ponto, como permissions.gitLocal.');
  }
  const parts = path.split('.');
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part))) {
    throw new Error(`Caminho de configuração desconhecido: ${path}`);
  }
  return parts;
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function readRaw(cwd) {
  const file = resolve(cwd, 'oraculo.config.json');
  await safePath(cwd, file, { missing: true });
  try {
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error('oraculo.config.json não pode ser symlink.');
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) {
      const configError = new Error(`Configuração inválida em ${file}:\nJSON inválido. Verifique aspas, vírgulas e chaves.`);
      configError.code = 'CONFIG_INVALID';
      throw configError;
    }
    throw error;
  }
}

async function writeRaw(cwd, data) {
  const file = resolve(cwd, 'oraculo.config.json');
  await safePath(cwd, file, { missing: true });
  const result = configSchema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((issue) =>
      `${issue.path.join('.') || 'config'}: ${issue.message}`).join('\n');
    const error = new Error(`Valor rejeitado pela configuração:\n${details}`);
    error.code = 'CONFIG_INVALID';
    throw error;
  }
  const temporary = resolve(cwd, `.oraculo.config.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  return result.data;
}

export async function configSetCommand(path, raw, { cwd = process.cwd() } = {}) {
  const config = await loadConfig({ cwd });
  requireAccess(config.permissions.filesystem, true, 'filesystem');
  const parts = splitPath(path);
  const data = await readRaw(cwd);
  let node = data;
  for (const part of parts.slice(0, -1)) {
    if (node[part] === undefined) node[part] = {};
    if (node[part] === null || typeof node[part] !== 'object' || Array.isArray(node[part])) {
      throw new Error(`Caminho de configuração desconhecido: ${path}`);
    }
    node = node[part];
  }
  node[parts.at(-1)] = parseValue(raw);
  const effective = await writeRaw(cwd, data);
  const report = { path, value: parts.reduce((acc, part) => acc[part], effective), source: 'oraculo.config.json' };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

export async function configUnsetCommand(path, { cwd = process.cwd() } = {}) {
  const config = await loadConfig({ cwd });
  requireAccess(config.permissions.filesystem, true, 'filesystem');
  const parts = splitPath(path);
  const data = await readRaw(cwd);
  let node = data;
  for (const part of parts.slice(0, -1)) {
    if (node[part] === undefined) {
      const report = { path, unset: true, unchanged: true, source: 'oraculo.config.json' };
      console.log(JSON.stringify(report, null, 2));
      return report;
    }
    if (node[part] === null || typeof node[part] !== 'object') {
      throw new Error(`Caminho de configuração desconhecido: ${path}`);
    }
    node = node[part];
  }
  delete node[parts.at(-1)];
  // Poda objetos esvaziados (ex: project: {} inválido sem name), de dentro para fora.
  for (let depth = parts.length - 1; depth >= 1; depth--) {
    const parent = parts.slice(0, depth - 1).reduce((acc, part) => acc?.[part], data);
    const key = parts[depth - 1];
    const child = parent?.[key];
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.keys(child).length === 0) {
      delete parent[key];
    } else {
      break;
    }
  }
  await writeRaw(cwd, data);
  const report = { path, unset: true, source: 'oraculo.config.json' };
  console.log(JSON.stringify(report, null, 2));
  return report;
}
