import { parseCommand, validRef, validPath } from '../shell/command-parser.js';
import { assertPermissions } from './permission-manager.js';
import { policyError } from './policies.js';

export function guardCommand(argv, config) {
  const { command, args } = parseCommand(argv);
  const [verb, ...rest] = args;
  const operation = { command, args, localWrite: false, remote: false, remoteWrite: false };
  const deny = (message = 'argumentos ou comando Git não suportados.') => { throw policyError(message); };
  const only = (values) => rest.every((arg) => values.includes(arg));

  switch (verb) {
    case 'status':
      if (!only(['--short', '-s', '--branch', '-b', '--porcelain', '--porcelain=v1'])) deny();
      break;
    case 'diff': {
      const separator = rest.indexOf('--');
      const flags = separator === -1 ? rest : rest.slice(0, separator);
      const paths = separator === -1 ? [] : rest.slice(separator + 1);
      if (!flags.every((arg) => ['--cached', '--staged', '--stat', '--name-only', '--name-status', '--check'].includes(arg)) ||
          !paths.every(validPath)) deny();
      break;
    }
    case 'log':
      if (!rest.every((arg) => ['--oneline', '--all', '--decorate'].includes(arg) ||
        /^--max-count=[1-9][0-9]{0,3}$/.test(arg))) deny();
      break;
    case 'branch':
      if (!rest.length || only(['--show-current', '--list', '-a', '-r'])) break;
      if (rest.length !== 1 || !validRef(rest[0])) deny('somente listagem e criação de uma branch são suportadas.');
      operation.localWrite = true;
      break;
    case 'add': {
      const paths = rest[0] === '--' ? rest.slice(1) : rest;
      if (!paths.length || !paths.every(validPath)) deny('git add requer caminhos relativos ao projeto.');
      operation.localWrite = true;
      break;
    }
    case 'commit':
      if (rest.length !== 2 || rest[0] !== '-m' || !rest[1].trim()) deny('use git commit -m "mensagem".');
      operation.localWrite = true;
      break;
    case 'remote':
      if (!only(['-v', '--verbose'])) deny('somente git remote [-v] é suportado.');
      break;
    case 'fetch':
    case 'ls-remote':
      if (rest.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(rest[0])) deny('informe exatamente um remote configurado, como origin.');
      operation.remote = true;
      operation.localWrite = verb === 'fetch';
      operation.remoteName = rest[0];
      break;
    case 'push': {
      operation.remote = true;
      operation.remoteWrite = true;
      const flags = rest.filter((arg) => arg.startsWith('-'));
      if (flags.some((arg) => !['--force', '-f', '--force-with-lease', '--delete', '-d'].includes(arg))) {
        deny('push em massa, flags desconhecidas e refspecs implícitos não são permitidos.');
      }
      const positional = rest.filter((arg) => !arg.startsWith('-'));
      if (positional.length !== 2 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(positional[0])) {
        deny('use git push <remote> <origem>:<destino> ou git push <remote> <branch>.');
      }
      operation.remoteName = positional[0];
      let refspec = positional[1];
      const force = flags.some((arg) => ['--force', '-f', '--force-with-lease'].includes(arg)) || refspec.startsWith('+');
      if (refspec.startsWith('+')) refspec = refspec.slice(1);
      const parts = refspec.split(':');
      if (parts.length > 2) deny('refspec inválido.');
      const deleting = flags.includes('--delete') || flags.includes('-d') || parts[0] === '';
      if (deleting && parts.length === 2 && parts[0] !== '') deny('exclusão requer somente a referência de destino.');
      const source = deleting ? '' : parts[0];
      const target = parts.at(-1);
      if (!validRef(target) || (source && !validRef(source))) deny('referências explícitas sem curingas são obrigatórias.');
      const destination = target.startsWith('refs/') ? target : 'refs/heads/' + target;
      if (!destination.startsWith('refs/heads/') && !destination.startsWith('refs/tags/')) deny('namespace de referência não suportado.');
      if (destination === 'refs/heads/' || destination === 'refs/tags/') deny();
      const protection = config.git.protection;
      if (force && !protection.forcePush) deny('force push desabilitado.');
      if (destination === 'refs/heads/main' && !protection.pushMain) deny('branch main protegida.');
      if (destination === 'refs/heads/develop' && !protection.pushDevelop) deny('branch develop protegida.');
      if (deleting && !protection[destination.startsWith('refs/tags/') ? 'deleteRemoteTag' : 'deleteRemoteBranch']) {
        deny('exclusão de referências remotas desabilitada.');
      }
      operation.refspec = (force && !flags.includes('--force-with-lease') ? '+' : '') + source + ':' + destination;
      operation.lease = flags.includes('--force-with-lease');
      break;
    }
    default:
      deny('comando Git não suportado; aliases, opções globais, pull, reset, clean, execução de scripts e operações ambíguas são bloqueados.');
  }
  assertPermissions(config, operation);
  return operation;
}