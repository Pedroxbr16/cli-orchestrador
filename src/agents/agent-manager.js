import { CodexAdapter } from './adapters/codex.js';
import { OpenCodeAdapter } from './adapters/opencode.js';

export class AgentManager {
  constructor() {
    this.agents = {
      codex: new CodexAdapter(),
      opencode: new OpenCodeAdapter(),
    };
  }

  getAgent(name) {
    const normalizedName = name.toLowerCase();

    const agent = this.agents[normalizedName];

    if (!agent) {
      const availableAgents = Object.keys(this.agents).join(', ');

      throw new Error(
        `Agente "${name}" não encontrado. Disponíveis: ${availableAgents}`
      );
    }

    return agent;
  }

  listAgents() {
    return Object.keys(this.agents);
  }
}