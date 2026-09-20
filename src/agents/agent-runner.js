import { listMemory } from '../memory/memory-manager.js';
import { loadConfig } from '../config/loader.js';
import { AgentManager } from './agent-manager.js';
import { buildAgentContext } from './agent-context.js';
import { assertAgentExecution } from '../permissions/permission-manager.js';
import { requireAccess } from '../permissions/policies.js';
import { listDocuments, selectDocuments } from '../knowledge/knowledge-manager.js';
import { searchDocuments } from '../knowledge/retriever.js';
import { automaticKnowledgeDocuments, extractAgentKnowledge, persistAgentKnowledge } from '../knowledge/agent-knowledge.js';
import { appendAudit } from '../logger/audit.js';

export async function prepareAgentRun({ agent, prompt, cwd = process.cwd() }) {
  const config = await loadConfig({ cwd });
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('O prompt não pode estar vazio.');
  requireAccess(config.permissions.filesystem, false, 'filesystem');
  const resolved = await new AgentManager().resolveAgent(agent ?? config.agents.default, { cwd });
  const definition = resolved.definition ?? {
    name: resolved.adapter.command, engine: resolved.adapter.command, role: 'general',
    promptText: '', permissions: {}, skills: [], knowledge: [], knowledgeWrite: 'disabled',
  };
  const context = buildAgentContext(definition, prompt, config);
  const automaticEnabled = context.knowledgeWrite !== 'disabled' &&
    context.permissions.filesystem !== 'disabled';
  if (definition.knowledge.length || automaticEnabled) {
    if (definition.knowledge.length) {
      requireAccess(context.permissions.filesystem, false, 'filesystem do agent');
    }
    const allDocuments = await listDocuments({ cwd });
    const selected = definition.knowledge.length
      ? selectDocuments(allDocuments, definition.knowledge, config, cwd)
      : [];
    const combined = new Map(selected.map((document) => [document.id, document]));
    if (automaticEnabled) {
      for (const document of automaticKnowledgeDocuments(allDocuments, definition.name)) {
        combined.set(document.id, document);
      }
    }
    const documents = [...combined.values()];
    context.knowledge = {
      requested: [...definition.knowledge],
      automatic: automaticEnabled,
      loaded: true,
      sources: documents.map(({ id }) => id),
      snippets: searchDocuments(documents, prompt),
      trust: 'reference-data',
    };
  } else {
    context.knowledge = {
      requested: [...definition.knowledge],
      automatic: false,
      loaded: true,
      sources: [],
      snippets: [],
      trust: 'reference-data',
    };
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
  const result = await prepared.adapter.run(prepared.context.task, {
    cwd: options.cwd, context: prepared.context, cancelSignal: options.cancelSignal,
  });
  const extracted = extractAgentKnowledge(result.output, {
    mode: prepared.context.knowledgeWrite,
  });
  const knowledge = { written: [], errors: [...extracted.errors] };
  if (extracted.entries.length) {
    try {
      knowledge.written = await persistAgentKnowledge(extracted.entries, {
        cwd: options.cwd,
        agent: prepared.context.agent,
      });
      try {
        await appendAudit({
          agent: prepared.context.agent,
          engine: prepared.context.engine,
          status: 'knowledge-written',
          documents: knowledge.written,
        }, { cwd: options.cwd });
      } catch {
        // A resposta e o knowledge gravado não são perdidos por falha de auditoria.
      }
    } catch (error) {
      knowledge.errors.push(String(error.message).slice(0, 300));
    }
  }
  return {
    ...result,
    output: extracted.output || (knowledge.written.length ? 'Conhecimento registrado.' : result.output),
    knowledge,
  };
}