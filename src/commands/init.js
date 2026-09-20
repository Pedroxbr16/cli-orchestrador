import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { defaults } from '../config/defaults.js';
import { requireAccess, policyError } from '../permissions/policies.js';

// oraculo init: cria a estrutura base sem sobrescrever nada existente.
// Arquivos e pastas presentes são apenas relatados; symlinks no lugar de
// pastas e arquivos regulares no lugar de pastas são recusados.
const DIRS = [
  'agents',
  'knowledge/global',
  'knowledge/projects',
  '.oraculo/sessions',
  '.oraculo/memory',
  '.oraculo/cache',
  '.oraculo/logs',
  '.oraculo/tasks',
];

async function ensureDir(cwd, rel, report, dryRun) {
  const root = resolve(cwd);
  if (relative(root, resolve(root, rel)).startsWith('..')) throw policyError('caminho de init fora do projeto.');
  // Inspeciona cada nível: symlink intermediário ou arquivo no caminho
  // também é recusado, não só o destino final.
  let current = root;
  let missing = false;
  for (const part of rel.split('/')) {
    current = join(current, part);
    if (missing) continue;
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing = true;
      continue;
    }
    if (stat.isSymbolicLink()) throw policyError(`symlink não esperado em init: ${rel}`);
    if (!stat.isDirectory()) throw policyError(`init não sobrescreve arquivo existente: ${rel}`);
  }
  if (missing && !dryRun) await mkdir(resolve(cwd, rel), { recursive: true });
  report[missing ? 'created' : 'existing'].push(rel + '/');
}

async function ensureConfig(cwd, report, dryRun) {
  const rel = 'oraculo.config.json';
  const path = resolve(cwd, rel);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!dryRun) await writeFile(path, JSON.stringify(defaults, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    report.created.push(rel);
    return;
  }
  if (stat.isSymbolicLink()) throw policyError(`symlink não esperado em init: ${rel}`);
  report.existing.push(rel);
}

export async function initCommand({ cwd = process.cwd(), dryRun = false } = {}) {
  const config = await loadConfig({ cwd });
  requireAccess(config.permissions.filesystem, true, 'filesystem');
  const report = { dryRun, created: [], existing: [] };
  await ensureConfig(cwd, report, dryRun);
  for (const dir of DIRS) await ensureDir(cwd, dir, report, dryRun);
  console.log(JSON.stringify(report, null, 2));
  return report;
}
