import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { devNull } from 'node:os';
import { runProcess } from '../shell/process.js';
import { policyError } from '../permissions/policies.js';

const settings = [
  'core.hooksPath=' + devNull, 'core.fsmonitor=false', 'core.untrackedCache=false',
  'core.pager=cat', 'credential.helper=', 'credential.interactive=false',
  'commit.gpgSign=false', 'tag.gpgSign=false', 'log.showSignature=false',
  'diff.external=', 'diff.ignoreSubmodules=all', 'submodule.recurse=false',
  'fetch.recurseSubmodules=false', 'push.recurseSubmodules=no',
  'push.followTags=false', 'push.gpgSign=false', 'gc.auto=0', 'maintenance.auto=false',
];
const prefix = ['--no-pager', ...settings.flatMap((setting) => ['-c', setting])];

export function gitEnvironment() {
  // Do not inherit GIT_CONFIG_COUNT, GIT_DIR, GIT_WORK_TREE, SSH commands or askpass.
  const env = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'TMPDIR', 'TMP', 'TEMP']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    ...env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'https',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

export async function runGit(operation, options) {
  const env = gitEnvironment();
  const invoke = (args) => runProcess('git', [...prefix, ...args], { ...options, env });
  const requireResult = async (args) => {
    const result = await invoke(args);
    if (!result.success) {
      const error = new Error('Não foi possível validar o repositório Git (' + (result.code ?? result.exitCode) + ').');
      error.code = result.code ?? 'GIT_VALIDATION_FAILED';
      throw error;
    }
    return result.stdout.trim();
  };
  const root = await realpath(await requireResult(['rev-parse', '--show-toplevel']));
  const cwd = await realpath(options.cwd);
  if (root !== cwd) throw policyError('execute na raiz do repositório para usar a configuração correta do projeto.');
  const gitDir = await realpath(await requireResult(['rev-parse', '--absolute-git-dir']));
  const location = relative(root, gitDir);
  if (!location || location.startsWith('..') || isAbsolute(location)) {
    throw policyError('Git externo à raiz (incluindo worktrees) ainda não é suportado.');
  }

  const common = await realpath(resolve(cwd, await requireResult(['rev-parse', '--git-common-dir'])));
  const commonLocation = relative(root, common);
  if (!commonLocation || commonLocation.startsWith('..') || isAbsolute(commonLocation)) {
    throw policyError('diretório Git compartilhado fora da raiz não é suportado.');
  }

  // Git can spawn programs without shell arguments, e.g. clean/smudge filters.
  const keys = (await requireResult(['config', '--null', '--list', '--name-only'])).split('\0');
  if (keys.some((key) => /^(filter\.|url\.|core\.gitproxy$|remote\..*\.vcs$|extensions\.partialclone$|remote\..*\.promisor$)/i.test(key))) {
    throw policyError('filtros, reescrita de URLs, proxies Git, helpers externos ou partial clones exigem integração específica.');
  }

  let args = [...operation.args];
  if (operation.remote) {
    const command = operation.args[0];
    const lookup = ['remote', 'get-url', '--all'];
    if (command === 'push') lookup.push('--push');
    lookup.push(operation.remoteName);
    const urls = (await requireResult(lookup)).split(/\r?\n/);
    if (urls.length !== 1) throw policyError('remotes com múltiplas URLs não são suportados.');
    let url;
    try { url = new URL(urls[0]); } catch { throw policyError('configure um remote HTTPS válido.'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
      throw policyError('esta fase aceita apenas remotes HTTPS sem credenciais na URL; SSH e transports locais não são suportados.');
    }
    if (command === 'push') {
      args = ['push', '--porcelain', '--no-verify'];
      if (operation.lease) args.push('--force-with-lease');
      args.push(url.href, operation.refspec);
    } else if (command === 'fetch') {
      args = ['fetch', '--no-tags', '--no-recurse-submodules', url.href,
        '+refs/heads/*:refs/remotes/' + operation.remoteName + '/*'];
    } else {
      args = ['ls-remote', url.href];
    }
  } else if (args[0] === 'diff') {
    args.splice(1, 0, '--no-ext-diff', '--no-textconv', '--ignore-submodules=all');
  } else if (args[0] === 'log') {
    args.splice(1, 0, '--no-ext-diff', '--no-textconv', '--no-show-signature');
  } else if (args[0] === 'add') {
    if (args[1] !== '--') args.splice(1, 0, '--');
  }
  return invoke(args);
}