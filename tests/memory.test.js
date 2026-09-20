import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addMemory, listMemory } from '../src/memory/memory-manager.js';
import { createAgent } from '../src/agents/agent-loader.js';
import { prepareAgentRun } from '../src/agents/agent-runner.js';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-memory-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'oraculo.config.json'), '{"project":{"name":"demo"}}');
  return cwd;
}
test('memória persiste decisões, bugs, soluções e mudanças com redação de credenciais', async (t) => {
  const cwd = await fixture(t);
  assert.deepEqual(await listMemory({ cwd }), []);
  await addMemory('decision', 'Usar autenticação LDAP', { cwd });
  await addMemory('bug', 'token=abcd secret=123 erro', { cwd, solution: 'Corrigir parser' });
  await addMemory('change', 'Alterar parser', { cwd });
  assert.equal((await listMemory({ cwd })).length, 3);
  assert.equal((await listMemory({ cwd, query: 'autenticacao' })).length, 1);
  const bugs = await listMemory({ cwd, type: 'bug' });
  assert.equal(bugs[0].solution, 'Corrigir parser');
  const raw = await readFile(join(cwd, '.oraculo/memory/demo/bugs.jsonl'), 'utf8');
  assert.ok(!raw.includes('abcd'));
  assert.ok(!raw.includes('secret=123'));
});

test('memória valida corrupção, escrita concorrente e permissões', async (t) => {
  const cwd = await fixture(t);
  await addMemory('decision', 'primeira', { cwd });
  const path = join(cwd, '.oraculo/memory/demo');
  await mkdir(join(path, '.lock'));
  await assert.rejects(addMemory('decision', 'segunda', { cwd }), { code: 'MEMORY_BUSY' });
  await rm(join(path, '.lock'), { recursive: true });
  await writeFile(join(path, 'decisions.jsonl'), '{invalid}\n');
  await assert.rejects(listMemory({ cwd }), /linha 1/);
  await writeFile(join(cwd, 'oraculo.config.json'), '{"permissions":{"filesystem":"read-only"}}');
  await assert.rejects(addMemory('change', 'teste', { cwd }), /read-only/);
  await assert.rejects(addMemory('other', 'teste', { cwd }), /Tipo/);
});

test('memória rejeita symlinks e aparece limitada como referência no contexto', async (t) => {
  const cwd = await fixture(t);
  await createAgent('backend', { cwd });
  await addMemory('decision', 'minha decisão', { cwd });
  const { context } = await prepareAgentRun({ agent: 'backend', prompt: 'tarefa', cwd });
  assert.equal(context.memory.entries.length, 1);
  assert.equal(context.memory.trust, 'reference-data');
  await rm(join(cwd, '.oraculo/memory/demo/decisions.jsonl'));
  await writeFile(join(cwd, 'external.jsonl'), '');
  await symlink(join(cwd, 'external.jsonl'), join(cwd, '.oraculo/memory/demo/decisions.jsonl'));
  await assert.rejects(listMemory({ cwd }), /Symlinks/);
});