const levels = ['disabled', 'read-only', 'read-write'];

export function buildAgentContext(agent, task, config) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('O prompt não pode estar vazio.');
  const permissions = Object.fromEntries(Object.entries(config.permissions).map(([key, projectLevel]) => [
    key, levels[Math.min(levels.indexOf(projectLevel), levels.indexOf(agent.permissions[key] ?? projectLevel))],
  ]));
  return {
    agent: agent.name, engine: agent.engine, model: agent.model ?? null, role: agent.role,
    instructions: agent.promptText, task,
    skills: [...agent.skills],
    knowledge: { requested: [...agent.knowledge], loaded: false },
    permissions,
    git: structuredClone(config.git),
    runtime: structuredClone(config.runtime),
  };
}