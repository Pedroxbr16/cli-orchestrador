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

test('model e reasoning effort são opcionais, validados e persistem no YAML', async (t) => {
  const cwd = await fixture(t);
  const plain = await createAgent('sem-modelo', { cwd });
  assert.equal(plain.model, undefined);
  assert.equal((await loadAgent('sem-modelo', { cwd })).model, undefined);
  const withModel = await createAgent('arquiteto', {
    cwd, engine: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh',
  });
  assert.equal(withModel.model, 'gpt-6-astra');
  assert.equal(withModel.reasoningEffort, 'xhigh');
  const loaded = await loadAgent('arquiteto', { cwd });
  assert.equal(loaded.model, 'gpt-6-astra');
  assert.equal(loaded.reasoningEffort, 'xhigh');
  const yaml = await readFile(join(cwd, 'agents/arquiteto/agent.yaml'), 'utf8');
  assert.match(yaml, /model: gpt-6-astra/);
  assert.match(yaml, /reasoningEffort: xhigh/);
  for (const bad of ['', '   ', 'x'.repeat(201)]) {
    await assert.rejects(createAgent('ruim', { cwd, model: bad }), /model/i);
  }
  for (const bad of ['', 'minimal', 'max', 'ultra']) {
    await assert.rejects(createAgent('esforco-ruim', { cwd, reasoningEffort: bad }), /reasoningEffort/i);
  }
});

test('contexto e roteador carregam modelo e esforço do perfil', async (t) => {
  const cwd = await fixture(t);
  await createAgent('arquiteto', {
    cwd, engine: 'codex', role: 'architect', model: 'gpt-6-astra', reasoningEffort: 'xhigh',
  });
  await createAgent('dev', {
    cwd, engine: 'opencode', model: 'opencode/big-pickle', reasoningEffort: 'medium',
  });
  const { context } = await prepareAgentRun({ agent: 'arquiteto', prompt: 'planeje', cwd });
  assert.equal(context.model, 'gpt-6-astra');
  assert.equal(context.reasoningEffort, 'xhigh');
  const report = await routeTask('planejar arquitetura', { cwd });
  assert.equal(report.selected.agent, 'arquiteto');
  assert.equal(report.selected.model, 'gpt-6-astra');
  assert.equal(report.selected.reasoningEffort, 'xhigh');
  assert.ok(report.candidates.some((candidate) =>
    candidate.agent === 'dev' &&
    candidate.model === 'opencode/big-pickle' &&
    candidate.reasoningEffort === 'medium'));
  const fallback = await routeTask('olá', { cwd });
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.selected.agent, 'dev');
  assert.equal(fallback.selected.model, 'opencode/big-pickle');
  assert.equal(fallback.selected.reasoningEffort, 'medium');
});

test('adapter repassa modelo e esforço e recusa valores inválidos', () => {
  const withModel = buildCodexArgs({
    worktree: '/wt', outFile: '/tmp/o.md', prompt: 'x',
    model: 'gpt-6-astra', reasoningEffort: 'xhigh',
  });
  assert.deepEqual(
    withModel.slice(withModel.indexOf('-m'), withModel.indexOf('-m') + 2),
    ['-m', 'gpt-6-astra'],
  );
  assert.ok(withModel.includes('model_reasoning_effort="xhigh"'));
  const without = buildCodexArgs({ worktree: '/wt', outFile: '/tmp/o.md', prompt: 'x' });
  assert.equal(without.includes('-m'), false);
  const nullModel = buildCodexArgs({ worktree: '/wt', outFile: '/tmp/o.md', prompt: 'x', model: null });
  assert.equal(nullModel.includes('-m'), false);
  for (const bad of ['', '  ', '-evil', 'x'.repeat(201)]) {
    assert.throws(() => buildCodexArgs({ worktree: '/wt', outFile: '/tmp/o.md', prompt: 'x', model: bad }));
  }
  for (const bad of ['', 'minimal', 'max', 'ultra']) {
    assert.throws(() => buildCodexArgs({
      worktree: '/wt', outFile: '/tmp/o.md', prompt: 'x', reasoningEffort: bad,
    }));
  }
});

test('CLI cria perfil com --model e mostra o modelo', async (t) => {
  const cwd = await fixture(t);
  const run = (args) => exec(process.execPath, [cli, ...args], { cwd });
  await run([
    'agent', 'create', 'arquiteto', '--engine', 'codex', '--role', 'architect',
    '--model', 'gpt-6-astra', '--reasoning-effort', 'xhigh',
  ]);
  const shown = JSON.parse((await run(['agent', 'show', 'arquiteto'])).stdout);
  assert.equal(shown.model, 'gpt-6-astra');
  assert.equal(shown.reasoningEffort, 'xhigh');
  assert.equal(shown.engine, 'codex');
});
