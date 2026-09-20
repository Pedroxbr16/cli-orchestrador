import { listAgents } from '../agents/agent-loader.js';
import { knowledgeSettings } from '../knowledge/knowledge-manager.js';

const normalize = (value) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const intents = {
  architect: ['arquitet', 'architecture', 'planej', 'planning', 'design'],
  developer: ['implement', 'corrig', 'fix', 'desenvolv', 'build', 'endpoint'],
  reviewer: ['revis', 'review', 'regress'],
  security: ['segur', 'security', 'autentic', 'auth', 'oauth', 'ldap', 'vulnerab'],
};

export async function routeTask(task, { cwd = process.cwd(), skills = [] } = {}) {
  if (typeof task !== 'string' || !task.trim() || task.length > 4096) throw new Error('Tarefa deve ter de 1 a 4096 caracteres.');
  if (!Array.isArray(skills) || skills.length > 20 || skills.some((skill) => typeof skill !== 'string' || !skill.trim() || skill.length > 100)) {
    throw new Error('Informe até 20 skills não vazias.');
  }
  const config = await knowledgeSettings(cwd);
  const entries = await listAgents({ cwd });
  const words = normalize(task).match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const required = [...new Set(skills.map(normalize))];
  const candidates = [];
  for (const { agent } of entries) {
    if (!agent) continue;
    const available = agent.skills.map(normalize);
    if (!required.every((skill) => available.includes(skill))) continue;
    const reasons = [];
    let score = required.length * 10;
    if (required.length) reasons.push('skills solicitadas: ' + required.join(', '));
    const mentioned = available.filter((skill) => normalize(task).includes(skill));
    score += mentioned.length * 5;
    if (mentioned.length) reasons.push('skills mencionadas: ' + mentioned.join(', '));
    const matched = (intents[normalize(agent.role)] ?? []).filter((term) => words.some((word) => word.startsWith(term)));
    score += matched.length * 3;
    if (matched.length) reasons.push('intenção compatível com ' + agent.role + ': ' + matched.join(', '));
    candidates.push({
      agent: agent.name,
      engine: agent.engine,
      model: agent.model ?? null,
      reasoningEffort: agent.reasoningEffort ?? null,
      role: agent.role,
      score,
      reasons,
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.agent.localeCompare(b.agent));
  const ignored = entries.filter((entry) => entry.error).map(({ name, error }) => ({ name, error }));
  if (!candidates.length && required.length) throw new Error('Nenhum agent válido possui todas as skills solicitadas.');
  if (candidates[0]?.score > 0) return { selected: candidates[0], candidates, fallback: false, ignored };
  const configured = candidates.find((candidate) => candidate.agent === config.agents.default);
  const fallback = configured ??
    candidates.find((candidate) => normalize(candidate.role) === 'developer') ??
    candidates[0];
  if (!fallback) {
    throw new Error('Nenhum agent personalizado válido está disponível. Defina um perfil em agents/.');
  }
  return {
    selected: {
      ...fallback,
      reasons: [configured
        ? 'sem correspondência; usando agents.default'
        : 'sem correspondência; usando perfil geral'],
    },
    candidates, fallback: true, ignored,
  };
}