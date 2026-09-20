export function policyError(message, code = 'GIT_POLICY_DENIED') {
  const error = new Error(`Operação bloqueada pela política do projeto: ${message}`);
  error.code = code;
  return error;
}

export function requireAccess(level, write, label) {
  if (level === 'disabled' || (write && level !== 'read-write')) {
    throw policyError(`${label}=${level}; operação requer ${write ? 'read-write' : 'leitura'}.`);
  }
}