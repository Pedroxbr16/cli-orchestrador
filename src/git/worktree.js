import { lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { assertPermissions } from '../permissions/permission-manager.js';
import { policyError } from '../permissions/policies.js';
import { validRef } from '../shell/command-parser.js';
import { runGit } from './git-manager.js';
import { preparePipeline } from '../orchestrator/pipeline.js';

// Fase 9 — Worktrees: isolamento Git para futura execução paralela.
// Este módulo nunca inicia engines (Codex/OpenCode); apenas planeja e
// gerencia checkouts extras. A execução de agentes continua bloqueada
// pela Fase 3 (AGENT_POLICY_UNSUPPORTED).
const ROOT_DIR = 'worktrees';
const namePattern = /^[a-z][a-z0-9-]{0,63}$/;

export function validateWorktreeName(name) {
  if (typeof name !== 'string' || !namePattern.test(name)) {
    throw policyError('nome de worktree inválido: use letras minúsculas, números e hífens, começando com letra (até 64 caracteres).');
  }
  return name;
}

export function validateWorktreeBranch(branch) {
  if (typeof branch !== 'string' || !validRef(branch)) {
    throw policyError('branch inválida para worktree: use referência explícita sem "..", "//" ou sufixos ".lock".');
  }
  return branch;
}

// O path deriva do nome validado: travessia e caminhos externos são
// impossíveis por construção, mas a contenção é verificada mesmo assim.
export function worktreePath(cwd, name) {
  validateWorktreeName(name);
  const absoluteRoot = resolve(cwd);
  const path = resolve(absoluteRoot, ROOT_DIR, name);
  const rel = relative(absoluteRoot, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw policyError('caminho de worktree fora do projeto.');
  return path;
}

async function ensureParentNotSymlink(cwd) {
  const dir = resolve(cwd, ROOT_DIR);
  try {
    if ((await lstat(dir)).isSymbolicLink()) throw policyError('pasta worktrees não pode ser symlink: ' + dir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

function gitError(action, result) {
  const detail = (result.stderr || '').trim().split(/\r?\n/)[0] || 'sem detalhes';
  const error = new Error(`git worktree ${action} falhou (código ${result.exitCode ?? result.code ?? 'desconhecido'}): ${detail}`);
  error.code = result.code ?? 'GIT_WORKTREE_FAILED';
  return error;
}

function parsePorcelain(stdout) {
  const entries = [];
  let current = null;
  const flush = () => {
    if (current) entries.push(current);
    current = null;
  };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    const space = line.indexOf(' ');
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? '' : line.slice(space + 1);
    if (key === 'worktree') {
      flush();
      current = { path: value, head: null, branch: null, bare: false, detached: false };
    } else if (!current) {
      continue;
    } else if (key === 'HEAD') {
      current.head = value;
    } else if (key === 'branch') {
      current.branch = value;
    } else if (key === 'bare') {
      current.bare = true;
    } else if (key === 'detached') {
      current.detached = true;
    }
  }
  flush();
  return entries;
}

export async function listWorktrees({ cwd = process.cwd() } = {}) {
  const config = await loadConfig({ cwd });
  assertPermissions(config, { localWrite: false });
  const result = await runGit({ args: ['worktree', 'list', '--porcelain'] }, { cwd, timeout: config.runtime.timeout });
  if (!result.success) throw gitError('list', result);
  return parsePorcelain(result.stdout);
}

export async function createWorktree(name, { cwd = process.cwd(), branch, dryRun = false } = {}) {
  const config = await loadConfig({ cwd });
  validateWorktreeName(name);
  const targetBranch = branch === undefined ? `wt/${name}` : validateWorktreeBranch(branch);
  const path = worktreePath(cwd, name);
  await ensureParentNotSymlink(cwd);
  assertPermissions(config, { localWrite: true });
  const plan = { name, path: relative(resolve(cwd), path), branch: targetBranch };
  if (dryRun) return { dryRun: true, ...plan };
  try {
    await lstat(path);
    throw policyError(`worktree já existe; nada foi criado: ${name}`);
  } catch (error) {
    if (error.code === 'GIT_POLICY_DENIED') throw error;
    if (error.code !== 'ENOENT') throw error;
  }
  // Sempre cria uma branch nova (-b): reutilizar branch existente falha com
  // erro explícito do Git em vez de comportamento ambíguo.
  const result = await runGit({ args: ['worktree', 'add', '-b', targetBranch, '--', path] }, { cwd, timeout: config.runtime.timeout });
  if (!result.success) throw gitError('add', result);
  return { ...plan, created: true };
}

export async function removeWorktree(name, { cwd = process.cwd(), force = false, dryRun = false } = {}) {
  const config = await loadConfig({ cwd });
  validateWorktreeName(name);
  const path = worktreePath(cwd, name);
  assertPermissions(config, { localWrite: true });
  const plan = { name, path: relative(resolve(cwd), path), force };
  if (dryRun) return { dryRun: true, ...plan };
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') throw policyError(`worktree não encontrada: ${name}`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw policyError('worktree não pode ser symlink: ' + path);
  // O checkout principal (cwd) nunca está sob worktrees/<nome> por construção,
  // então remove nunca apaga a raiz do repositório.
  const result = await runGit(
    { args: ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path] },
    { cwd, timeout: config.runtime.timeout },
  );
  if (!result.success) throw gitError('remove', result);
  return { ...plan, removed: true };
}

export async function removeWorktreeBranch(branch, { cwd = process.cwd(), timeout = 300000 } = {}) {
  // Restricted to ephemeral wt/* branches created by createWorktree.
  if (typeof branch !== 'string' || branch !== validateWorktreeBranch(branch) || !branch.startsWith('wt/')) {
    throw policyError('somente branches efêmeras wt/* podem ser removidas pelo Oraculo.');
  }
  const result = await runGit({ args: ['branch', '-D', branch] }, { cwd, timeout });
  if (!result.success) throw gitError('branch -D', result);
  return { branch, deleted: true };
}

// Planejamento puro: combina os steps do pipeline com um worktree por etapa
// (worktrees/<agent>-<índice>), sem criar diretórios, branches ou processos.
export async function planWorktrees(task, { cwd = process.cwd(), file } = {}) {
  if (typeof task !== 'string' || !task.trim() || task.length > 4096) {
    throw new Error('Tarefa deve ter de 1 a 4096 caracteres.');
  }
  const plan = await preparePipeline(task, { cwd, file });
  const assignments = plan.steps.map((step, index) => ({
    step: index,
    agent: step.agent,
    engine: step.context.engine,
    input: step.input ?? null,
    output: step.output,
    worktree: `${ROOT_DIR}/${step.agent}-${index}`,
  }));
  return { task, pipeline: plan.name, execution: 'blocked-until-secure-engine', assignments };
}
