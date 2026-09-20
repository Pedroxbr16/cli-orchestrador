import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardCommand } from '../src/permissions/command-guard.js';
import { configSchema } from '../src/config/schema.js';
import { CodexAdapter } from '../src/agents/adapters/codex.js';
import { OpenCodeAdapter } from '../src/agents/adapters/opencode.js';

const config = (overrides = {}) => configSchema.parse(overrides);
const allow = (argv, settings = config()) => assert.doesNotThrow(() => guardCommand(argv, settings));
const deny = (argv, settings = config()) => assert.throws(() => guardCommand(argv, settings));

test('Git remoto disabled bloqueia todas as operações de rede', () => {
  for (const argv of [
    ['git', 'fetch', 'origin'], ['git', 'ls-remote', 'origin'],
    ['git', 'pull', 'origin', 'feature'], ['git', 'push', 'origin', 'feature'],
    ['git', 'push', '--tags'], ['gh', 'pr', 'create'], ['glab', 'mr', 'create'],
  ]) deny(argv);
  for (const argv of [
    ['git', 'status'], ['git', 'diff'], ['git', 'log', '--oneline'],
    ['git', 'branch'], ['git', 'add', '.'], ['git', 'commit', '-m', 'teste'],
    ['git', 'remote', '-v'],
  ]) allow(argv);
});

test('permissões filesystem, Git local e remoto são independentes', () => {
  const readRemote = config({ permissions: { gitRemote: 'read-only' } });
  allow(['git', 'fetch', 'origin'], readRemote);
  allow(['git', 'ls-remote', 'origin'], readRemote);
  deny(['git', 'push', 'origin', 'feature'], readRemote);
  const localRead = config({ permissions: { gitLocal: 'read-only', gitRemote: 'read-only' } });
  allow(['git', 'status'], localRead);
  allow(['git', 'ls-remote', 'origin'], localRead);
  deny(['git', 'fetch', 'origin'], localRead);
  deny(['git', 'add', '.'], localRead);
  deny(['git', 'branch', 'feature'], localRead);
  deny(['git', 'status'], config({ permissions: { gitLocal: 'disabled' } }));
  deny(['git', 'status'], config({ permissions: { filesystem: 'disabled' } }));
  deny(['git', 'commit', '-m', 'teste'], config({ permissions: { filesystem: 'read-only' } }));
});

test('push exige destino explícito e protege a referência de destino', () => {
  const rw = config({ permissions: { gitRemote: 'read-write' } });
  allow(['git', 'push', 'origin', 'feature'], rw);
  allow(['git', 'push', 'origin', 'HEAD:refs/heads/feature'], rw);
  for (const tail of [
    [], ['origin'], ['origin', 'feature:main'], ['origin', 'HEAD:refs/heads/develop'],
    ['origin', '+feature'], ['origin', 'feature', '-f'],
    ['--force-with-lease', 'origin', 'feature'], ['origin', ':feature'],
    ['origin', '--delete', 'refs/tags/v1'], ['origin', '--delete', 'feature'],
    ['origin', '--mirror'], ['origin', '--all'], ['origin', '--tags'],
    ['origin', 'refs/heads/*:refs/heads/*'], ['origin', 'feature', 'other'],
    ['--receive-pack=sh', 'origin', 'feature'], ['origin', 'feature:refs/other/x'],
  ]) deny(['git', 'push', ...tail], rw);
});

test('proteções só são liberadas por configuração explícita', () => {
  const rw = { permissions: { gitRemote: 'read-write' } };
  allow(['git', 'push', '--force', 'origin', 'feature'], config({
    ...rw, git: { protection: { forcePush: true } },
  }));
  allow(['git', 'push', 'origin', 'feature:main'], config({
    ...rw, git: { protection: { pushMain: true } },
  }));
  allow(['git', 'push', '--delete', 'origin', 'refs/tags/v1'], config({
    ...rw, git: { protection: { deleteRemoteTag: true } },
  }));
  deny(['git', 'push', '--delete', 'origin', 'main'], config({
    ...rw, git: { protection: { deleteRemoteBranch: true } },
  }));
});

test('wrappers, shell, opções executáveis, aliases e caminhos fora são bloqueados', () => {
  for (const argv of [
    ['sh', '-c', 'git push'], ['env', 'git', 'status'], ['/usr/bin/git', 'status'],
    ['git status'], ['git', '-c', 'alias.x=!sh', 'x'], ['git', '-C', '/tmp', 'status'],
    ['git', 's'], ['git', 'status', '&&', 'git', 'push'],
    ['git', 'diff', '--output=/tmp/a'], ['git', 'diff', '--ext-diff'],
    ['git', 'log', '--exec=sh'], ['git', 'branch', '-D', 'feature'],
    ['git', 'add', '../outside'], ['git', 'add', '/tmp/outside'],
    ['git', 'add', '.git/config'], ['git', 'add', '--pathspec-from-file=/tmp/p'],
    ['git', 'commit', '-m', 'teste', '--exec=sh'],
    ['git', 'fetch', 'ext::sh'], ['git', 'fetch', '/tmp/repo'],
  ]) deny(argv);
  // Shell-looking text is safe as a literal commit message; no shell is started.
  allow(['git', 'commit', '-m', 'hello; $(touch injected)']);
});

test('config rejeita timeout inválido e proteções não booleanas', () => {
  for (const value of [0, -1, 1.5, '1000', 2147483648]) {
    assert.equal(configSchema.safeParse({ runtime: { timeout: value } }).success, false);
  }
  assert.equal(configSchema.safeParse({ git: { protection: { forcePush: 'true' } } }).success, false);
});

test('adapters recusam execução fora do contrato da Fase 10', async () => {
  await assert.rejects(new OpenCodeAdapter().run('teste'), { code: 'AGENT_POLICY_UNSUPPORTED' });
  await assert.rejects(new CodexAdapter().run('teste'), { code: 'AGENT_EXECUTION_ERROR' });
  const write = { permissions: { filesystem: 'read-write', gitLocal: 'read-only', gitRemote: 'disabled' } };
  await assert.rejects(new CodexAdapter().run('teste', { context: write }), { code: 'AGENT_POLICY_UNSUPPORTED' });
});