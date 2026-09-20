import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgent } from '../src/agents/agent-loader.js';
import { preparePipeline, pipelineSchema } from '../src/orchestrator/pipeline.js';
import { executeSequence } from '../src/orchestrator/runner.js';
import { pipelineCommand } from '../src/commands/pipeline.js';
import { saveSession, readSession, listSessions } from '../src/orchestrator/session.js';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-pipeline-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const name of ['architect', 'developer', 'reviewer']) await createAgent(name, { cwd });
  return cwd;
}
test('pipeline valida dependências e outputs duplicados', () => {
  assert.equal(pipelineSchema.safeParse({ name: 'x', steps: [{ agent: 'a', input: 'later', output: 'plan' }] }).success, false);
  assert.equal(pipelineSchema.safeParse({ name: 'x', steps: [
    { agent: 'a', output: 'same' }, { agent: 'b', output: 'same' },
  ] }).success, false);
});

test('sequência passa resultados estruturados e interrompe falhas', async (t) => {
  const cwd = await fixture(t);
  const plan = await preparePipeline('tarefa', { cwd });
  const seen = [];
  const completed = await executeSequence(plan, {
    execute: async (step) => {
      seen.push(step.context.previous);
      return { success: true, output: { stage: step.output } };
    },
  });
  assert.equal(completed.status, 'completed');
  assert.equal(seen[1].data.stage, 'plan');
  assert.equal(seen[1].trust, 'reference-data');
  let calls = 0;
  const failed = await executeSequence(plan, { execute: async () => {
    calls++;
    return { success: false };
  } });
  assert.equal(failed.status, 'failed');
  assert.equal(calls, 1);
  const canceled = await executeSequence(plan, { execute: async () => { throw new Error('não deve chamar'); },
    cancelSignal: AbortSignal.abort() });
  assert.equal(canceled.status, 'canceled');
});

test('pipeline bloqueado não cria sessão nem executa agents', async (t) => {
  const cwd = await fixture(t);
  await assert.rejects(pipelineCommand('teste', { cwd }), { code: 'AGENT_POLICY_UNSUPPORTED' });
  await assert.rejects(access(join(cwd, '.oraculo')), { code: 'ENOENT' });
  await writeFile(join(cwd, 'bad.yaml'), 'name: x\nsteps: []');
  await assert.rejects(preparePipeline('teste', { cwd, file: 'bad.yaml' }));
});

test('sessões persistem somente metadados e validam IDs e atualização', async (t) => {
  const cwd = await fixture(t);
  const session = { id: randomUUID(), name: 'test', startedAt: new Date().toISOString(), status: 'running', steps: [] };
  await saveSession(session, { cwd, create: true });
  session.status = 'completed';
  await saveSession(session, { cwd });
  assert.equal((await readSession(session.id, { cwd })).status, 'completed');
  assert.equal((await listSessions({ cwd })).length, 1);
  await assert.rejects(readSession('../escape', { cwd }));
  await assert.rejects(saveSession({ ...session, prompt: 'secret' }, { cwd }));
});