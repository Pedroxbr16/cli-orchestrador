import { assertAgentExecution } from '../../permissions/permission-manager.js';

export class OpenCodeAdapter {
  constructor() {
    this.name = 'OpenCode';
    this.command = 'opencode';
  }

  async run() {
    assertAgentExecution(this.name);
  }
}