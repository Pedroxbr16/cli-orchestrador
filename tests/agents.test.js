import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgent, loadAgent, listAgents } from '../src/agents/agent-loader.js';
import { prepareAgentRun, runAgent } from '../src/agents/agent-runner.js';
import { collectDiagnostics } from '../src/commands/doctor.js';

const exec = promisify(execFile);
const cli = resolve('src/cli.js');
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-agents-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('cria e carrega perfil sem sobrescrever arquivos existentes', async (t) => {
  const cwd = await fixture(t);
  assert.deepEqual(await listAgents({ cwd }), []);
  const agent = await createAgent('backend', { cwd, engine: 'codex' });
  assert.equal(agent.engine, 'codex');
  assert.equal(agent.name, 'backend');
  const before = await readFile(join(cwd, 'agents/backend/agent.yaml'), 'utf8');
  await assert.rejects(createAgent('backend', { cwd }), { code: 'AGENT_EXISTS' });
  assert.equal(await readFile(join(cwd, 'agents/backend/agent.yaml'), 'utf8'), before);
  assert.equal((await listAgents({ cwd }))[0].agent.name, 'backend');
});

test('YAML inválido, duplicatas, campos desconhecidos e engines inválidos falham', async (t) => {
  const cwd = await fixture(t);
  await createAgent('backend', { cwd });
  const file = join(cwd, 'agents/backend/agent.yaml');
  for (const yaml of [
    '', '[', 'name: backend\nname: duplicate',
    'name: backend\ndescription: teste\nengine: unknown',
    'name: other\ndescription: teste\nengine: codex',
    'name: backend\ndescription: teste\nengine: codex\nunknown: true',
    'name: backend\ndescription: teste\nengine: codex\nprompt: ../outside.md',
    'name: backend\ndescription: teste\nengine: codex\npermissions:\n  gitRemote: full',
  ]) {
    await writeFile(file, yaml);
    await assert.rejects(loadAgent('backend', { cwd }), { code: 'AGENT_INVALID' });
  }
  assert.ok((await listAgents({ cwd }))[0].error);
});

test('nomes reservados, traversal e symlinks são recusados', async (t) => {
  const cwd = await fixture(t);
  for (const name of ['../escape', 'codex', 'claude', 'opencode', 'Upper', 'a/b', '']) {
    await assert.rejects(createAgent(name, { cwd }));
  }
  await createAgent('backend', { cwd });
  await rm(join(cwd, 'agents/backend/prompt.md'));
  await writeFile(join(cwd, 'outside.md'), 'não deve ler');
  await symlink(join(cwd, 'outside.md'), join(cwd, 'agents/backend/prompt.md'));
  await assert.rejects(loadAgent('backend', { cwd }), /symlink/);
  await symlink(join(cwd, 'agents/backend'), join(cwd, 'agents/alias'));
  await assert.rejects(loadAgent('alias', { cwd }), /pasta real/);
});

test('contexto mantém limites do projeto e separa instruções e tarefa', async (t) => {
  const cwd = await fixture(t);
  await createAgent('backend', { cwd });
  await writeFile(join(cwd, 'agents/backend/agent.yaml'), [
    'name: backend', 'description: teste', 'engine: codex', 'skills: [nodejs]',
    'knowledge: [global/standards]', 'permissions:', '  gitRemote: read-write',
    '  gitLocal: read-only', '  filesystem: read-write',
  ].join('\n'));
  await writeFile(join(cwd, 'oraculo.config.json'), JSON.stringify({
    agents: { default: 'backend' }, permissions: { filesystem: 'read-only' },
  }));
  await mkdir(join(cwd, 'knowledge/global'), { recursive: true });
  await writeFile(join(cwd, 'knowledge/global/standards.md'), '# Standards\nminha tarefa');
  const { context } = await prepareAgentRun({ prompt: 'minha tarefa', cwd });
  assert.equal(context.agent, 'backend');
  assert.equal(context.engine, 'codex');
  assert.deepEqual(context.permissions, { filesystem: 'read-only', gitLocal: 'read-only', gitRemote: 'disabled' });
  assert.equal(context.task, 'minha tarefa');
  assert.match(context.instructions, /responsabilidades/);
  assert.deepEqual(context.skills, ['nodejs']);
  assert.equal(context.knowledge.loaded, true);
  assert.equal(context.git.protection.forcePush, false);
  // Fase 10: Codex read-only executa de verdade; aqui o filesystem do projeto
  // é read-only, então a infra (worktree/auditoria) nega antes de subprocessos.
  await assert.rejects(runAgent({ agent: 'backend', prompt: 'teste', cwd }), { code: 'GIT_POLICY_DENIED' });
});

test('CLI lista, cria, mostra e bloqueia execução de perfis', async (t) => {
  const cwd = await fixture(t);
  const run = (args) => exec(process.execPath, [cli, ...args], { cwd });
  await run(['agent', 'create', 'backend', '--engine', 'codex']);
  assert.match(
    (await run(['agents'])).stdout,
    /backend \| role=developer \| engine=codex \| model=default/,
  );
  const options = JSON.parse((await run(['agent', 'options'])).stdout);
  assert.deepEqual(options.engines.map((entry) => entry.id), ['codex', 'claude', 'opencode']);
  const shown = JSON.parse((await run(['agent', 'show', 'backend'])).stdout);
  assert.equal(shown.execution, 'blocked');
  assert.equal(shown.effectivePermissions.gitRemote, 'disabled');
  await assert.rejects(run(['agent', 'create', 'backend']), /AGENT_EXISTS/);
  await assert.rejects(run(['agent', 'run', 'backend', 'teste']), /escrita ainda indisponível/);
  await assert.rejects(run(['ask', 'backend', 'teste']), /Codex: escrita ainda indisponível/);
  await writeFile(join(cwd, 'oraculo.config.json'), '{"permissions":{"filesystem":"read-only"}}');
  await assert.rejects(run(['agent', 'create', 'other']), /filesystem=read-only/);
  await mkdir(join(cwd, 'agents/broken'));
  await assert.rejects(run(['agents']), (error) =>
    error.code === 1 && error.stdout.includes('backend') && error.stdout.includes('[ERRO] broken'));
});

test('doctor verifica o engine do agent padrão personalizado', async (t) => {
  const cwd = await fixture(t);
  await createAgent('backend', { cwd, engine: 'codex' });
  await writeFile(join(cwd, 'oraculo.config.json'), '{"agents":{"default":"backend"}}');
  const report = await collectDiagnostics({ cwd, nodeVersion: '24.0.0',
    run: async (command, args) => command === 'codex' ? { code: 'ENOENT' } :
      { exitCode: 0, stdout: args[0] === 'rev-parse' ? 'true' : '1.0' },
  });
  assert.equal(report.checks.find((check) => check.name === 'Agent padrão').status, 'ok');
  assert.equal(report.checks.find((check) => check.name === 'codex').status, 'error');
  assert.equal(report.success, false);
});