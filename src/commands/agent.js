import { createAgent, listAgents, loadAgent, agentSchema } from '../agents/agent-loader.js';
import { lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig } from '../config/loader.js';
import { requireAccess } from '../permissions/policies.js';
import { buildAgentContext } from '../agents/agent-context.js';
import { runAgent, prepareAgentRun } from '../agents/agent-runner.js';

async function checkAccess(cwd, write = false) {
  const config = await loadConfig({ cwd });
  requireAccess(config.permissions.filesystem, write, 'filesystem');
  return config;
}

export const REASONING_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh']);

export const ENGINE_OPTIONS = Object.freeze([
  {
    id: 'codex',
    models: ['default', '<model-id>'],
    discovery: 'abra o Codex e use /model para ver os modelos disponíveis na conta',
  },
  {
    id: 'claude',
    models: ['default', 'sonnet', 'opus', 'haiku', '<model-id>'],
    discovery: 'aceita aliases ou o ID completo suportado pelo Claude Code',
  },
  {
    id: 'opencode',
    models: ['default', '<provider>/<model>'],
    discovery: 'execute opencode models para listar os modelos dos provedores conectados',
  },
]);

export function agentOptionsCommand({ print = true } = {}) {
  const report = {
    engines: ENGINE_OPTIONS.map((entry) => ({ ...entry, models: [...entry.models] })),
    reasoningEfforts: [...REASONING_EFFORTS],
  };
  if (print) console.log(JSON.stringify(report, null, 2));
  return report;
}

export async function agentsCommand({ cwd = process.cwd() } = {}) {
  await checkAccess(cwd);
  console.log('Engines: codex, claude, opencode');
  console.log('Modelos: use oraculo agent options para formatos e descoberta.');
  const entries = await listAgents({ cwd });
  if (!entries.length) console.log('Nenhum agent personalizado. Use oraculo agent create <nome>.');
  for (const entry of entries) {
    console.log(entry.error ? '[ERRO] ' + entry.name + ': ' + entry.error :
      entry.name + ' | role=' + entry.agent.role +
      ' | engine=' + entry.agent.engine +
      ' | model=' + (entry.agent.model ?? 'default') +
      ' | effort=' + (entry.agent.reasoningEffort ?? 'default') +
      ' | ' + entry.agent.description);
  }
  return { success: entries.every((entry) => !entry.error), entries };
}

export async function createAgentCommand(name, { cwd = process.cwd(), ...options } = {}) {
  await checkAccess(cwd, true);
  const agent = await createAgent(name, { cwd, ...options });
  console.log('Agent criado: agents/' + agent.name + '/ (agent.yaml e prompt.md)');
  return agent;
}

