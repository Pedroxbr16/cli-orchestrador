import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectDiagnostics } from '../src/commands/doctor.js';

async function setup(t, config) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-doctor-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  if (config !== undefined) await writeFile(join(cwd, 'oraculo.config.json'), config);
  return cwd;
}
const good = async (command, args) => ({
  exitCode: 0, stdout: args[0] === 'rev-parse' ? 'true\n' : command + ' 1.0\n',
});
const find = (report, name) => report.checks.find((check) => check.name === name);

test('doctor verifica ambiente sem executar tarefas de IA', async (t) => {
  const cwd = await setup(t);
  const calls = [];
  const report = await collectDiagnostics({ cwd, nodeVersion: '24.19.0',
    run: async (command, args, options) => {
      calls.push([command, args]);
      assert.equal(options.cwd, cwd);
      assert.equal(options.timeout, 5000);
      assert.equal(options.stdin, 'ignore');
      return good(command, args);
    },
  });
  assert.equal(report.success, true);
  assert.match(find(report, 'Config').message, /defaults/);
  assert.equal(find(report, 'Repository').status, 'ok');
  assert.equal(find(report, 'Auth').status, 'warning');
  assert.match(find(report, 'Permissões').message, /Git remoto=disabled/);
  assert.deepEqual(calls, [
    ['npm', ['--version']], ['git', ['--version']],
    ['codex', ['--version']], ['claude', ['--version']], ['opencode', ['--version']],
    ['git', ['rev-parse', '--is-inside-work-tree']],
  ]);
});

test('engine opcional ausente avisa; default ausente falha', async (t) => {
  const cwd = await setup(t);
  const run = async (command, args) => {
    if (command === 'codex') throw Object.assign(new Error(), { code: 'ENOENT' });
    return good(command, args);
  };
  let report = await collectDiagnostics({ cwd, nodeVersion: '24.0.0', run });
  assert.equal(report.success, true);
  assert.equal(find(report, 'codex').status, 'warning');
  await writeFile(join(cwd, 'oraculo.config.json'), '{"agents":{"default":"Codex"}}');
  report = await collectDiagnostics({ cwd, nodeVersion: '24.0.0', run });
  assert.equal(report.success, false);
  assert.equal(find(report, 'codex').status, 'error');
});

test('config inválida não interrompe as outras verificações', async (t) => {
  const cwd = await setup(t, '{');
  const report = await collectDiagnostics({ cwd, nodeVersion: '20.14.0', run: good });
  assert.equal(report.success, false);
  assert.equal(find(report, 'Node').status, 'error');
  assert.equal(find(report, 'Config').status, 'error');
  assert.equal(find(report, 'opencode').status, 'ok');
});

test('agente desconhecido é diagnosticado', async (t) => {
  const cwd = await setup(t, '{"agents":{"default":"inexistente"}}');
  const report = await collectDiagnostics({ cwd, nodeVersion: '24.0.0', run: good });
  assert.equal(report.success, false);
  assert.equal(find(report, 'Agent padrão').status, 'error');
});

test('timeouts, falhas de binário e ausência de repositório são distintos', async (t) => {
  const cwd = await setup(t);
  const report = await collectDiagnostics({ cwd, nodeVersion: '24.0.0',
    run: async (command, args) => {
      if (command === 'npm') return { timedOut: true };
      if (command === 'codex') return { exitCode: 1 };
      if (args[0] === 'rev-parse') return {
        exitCode: 128, stderr: 'fatal: not a git repository',
      };
      return good(command, args);
    },
  });
  assert.equal(report.success, false);
  assert.match(find(report, 'npm').message, /tempo limite/);
  assert.match(find(report, 'codex').message, /código 1/);
  assert.match(find(report, 'Repository').message, /fora de um repositório/);
});

test('Git ausente não dispara consulta de repositório', async (t) => {
  const cwd = await setup(t);
  const report = await collectDiagnostics({ cwd, nodeVersion: '24.0.0',
    run: async (command, args) => {
      assert.notEqual(args[0], 'rev-parse');
      if (command === 'git') throw Object.assign(new Error(), { code: 'ENOENT' });
      return good(command, args);
    },
  });
  assert.equal(report.success, false);
  assert.match(find(report, 'Repository').message, /Git indisponível/);
});