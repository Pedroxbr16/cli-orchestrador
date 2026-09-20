import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgent, loadAgent } from '../src/agents/agent-loader.js';
import { updateAgentCommand } from '../src/commands/agent.js';

const exec = promisify(execFile);
const cli = resolve('src/cli.js');

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-update-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await createAgent('dev', { cwd, engine: 'opencode', role: 'developer' });
  return cwd;
}

test('update troca engine, role, model e descrição sem tocar no prompt', async (t) => {
  const cwd = await fixture(t);
  const before = await readFile(join(cwd, 'agents/dev/prompt.md'), 'utf8');
  const report = await updateAgentCommand('dev',
    { cwd, engine: 'codex', role: 'architect', model: 'astra', description: 'Arquiteto chefe' });
  assert.deepEqual(report.updated, ['engine', 'role', 'description', 'model']);
  const agent = await loadAgent('dev', { cwd });
  assert.equal(agent.engine, 'codex');
  assert.equal(agent.role, 'architect');
  assert.equal(agent.model, 'astra');
  assert.equal(agent.description, 'Arquiteto chefe');
  assert.equal(agent.skills.length, 0);
  assert.equal(await readFile(join(cwd, 'agents/dev/prompt.md'), 'utf8'), before);
});

test('clear-model remove a chave; nada para atualizar e inválidos falham sem gravar', async (t) => {
  const cwd = await fixture(t);
  await updateAgentCommand('dev', { cwd, model: 'x' });
  const cleared = await updateAgentCommand('dev', { cwd, clearModel: true });
  assert.deepEqual(cleared.updated, ['model']);
  assert.equal((await loadAgent('dev', { cwd })).model, undefined);
  assert.equal(/model:/.test(await readFile(join(cwd, 'agents/dev/agent.yaml'), 'utf8')), false);
  await assert.rejects(updateAgentCommand('dev', { cwd }), /Nada para atualizar/);
  await assert.rejects(updateAgentCommand('dev', { cwd, model: 'x', clearModel: true }), /não ambos/);
  await assert.rejects(updateAgentCommand('dev', { cwd, engine: 'sonhos' }), /engine/);
  await assert.rejects(updateAgentCommand('dev', { cwd, role: '' }), /role/);
  await assert.rejects(updateAgentCommand('fantasma', { cwd, model: 'x' }), /não encontrado ou inválido/);
  assert.equal((await loadAgent('dev', { cwd })).engine, 'opencode');
});

test('update respeita filesystem read-only', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'oraculo.config.json'), '{"permissions":{"filesystem":"read-only"}}');
  await assert.rejects(updateAgentCommand('dev', { cwd, model: 'x' }), { code: 'GIT_POLICY_DENIED' });
  assert.equal((await loadAgent('dev', { cwd })).model, undefined);
});

test('CLI agent update troca o modelo do perfil', async (t) => {
  const cwd = await fixture(t);
  const run = (args) => exec(process.execPath, [cli, ...args], { cwd });
  const report = JSON.parse((await run(['agent', 'update', 'dev', '--model', 'muse-spark'])).stdout);
  assert.deepEqual(report.updated, ['model']);
  assert.equal(JSON.parse((await run(['agent', 'show', 'dev'])).stdout).model, 'muse-spark');
  await assert.rejects(run(['agent', 'update', 'dev']), /Nada para atualizar/);
});