export async function showAgentCommand(name, { cwd = process.cwd() } = {}) {
  const config = await checkAccess(cwd);
  const agent = await loadAgent(name, { cwd });
  const context = buildAgentContext(agent, 'prévia', config);
  // Codex e Claude Code executam apenas perfis read-only.
  const write = context.permissions.filesystem === 'read-write' || context.permissions.gitLocal === 'read-write';
  const result = { ...agent, effectivePermissions: context.permissions,
    execution: ['codex', 'claude'].includes(agent.engine) && !write ? 'read-only' : 'blocked', knowledgeLoaded: false };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function runAgentCommand(name, promptParts, { cwd = process.cwd() } = {}) {
  return runAgent({ agent: name, prompt: promptParts.join(' '), cwd });
}

const UPDATABLE = ['engine', 'role', 'model', 'reasoningEffort', 'description'];

export async function updateAgentCommand(name, {
  cwd = process.cwd(),
  engine,
  role,
  model,
  reasoningEffort,
  description,
  clearModel = false,
  clearReasoningEffort = false,
  print = true,
} = {}) {
  await checkAccess(cwd, true);
  let current;
  try {
    const { promptText: _promptText, ...loaded } = await loadAgent(name, { cwd });
    current = loaded;
  } catch (error) {
    throw new Error(`Agente "${name}" não encontrado ou inválido: ${error.message}`);
  }
  const patch = {};
  if (engine !== undefined) patch.engine = engine;
  if (role !== undefined) patch.role = role;
  if (description !== undefined) patch.description = description;
  if (model !== undefined) patch.model = model;
  if (reasoningEffort !== undefined) patch.reasoningEffort = reasoningEffort;
  if (clearModel) {
    if (model !== undefined) throw new Error('Use --model ou --clear-model, não ambos.');
    patch.model = undefined;
  }
  if (clearReasoningEffort) {
    if (reasoningEffort !== undefined) {
      throw new Error('Use --reasoning-effort ou --clear-reasoning-effort, não ambos.');
    }
    patch.reasoningEffort = undefined;
  }
  const fields = Object.keys(patch);
  if (!fields.length) {
    throw new Error(
      'Nada para atualizar: informe --engine, --role, --model, --reasoning-effort, ' +
      '--description, --clear-model ou --clear-reasoning-effort.',
    );
  }
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  const parsed = agentSchema.parse(next);
  const file = join(cwd, 'agents', name, 'agent.yaml');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('agent.yaml precisa ser arquivo regular sem symlink.');
  await writeFile(file, stringify(parsed), { encoding: 'utf8', mode: 0o600 });
  const report = { name, updated: fields, agent: parsed };
  if (print) console.log(JSON.stringify(report, null, 2));
  return report;
}
export async function previewAgentContext(name, promptParts, { cwd = process.cwd() } = {}) {
  const { context } = await prepareAgentRun({ agent: name, prompt: promptParts.join(' '), cwd });
  console.log(JSON.stringify(context, null, 2));
  return context;
}

const ACCESS_LEVELS = ['disabled', 'read-only', 'read-write'];
const KNOWLEDGE_LEVELS = ['disabled', 'project', 'global', 'both'];

export async function agentPermissionsCommand(name, {
  cwd = process.cwd(),
  filesystem,
  gitLocal,
  gitRemote,
  worktree,
  knowledgeWrite,
  print = true,
} = {}) {
  const changes = { filesystem, gitLocal, gitRemote, worktree, knowledgeWrite };
  const writing = Object.values(changes).some((value) => value !== undefined);
  const config = await checkAccess(cwd, writing);
  const { promptText: _promptText, ...current } = await loadAgent(name, { cwd });

  for (const [field, value] of Object.entries({ filesystem, gitLocal, gitRemote, worktree })) {
    if (value !== undefined && !ACCESS_LEVELS.includes(value)) {
      throw new Error(`${field}: use disabled, read-only ou read-write.`);
    }
  }
  if (knowledgeWrite !== undefined && !KNOWLEDGE_LEVELS.includes(knowledgeWrite)) {
    throw new Error('knowledge: use disabled, project, global ou both.');
  }
  if (worktree !== undefined) {
    if (filesystem !== undefined && filesystem !== worktree) {
      throw new Error('--worktree conflita com --filesystem.');
    }
    if (gitLocal !== undefined && gitLocal !== worktree) {
      throw new Error('--worktree conflita com --git-local.');
    }
    filesystem = worktree;
    gitLocal = worktree;
  }

  let parsed = current;
  const updated = [];
  if (writing) {
    const permissions = { ...current.permissions };
    for (const [key, value] of Object.entries({ filesystem, gitLocal, gitRemote })) {
      if (value !== undefined) {
        permissions[key] = value;
        updated.push(key);
      }
    }
    const next = { ...current, permissions };
    if (knowledgeWrite !== undefined) {
      next.knowledgeWrite = knowledgeWrite;
      updated.push('knowledgeWrite');
    }
    parsed = agentSchema.parse(next);
    const file = join(cwd, 'agents', name, 'agent.yaml');
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('agent.yaml precisa ser arquivo regular sem symlink.');
    }
    await writeFile(file, stringify(parsed), { encoding: 'utf8', mode: 0o600 });
  }

  const context = buildAgentContext({ ...parsed, promptText: '' }, 'prévia', config);
  const report = {
    name,
    updated: [...new Set(updated)],
    permissions: parsed.permissions,
    effectivePermissions: context.permissions,
    worktree: context.permissions.filesystem === context.permissions.gitLocal
      ? context.permissions.filesystem
      : 'mixed',
    knowledgeWrite: parsed.knowledgeWrite ?? 'disabled',
  };
  if (print) console.log(JSON.stringify(report, null, 2));
  return report;
}
