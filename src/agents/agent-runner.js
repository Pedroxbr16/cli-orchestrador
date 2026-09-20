import { listMemory } from '../memory/memory-manager.js';
import { loadConfig } from '../config/loader.js';
import { AgentManager } from './agent-manager.js';
import { buildAgentContext } from './agent-context.js';
import { assertAgentExecution } from '../permissions/permission-manager.js';
import { requireAccess } from '../permissions/policies.js';
import { listDocuments, selectDocuments } from '../knowledge/knowledge-manager.js';
import { searchDocuments } from '../knowledge/retriever.js';

export async function prepareAgentRun({ agent, prompt, cwd = process.cwd() }) {
  const config = await loadConfig({ cwd });
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('O prompt não pode estar vazio.');
  requireAccess(config.permissions.filesystem, false, 'filesystem');
  const resolved = await new AgentManager().resolveAgent(agent ?? config.agents.default, { cwd });
  const definition = resolved.definition ?? {
    name: resolved.adapter.command, engine: resolved.adapter.command, role: 'general',
    promptText: '', permissions: {}, skills: [], knowledge: [],
  };
  const context = buildAgentContext(definition, prompt, config);
  if (definition.knowledge.length) {
    requireAccess(context.permissions.filesystem, false, 'filesystem do agent');
    const documents = selectDocuments(await listDocuments({ cwd }), definition.knowledge, config, cwd);
    context.knowledge = {
      requested: [...definition.knowledge], loaded: true,
      sources: documents.map(({ id }) => id),
      snippets: searchDocuments(documents, prompt),
      trust: 'reference-data',
    };
  } else {
    context.knowledge = { requested: [], loaded: true, sources: [], snippets: [], trust: 'reference-data' };
  }
  context.memory = { entries: [], trust: 'reference-data' };
  if (context.permissions.filesystem !== 'disabled') {
    context.memory.entries = (await listMemory({ cwd, limit: 5 })).map((entry) => ({
      ...entry, text: entry.text.slice(0, 600),
      ...(entry.solution ? { solution: entry.solution.slice(0, 300) } : {}),
    }));
  }
  return { context, adapter: resolved.adapter };
}

export async function runAgent(options) {
  const prepared = await prepareAgentRun(options);
  const permissions = prepared.context.permissions;
  const write = permissions.filesystem === 'read-write' || permissions.gitLocal === 'read-write';
  assertAgentExecution(prepared.adapter.name, { write });
  return prepared.adapter.run(prepared.context.task, {
    cwd: options.cwd, context: prepared.context, cancelSignal: options.cancelSignal,
  });
}