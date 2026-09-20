import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initCommand } from '../src/commands/init.js';
import { configCommand, configSetCommand, configUnsetCommand } from '../src/commands/config.js';

const exec = promisify(execFile);
const cli = resolve('src/cli.js');

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-init-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

const EXPECTED_DIRS = [
  'agents/', 'knowledge/global/', 'knowledge/projects/',
  '.oraculo/sessions/', '.oraculo/memory/', '.oraculo/cache/', '.oraculo/logs/', '.oraculo/tasks/',
];

test('init cria a estrutura base e é idempotente sem sobrescrever', async (t) => {
  const cwd = await fixture(t);
  const first = await initCommand({ cwd });
  assert.equal(first.dryRun, false);
  assert.deepEqual(first.created, ['oraculo.config.json', ...EXPECTED_DIRS]);
  assert.deepEqual(first.existing, []);
  for (const dir of EXPECTED_DIRS) await access(join(cwd, dir));
  const saved = await readFile(join(cwd, 'oraculo.config.json'), 'utf8');
  assert.deepEqual(JSON.parse(saved).permissions,
    { filesystem: 'read-write', gitLocal: 'read-write', gitRemote: 'disabled' });
  await writeFile(join(cwd, 'oraculo.config.json'), '{"agents":{"default":"x"}}');
  await writeFile(join(cwd, 'agents/keep.txt'), 'do usuário');
  const second = await initCommand({ cwd });
  assert.deepEqual(second.created, []);
  assert.ok(second.existing.includes('oraculo.config.json'));
  assert.equal(await readFile(join(cwd, 'oraculo.config.json'), 'utf8'), '{"agents":{"default":"x"}}');
  assert.equal(await readFile(join(cwd, 'agents/keep.txt'), 'utf8'), 'do usuário');
});

test('init dry-run nada cria; symlink e arquivo no lugar de pasta recusam', async (t) => {
  const cwd = await fixture(t);
  const planned = await initCommand({ cwd, dryRun: true });
  assert.equal(planned.dryRun, true);
  assert.equal(planned.created.length, EXPECTED_DIRS.length + 1);
  await assert.rejects(access(join(cwd, 'oraculo.config.json')));
  await mkdir(join(cwd, 'agents'));
  await symlink(join(cwd, 'agents'), join(cwd, 'knowledge'));
  await assert.rejects(initCommand({ cwd }), /symlink/);
  await rm(join(cwd, 'knowledge'));
  await writeFile(join(cwd, '.oraculo'), 'arquivo');
  await assert.rejects(initCommand({ cwd }), /não sobrescreve arquivo/);
});

test('init respeita filesystem read-only do projeto', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'oraculo.config.json'), '{"permissions":{"filesystem":"read-only"}}');
  await assert.rejects(initCommand({ cwd }), { code: 'GIT_POLICY_DENIED' });
  await assert.rejects(access(join(cwd, 'agents')));
});

test('config mostra origem, efetiva e caminho pontilhado com segurança', async (t) => {
  const cwd = await fixture(t);
  const bare = await configCommand(undefined, { cwd });
  assert.equal(bare.source, 'defaults (arquivo ausente)');
  assert.equal(bare.config.agents.default, 'opencode');
  await writeFile(join(cwd, 'oraculo.config.json'), '{"agents":{"default":"x"},"runtime":{"timeout":1000}}');
  const filed = await configCommand(undefined, { cwd });
  assert.equal(filed.source, 'oraculo.config.json');
  assert.equal(await configCommand('permissions.gitLocal', { cwd }), 'read-write');
  assert.equal(await configCommand('runtime.timeout', { cwd }), 1000);
  await assert.rejects(configCommand('permissions.inexistente', { cwd }), /desconhecido/);
  await assert.rejects(configCommand('constructor', { cwd }), /desconhecido/);
  await assert.rejects(configCommand('a..b', { cwd }), /inválido/);
  await assert.rejects(configCommand('', { cwd }), /inválido/);
});

