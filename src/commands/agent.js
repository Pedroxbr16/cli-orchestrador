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

export async function agentsCommand({ cwd = process.cwd() } = {}) {
  await checkAccess(cwd);
  console.log('Engines: codex, opencode');
  const entries = await listAgents({ cwd });
  if (!entries.length) console.log('Nenhum agent personalizado. Use oraculo agent create <nome>.');
  for (const entry of entries) {
    console.log(entry.error ? '[ERRO] ' + entry.name + ': ' + entry.error :
      entry.name + ' | ' + entry.agent.engine + ' | ' + entry.agent.role + ' | ' + entry.agent.description);
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
  // Fase 10: apenas Codex read-only executa; o resto segue bloqueado.
  const write = context.permissions.filesystem === 'read-write' || context.permissions.gitLocal === 'read-write';
  const result = { ...agent, effectivePermissions: context.permissions,
    execution: agent.engine === 'codex' && !write ? 'read-only' : 'blocked', knowledgeLoaded: false };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function runAgentCommand(name, promptParts, { cwd = process.cwd() } = {}) {
  return runAgent({ agent: name, prompt: promptParts.join(' '), cwd });
}

const UPDATABLE = ['engine', 'role', 'model', 'description'];

export async function updateAgentCommand(name, { cwd = process.cwd(), engine, role, model, description, clearModel = false } = {}) {
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
  if (clearModel) {
    if (model !== undefined) throw new Error('Use --model ou --clear-model, não ambos.');
    patch.model = undefined;
  }
  const fields = Object.keys(patch);
  if (!fields.length) throw new Error('Nada para atualizar: informe --engine, --role, --model, --description ou --clear-model.');
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
  console.log(JSON.stringify(report, null, 2));
  return report;
}
export async function previewAgentContext(name, promptParts, { cwd = process.cwd() } = {}) {
  const { context } = await prepareAgentRun({ agent: name, prompt: promptParts.join(' '), cwd });
  console.log(JSON.stringify(context, null, 2));
  return context;
}