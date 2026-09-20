import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgent } from '../src/agents/agent-loader.js';
import { routeTask } from '../src/orchestrator/router.js';
import { askCommand } from '../src/commands/ask.js';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-router-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await createAgent('backend', { cwd, role: 'developer' });
  await createAgent('security', { cwd, role: 'security' });
  await writeFile(join(cwd, 'agents/security/agent.yaml'), 'name: security\ndescription: teste\nengine: codex\nrole: security\nskills: [ldap, oauth]\n');
  return cwd;
}
test('router usa skills e intenção com motivo verificável', async (t) => {
  const cwd = await fixture(t);
  const report = await routeTask('Corrigir autenticação LDAP', { cwd });
  assert.equal(report.selected.agent, 'security');
  assert.ok(report.selected.reasons.length);
  assert.equal((await routeTask('implementar endpoint', { cwd })).selected.agent, 'backend');
  assert.equal((await routeTask('tarefa', { cwd, skills: ['oauth'] })).selected.agent, 'security');
  await assert.rejects(routeTask('tarefa', { cwd, skills: ['missing'] }), /Nenhum agent/);
});
test('fallback e profiles inválidos não geram escolha silenciosa incorreta', async (t) => {
  const cwd = await fixture(t);
  assert.equal((await routeTask('olá', { cwd })).selected.agent, 'opencode');
  assert.equal((await routeTask('olá', { cwd })).fallback, true);
  await writeFile(join(cwd, 'agents/security/agent.yaml'), '{');
  const report = await routeTask('LDAP', { cwd });
  assert.equal(report.ignored[0].name, 'security');
  await assert.rejects(askCommand({ prompt: 'implementar endpoint', auto: true, cwd }), { code: 'AGENT_POLICY_UNSUPPORTED' });
  await assert.rejects(askCommand({ agent: 'backend', prompt: 'teste', auto: true, cwd }), /sem agent explícito/);
});