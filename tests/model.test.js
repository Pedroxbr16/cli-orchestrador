import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgent, loadAgent } from '../src/agents/agent-loader.js';
import { prepareAgentRun } from '../src/agents/agent-runner.js';
import { routeTask } from '../src/orchestrator/router.js';
import { buildCodexArgs } from '../src/agents/adapters/codex.js';

const exec = promisify(execFile);
const cli = resolve('src/cli.js');

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-model-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('model é opcional, validado e persiste no YAML', async (t) => {
  const cwd = await fixture(t);
  const plain = await createAgent('sem-modelo', { cwd });
  assert.equal(plain.model, undefined);
  assert.equal((await loadAgent('sem-modelo', { cwd })).model, undefined);
  const withModel = await createAgent('arquiteto', { cwd, engine: 'codex', model: 'astra' });
  assert.equal(withModel.model, 'astra');
  assert.equal((await loadAgent('arquiteto', { cwd })).model, 'astra');
  assert.match(await readFile(join(cwd, 'agents/arquiteto/agent.yaml'), 'utf8'), /model: astra/);
  for (const bad of ['', '   ', 'x'.repeat(201)]) {
    await assert.rejects(createAgent('ruim', { cwd, model: bad }), /model/i);
  }
});

test('contexto e roteador carregam o modelo do perfil', async (t) => {
  const cwd = await fixture(t);
  await createAgent('arquiteto', { cwd, engine: 'codex', role: 'architect', model: 'astra' });
  await createAgent('dev', { cwd, engine: 'opencode', model: 'muse-spark' });
  const { context } = await prepareAgentRun({ agent: 'arquiteto', prompt: 'planeje', cwd });
  assert.equal(context.model, 'astra');
  const report = await routeTask('planejar arquitetura', { cwd });
  assert.equal(report.selected.agent, 'arquiteto');
  assert.equal(report.selected.model, 'astra');
  assert.ok(report.candidates.some((candidate) => candidate.agent === 'dev' && candidate.model === 'muse-spark'));
  const fallback = await routeTask('olá', { cwd });
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.selected.agent, 'dev');
  assert.equal(fallback.selected.model, 'muse-spark');
});

test('adapter repassa -m e recusa valor que vira flag', () => {
  const withModel = buildCodexArgs({ worktree: '/wt', outFile: '/tmp/o.md', prompt: 'x', model: 'astra' });
  assert.deepEqual(withModel.slice(withModel.indexOf('-m'), withModel.indexOf('-m') + 2), ['-m', 'astra']);
  const without = buildCodexArgs({ worktree: '/wt', outFile: '/tmp/o.md', prompt: 'x' });
  assert.equal(without.includes('-m'), false);
  const nullModel = buildCodexArgs({ worktree: '/wt', outFile: '/tmp/o.md', prompt: 'x', model: null });
  assert.equal(nullModel.includes('-m'), false);
  for (const bad of ['', '  ', '-evil', 'x'.repeat(201)]) {
    assert.throws(() => buildCodexArgs({ worktree: '/wt', outFile: '/tmp/o.md', prompt: 'x', model: bad }));
  }
});

test('CLI cria perfil com --model e mostra o modelo', async (t) => {
  const cwd = await fixture(t);
  const run = (args) => exec(process.execPath, [cli, ...args], { cwd });
  await run(['agent', 'create', 'arquiteto', '--engine', 'codex', '--role', 'architect', '--model', 'astra']);
  const shown = JSON.parse((await run(['agent', 'show', 'arquiteto'])).stdout);
  assert.equal(shown.model, 'astra');
  assert.equal(shown.engine, 'codex');
});
