import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgent } from '../src/agents/agent-loader.js';
import { listWorktrees, createWorktree, removeWorktree, planWorktrees } from '../src/git/worktree.js';

const exec = promisify(execFile);
const cli = resolve('src/cli.js');

async function repository(t, { agents = false } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-worktree-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec('git', ['init', '-b', 'main', cwd]);
  await exec('git', ['config', 'user.name', 'Oraculo test'], { cwd });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd });
  await writeFile(join(cwd, 'sample.txt'), 'hello\n');
  await exec('git', ['add', 'sample.txt'], { cwd });
  await exec('git', ['commit', '-m', 'initial'], { cwd });
  if (agents) {
    for (const name of ['architect', 'developer', 'reviewer']) await createAgent(name, { cwd });
  }
  return cwd;
}

test('validação rejeita nomes, branches e traversal antes de tocar no git', async (t) => {
  const cwd = await repository(t);
  for (const bad of ['../escape', '/absoluto', 'UPPER', 'a/b', '.git', '', 'a'.repeat(65)]) {
    await assert.rejects(createWorktree(bad, { cwd }), /nome de worktree inválido/);
  }
  await assert.rejects(createWorktree('ok', { cwd, branch: 'a..b' }), /branch inválida/);
  await assert.rejects(createWorktree('ok', { cwd, branch: 'a//b' }), /branch inválida/);
  await assert.rejects(removeWorktree('../escape', { cwd }), /nome de worktree inválido/);
  await assert.rejects(planWorktrees('   ', { cwd }), /1 a 4096/);
  // Fora de repositório: falha antes de qualquer mutação.
  const plain = await mkdtemp(join(tmpdir(), 'oraculo-plain-'));
  t.after(() => rm(plain, { recursive: true, force: true }));
  await assert.rejects(createWorktree('demo', { cwd: plain }));
});

test('dry-run planeja sem criar diretórios ou branches', async (t) => {
  const cwd = await repository(t);
  const before = (await exec('git', ['branch', '--list'], { cwd })).stdout;
  const planned = await createWorktree('demo', { cwd, dryRun: true });
  assert.equal(planned.dryRun, true);
  assert.equal(planned.branch, 'wt/demo');
  assert.equal(planned.path, join('worktrees', 'demo'));
  const custom = await createWorktree('demo', { cwd, branch: 'feature/x', dryRun: true });
  assert.equal(custom.branch, 'feature/x');
  const removal = await removeWorktree('demo', { cwd, dryRun: true });
  assert.equal(removal.dryRun, true);
  await assert.rejects(access(join(cwd, 'worktrees')));
  assert.equal((await exec('git', ['branch', '--list'], { cwd })).stdout, before);
});

test('ciclo create/list/remove isola branches por worktree', async (t) => {
  const cwd = await repository(t);
  const created = await createWorktree('alpha', { cwd });
  assert.equal(created.created, true);
  assert.equal(created.branch, 'wt/alpha');
  let entries = await listWorktrees({ cwd });
  const entry = entries.find(({ path }) => path.endsWith(join('worktrees', 'alpha')));
  assert.ok(entry, 'worktree alpha deve aparecer na listagem');
  assert.equal(entry.branch, 'refs/heads/wt/alpha');
  // Checkout isolado: arquivo novo na worktree não vaza para a raiz.
  await writeFile(join(cwd, 'worktrees', 'alpha', 'isolated.txt'), 'só na worktree\n');
  await assert.rejects(access(join(cwd, 'isolated.txt')));
  // Duplicata falha com mensagem clara e sem efeitos colaterais.
  await assert.rejects(createWorktree('alpha', { cwd }), /já existe/);
  // Sem --force, o Git protege worktrees com alterações não salvas.
  await assert.rejects(removeWorktree('alpha', { cwd }), /--force/);
  const removed = await removeWorktree('alpha', { cwd, force: true });
  assert.equal(removed.removed, true);
  assert.equal(removed.force, true);
  entries = await listWorktrees({ cwd });
  assert.equal(entries.some(({ path }) => path.endsWith(join('worktrees', 'alpha'))), false);
  await assert.rejects(removeWorktree('alpha', { cwd }), /não encontrada/);
});

test('permissões read-only bloqueiam mutação mas permitem leitura e plano', async (t) => {
  const cwd = await repository(t, { agents: true });
  await writeFile(join(cwd, 'oraculo.config.json'), '{"permissions":{"gitLocal":"read-only"}}');
  await assert.rejects(createWorktree('demo', { cwd }), { code: 'GIT_POLICY_DENIED' });
  await assert.rejects(removeWorktree('demo', { cwd }), { code: 'GIT_POLICY_DENIED' });
  assert.ok(Array.isArray(await listWorktrees({ cwd })));
  const plan = await planWorktrees('implementar LDAP', { cwd });
  assert.equal(plan.execution, 'blocked-until-secure-engine');
});

test('plan atribui um worktree por etapa sem criar nada nem executar engines', async (t) => {
  const cwd = await repository(t, { agents: true });
  const first = await planWorktrees('implementar autenticação LDAP', { cwd });
  assert.equal(first.pipeline, 'default-development');
  assert.equal(first.assignments.length, 4);
  const paths = first.assignments.map((step) => step.worktree);
  assert.equal(new Set(paths).size, paths.length);
  assert.deepEqual(paths, [
    'worktrees/architect-0', 'worktrees/developer-1', 'worktrees/reviewer-2', 'worktrees/developer-3',
  ]);
  for (const step of first.assignments) assert.ok(step.engine);
  assert.equal(first.execution, 'blocked-until-secure-engine');
  await assert.rejects(access(join(cwd, 'worktrees')));
  const second = await planWorktrees('implementar autenticação LDAP', { cwd });
  assert.deepEqual(second, first);
});

test('CLI worktree lista, planeja e valida dry-run em JSON', async (t) => {
  const cwd = await repository(t, { agents: true });
  const run = (args) => exec(process.execPath, [cli, ...args], { cwd });
  // A listagem sempre inclui o checkout principal; ainda não há worktrees extras.
  const initial = JSON.parse((await run(['worktree', 'list'])).stdout);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].path, cwd);
  assert.equal(initial[0].branch, 'refs/heads/main');
  const plan = JSON.parse((await run(['worktree', 'plan', 'implementar LDAP'])).stdout);
  assert.equal(plan.assignments.length, 4);
  assert.equal(plan.execution, 'blocked-until-secure-engine');
  const dry = JSON.parse((await run(['worktree', 'create', '--dry-run', 'demo'])).stdout);
  assert.equal(dry.dryRun, true);
  await assert.rejects(access(join(cwd, 'worktrees')));
  await assert.rejects(run(['worktree', 'create', '../escape']), (error) =>
    error.code === 1 && error.stderr.includes('GIT_POLICY_DENIED'));
});
