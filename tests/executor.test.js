import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeCommand } from '../src/shell/executor.js';
import { runProcess } from '../src/shell/process.js';

const exec = promisify(execFile);
const cli = resolve('src/cli.js');
async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-guard-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec('git', ['init', '-b', 'main', cwd]);
  await exec('git', ['config', 'user.name', 'Oraculo test'], { cwd });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd });
  return cwd;
}

test('executor real faz status, add, commit e diff sem executar hooks ou shell', async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, 'sample.txt'), 'hello\n');
  const hook = join(cwd, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\ntouch hook-ran\nexit 1\n', { mode: 0o755 });
  assert.equal((await executeCommand(['git', 'status', '--short'], { cwd })).success, true);
  assert.equal((await executeCommand(['git', 'add', 'sample.txt'], { cwd })).success, true);
  const result = await executeCommand(['git', 'commit', '-m', 'hello; $(touch injected)'], { cwd });
  assert.equal(result.success, true, result.stderr);
  await assert.rejects(access(join(cwd, 'hook-ran')));
  await assert.rejects(access(join(cwd, 'injected')));
  await writeFile(join(cwd, 'sample.txt'), 'changed\n');
  assert.match((await executeCommand(['git', 'diff'], { cwd })).stdout, /changed/);
  assert.equal((await executeCommand(['git', 'branch', 'feature'], { cwd })).success, true);
});

test('bloqueio acontece antes de iniciar Git e dry-run não altera arquivos', async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, 'sample.txt'), 'hello');
  const before = (await exec('git', ['status', '--porcelain'], { cwd })).stdout;
  await assert.rejects(executeCommand(['git', 'push', 'origin', 'feature'], { cwd }), { code: 'GIT_POLICY_DENIED' });
  assert.equal((await executeCommand(['git', 'add', '.'], { cwd, dryRun: true })).dryRun, true);
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd })).stdout, before);
  await writeFile(join(cwd, 'oraculo.config.json'), '{"permissions":{"gitLocal":"read-only"}}');
  await assert.rejects(executeCommand(['git', 'add', '.'], { cwd }), /Git local=read-only/);
});

test('filtros Git são recusados antes de executar add', async (t) => {
  const cwd = await repository(t);
  await exec('git', ['config', 'filter.evil.clean', 'touch filter-ran'], { cwd });
  await writeFile(join(cwd, '.gitattributes'), '*.txt filter=evil\n');
  await writeFile(join(cwd, 'sample.txt'), 'hello');
  await assert.rejects(executeCommand(['git', 'add', '.'], { cwd }), /filtros/);
  await assert.rejects(access(join(cwd, 'filter-ran')));
});

test('subdiretórios não escapam da configuração na raiz', async (t) => {
  const cwd = await repository(t);
  await mkdir(join(cwd, 'nested'));
  await assert.rejects(executeCommand(['git', 'status'], { cwd: join(cwd, 'nested') }), /raiz/);
});

test('transporte local não é aceito mesmo com Git remoto liberado', async (t) => {
  const cwd = await repository(t);
  await exec('git', ['remote', 'add', 'origin', '/tmp/not-a-network-remote'], { cwd });
  await writeFile(join(cwd, 'oraculo.config.json'), '{"permissions":{"gitRemote":"read-write"}}');
  await assert.rejects(executeCommand(['git', 'fetch', 'origin'], { cwd }), /HTTPS/);
});

test('processos retornam timeout, cancelamento, erro e saída padronizados', async () => {
  const slow = ['-e', 'setTimeout(() => {}, 10000)'];
  const timeout = await runProcess(process.execPath, slow, { timeout: 50 });
  assert.equal(timeout.code, 'COMMAND_TIMEOUT');
  assert.equal(timeout.success, false);
  const controller = new AbortController();
  const pending = runProcess(process.execPath, slow, { cancelSignal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  assert.equal((await pending).code, 'COMMAND_CANCELED');
  const failed = await runProcess(process.execPath, ['-e', 'process.exit(7)']);
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.success, false);
  const missing = await runProcess('oraculo-missing-test-executable-123', []);
  assert.equal(missing.code, 'COMMAND_NOT_FOUND');
});

test('CLI exec valida flags após -- e reporta recusas com saída 1', async (t) => {
  const cwd = await repository(t);
  const run = (args) => exec(process.execPath, [cli, ...args], { cwd });
  const result = await run(['exec', '--', 'git', 'status', '--short']);
  assert.equal(result.stderr, '');
  assert.match((await run(['exec', '--dry-run', '--', 'git', 'add', '.'])).stdout, /dry-run/);
  await assert.rejects(run(['exec', '--', 'git', 'push', 'origin', 'feature']), (error) =>
    error.code === 1 && error.stderr.includes('GIT_POLICY_DENIED'));
  await assert.rejects(run(['exec', '--', 'sh', '-c', 'true']), /COMMAND_DENIED/);
});
test('timeout encerra também subprocessos que herdam stdout', async () => {
  const script = "const {spawn}=require('node:child_process');" +
    "spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'inherit'});" +
    "setTimeout(()=>{},10000)";
  const started = performance.now();
  const result = await runProcess(process.execPath, ['-e', script], { timeout: 100 });
  assert.equal(result.code, 'COMMAND_TIMEOUT');
  assert.ok(performance.now() - started < 4000, 'helper não deve manter o processo aberto');
});

test('exec não herda GIT_DIR do ambiente', async (t) => {
  const cwd = await repository(t);
  const result = await exec(process.execPath, [cli, 'exec', '--', 'git', 'status', '--short'], {
    cwd, env: { ...process.env, GIT_DIR: '/definitely/missing/repository' },
  });
  assert.equal(result.stderr, '');
});
