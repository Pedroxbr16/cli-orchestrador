import { loadAgent } from './agent-loader.js';
import { CodexAdapter } from './adapters/codex.js';
import { ClaudeCodeAdapter } from './adapters/claude.js';
import { OpenCodeAdapter } from './adapters/opencode.js';

export class AgentManager {
  constructor() {
    this.agents = {
      codex: new CodexAdapter(),
      claude: new ClaudeCodeAdapter(),
      opencode: new OpenCodeAdapter(),
    };
  }

  getAgent(name) {
    const normalizedName = name.toLowerCase();

    const agent = Object.hasOwn(this.agents, normalizedName) ? this.agents[normalizedName] : undefined;

    if (!agent) {
      const availableAgents = Object.keys(this.agents).join(', ');

      throw new Error(
        `Agente "${name}" não encontrado. Disponíveis: ${availableAgents}`
      );
    }

    return agent;
  }

  async resolveAgent(name, { cwd = process.cwd() } = {}) {
    if (Object.hasOwn(this.agents, name.toLowerCase())) {
      return { adapter: this.getAgent(name) };
    }
    try {
      const definition = await loadAgent(name, { cwd });
      return { definition, adapter: this.getAgent(definition.engine) };
    } catch (error) {
      throw new Error('Agente "' + name + '" não encontrado ou inválido: ' + error.message, { cause: error });
    }
  }

  listAgents() {
    return Object.keys(this.agents);
  }
}