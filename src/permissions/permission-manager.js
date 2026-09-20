import { policyError, requireAccess } from './policies.js';

export function assertPermissions(config, operation) {
  const permissions = config.permissions;
  requireAccess(permissions.filesystem, operation.localWrite, 'filesystem');
  requireAccess(permissions.gitLocal, operation.localWrite, 'Git local');
  if (operation.remote) {
    requireAccess(permissions.gitRemote, operation.remoteWrite, 'Git remoto');
  }
}

export function assertAgentExecution(engine, { write = false } = {}) {
  // Codex e Claude Code são liberados somente para leitura. Cada adapter
  // aplica o modo restrito do CLI e confirma que a worktree permaneceu limpa.
  const readOnlyEngines = ['Codex', 'Claude Code'];
  if (readOnlyEngines.includes(engine) && !write) return;
  const reason = readOnlyEngines.includes(engine)
    ? 'escrita ainda indisponível: use perfil read-only (filesystem e Git local).'
    : 'integração segura ainda indisponível. O ask está bloqueado porque o Oraculo não pode garantir as permissões dentro deste CLI. Use oraculo exec -- git ... para operações controladas.';
  throw policyError(`${engine}: ${reason}`, 'AGENT_POLICY_UNSUPPORTED');
}