test('CLI init e config em JSON válido', async (t) => {  const cwd = await fixture(t);
  const run = (args) => exec(process.execPath, [cli, ...args], { cwd });
  const planned = JSON.parse((await run(['init', '--dry-run'])).stdout);
  assert.equal(planned.dryRun, true);
  assert.ok(planned.created.includes('oraculo.config.json'));
  await assert.rejects(access(join(cwd, 'agents')));
  await run(['init']);
  await access(join(cwd, '.oraculo/logs/'));
  const shown = JSON.parse((await run(['config'])).stdout);
  assert.equal(shown.source, 'oraculo.config.json');
  assert.equal(JSON.parse((await run(['config', 'agents.default'])).stdout), 'opencode');
  await assert.rejects(run(['config', 'nao.existe']), /desconhecido/);
});

test('config set grava todos os tipos com validação e sem perda', async (t) => {
  const cwd = await fixture(t);
  assert.equal((await configSetCommand('agents.default', 'dev', { cwd })).value, 'dev');
  assert.equal((await configSetCommand('runtime.timeout', '1000', { cwd })).value, 1000);
  assert.equal((await configSetCommand('git.protection.forcePush', 'true', { cwd })).value, true);
  assert.equal((await configSetCommand('project.name', 'meu-projeto', { cwd })).value, 'meu-projeto');
  const raw = JSON.parse(await readFile(join(cwd, 'oraculo.config.json'), 'utf8'));
  assert.equal(raw.agents.default, 'dev');
  assert.equal(raw.runtime.timeout, 1000);
  // Valor inválido rejeita sem tocar no arquivo.
  await assert.rejects(configSetCommand('runtime.timeout', '0', { cwd }), /timeout/);
  await assert.rejects(configSetCommand('permissions.gitLocal', 'total', { cwd }), /gitLocal/);
  await assert.rejects(configSetCommand('chave.nova', '1', { cwd }), /desconhecido|rejeitado/);
  await assert.rejects(configSetCommand('__proto__.x', '1', { cwd }), /desconhecido/);
  await assert.rejects(configSetCommand('permissions.gitLocal.extra', 'x', { cwd }), /permissions\.gitLocal/);
  const intact = JSON.parse(await readFile(join(cwd, 'oraculo.config.json'), 'utf8'));
  assert.equal(intact.runtime.timeout, 1000);
  assert.equal(intact.permissions, undefined);
});

test('config unset remove a chave e o default volta a valer', async (t) => {
  const cwd = await fixture(t);
  await configSetCommand('project.name', 'x', { cwd });
  await configSetCommand('runtime.timeout', '1000', { cwd });
  const removed = await configUnsetCommand('project.name', { cwd });
  assert.equal(removed.unset, true);
  assert.equal(await configCommand('runtime.timeout', { cwd }), 1000);
  await assert.rejects(configCommand('project.name', { cwd }), /desconhecido/);
  const noop = await configUnsetCommand('project.name', { cwd });
  assert.equal(noop.unchanged, true);
  await assert.rejects(configUnsetCommand('__proto__', { cwd }), /desconhecido/);
});

test('config set/unset respeitam filesystem read-only', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'oraculo.config.json'), '{"permissions":{"filesystem":"read-only"}}');
  await assert.rejects(configSetCommand('agents.default', 'x', { cwd }), { code: 'GIT_POLICY_DENIED' });
  await assert.rejects(configUnsetCommand('agents.default', { cwd }), { code: 'GIT_POLICY_DENIED' });
  assert.equal(await configCommand('agents.default', { cwd }), 'opencode');
});

test('CLI config set/unset em JSON válido', async (t) => {
  const cwd = await fixture(t);
  const run = (args) => exec(process.execPath, [cli, ...args], { cwd });
  const set = JSON.parse((await run(['config', 'set', 'runtime.timeout', '2000'])).stdout);
  assert.equal(set.value, 2000);
  assert.equal(JSON.parse((await run(['config', 'runtime.timeout'])).stdout), 2000);
  const unset = JSON.parse((await run(['config', 'unset', 'runtime.timeout'])).stdout);
  assert.equal(unset.unset, true);
  assert.equal(JSON.parse((await run(['config', 'runtime.timeout'])).stdout), 300000);
  await assert.rejects(run(['config', 'set', 'runtime.timeout', '0']), /timeout/);
});
