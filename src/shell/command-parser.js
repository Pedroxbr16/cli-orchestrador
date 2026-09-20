import { policyError } from '../permissions/policies.js';

// argv only: never interpret shell syntax or expand variables.
export function parseCommand(argv) {
  if (!Array.isArray(argv) || !argv.length ||
      argv.some((part) => typeof part !== 'string' || part.includes('\0'))) {
    throw policyError('forneça um executável e argumentos separados.', 'COMMAND_INVALID');
  }
  if (argv[0] !== 'git') {
    throw policyError('somente operações Git explicitamente suportadas são permitidas; shells, wrappers e outros executáveis são bloqueados.', 'COMMAND_DENIED');
  }
  return { command: 'git', args: argv.slice(1) };
}

export function validRef(value) {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.includes('..') && !value.includes('//') &&
    !value.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock')) &&
    !value.endsWith('/') && !value.endsWith('.');
}

export function validPath(value) {
  return typeof value === 'string' && value.length > 0 &&
    !value.startsWith('-') && !value.startsWith('/') &&
    !/[\\:\0\r\n]/.test(value) &&
    !value.split('/').some((part) => part === '..' || part.toLowerCase() === '.git');
}