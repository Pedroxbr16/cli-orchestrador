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
  // Fase 10 libera apenas Codex SOMENTE LEITURA, com sandbox read-only,
  // approval never e verificação pós-execução dentro do adapter. Todo o
  // resto continua bloqueado: OpenCode sempre, e qualquer engine com escrita.
  if (engine === 'Codex' && !write) return;
  const reason = engine === 'Codex'
    ? 'escrita ainda indisponível: use perfil read-only (filesystem e Git local).'
    : 'integração segura ainda indisponível. O ask está bloqueado porque o Oraculo não pode garantir as permissões dentro deste CLI. Use oraculo exec -- git ... para operações controladas.';
  throw policyError(`${engine}: ${reason}`, 'AGENT_POLICY_UNSUPPORTED');
}