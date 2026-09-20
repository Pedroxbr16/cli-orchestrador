import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { addDocument, listDocuments, removeDocument, selectDocuments } from '../src/knowledge/knowledge-manager.js';
import { searchDocuments } from '../src/knowledge/retriever.js';
import { createAgent } from '../src/agents/agent-loader.js';
import { prepareAgentRun } from '../src/agents/agent-runner.js';
import { loadConfig } from '../src/config/loader.js';

const exec = promisify(execFile);
const cli = resolve('src/cli.js');
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-knowledge-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, 'oraculo.config.json'), '{"project":{"name":"demo"}}');
  await writeFile(join(cwd, 'standards.md'), '# Padrões\n\nAutenticação LDAP e git flow.\n');
  return cwd;
}

test('importa sem sobrescrever, lista escopos e remove apenas documento selecionado', async (t) => {
  const cwd = await fixture(t);
  assert.deepEqual(await listDocuments({ cwd }), []);
  assert.equal(await addDocument('standards.md', { cwd }), 'projects/demo/standards.md');
  await assert.rejects(addDocument('standards.md', { cwd }), { code: 'KNOWLEDGE_EXISTS' });
  await addDocument('standards.md', { cwd, scope: 'global' });
  assert.equal((await listDocuments({ cwd })).length, 2);
  assert.equal((await listDocuments({ cwd, scope: 'global' })).length, 1);
  await removeDocument('global/standards.md', { cwd });
  assert.equal((await listDocuments({ cwd })).length, 1);
  assert.match(await readFile(join(cwd, 'standards.md'), 'utf8'), /LDAP/);
});

test('busca ignora acentos e caixa, ordena relevância e limita contexto', () => {
  const documents = [
    { id: 'global/a.md', title: 'a', text: 'Somente LDAP.' },
    { id: 'global/b.md', title: 'b', text: 'Autenticação LDAP.' },
  ];
  const results = searchDocuments(documents, 'AUTENTICACAO ldap');
  assert.equal(results[0].id, 'global/b.md');
  assert.equal(results[0].line, 1);
  assert.equal(searchDocuments(documents, 'semresultado').length, 0);
  assert.equal(searchDocuments(documents, 'LDAP', { limit: 1 }).length, 1);
  assert.throws(() => searchDocuments(documents, '   '));
  assert.throws(() => searchDocuments(documents, 'ldap', { limit: 0 }));
  const long = searchDocuments([{ id: 'a', text: 'x'.repeat(3000) + ' autenticação', title: 'a' }], 'autenticacao');
  assert.equal(long.length, 1);
  assert.ok(long[0].text.length <= 1200);
});

test('recusa traversal, symlinks, binários, arquivo grande e permissões negadas', async (t) => {
  const cwd = await fixture(t);
  await assert.rejects(addDocument('../outside.md', { cwd }), /fora do projeto/);
  await symlink(join(cwd, 'standards.md'), join(cwd, 'link.md'));
  await assert.rejects(addDocument('link.md', { cwd }), /Symlinks/);
  await writeFile(join(cwd, 'binary.txt'), Buffer.from([0xff, 0]));
  await assert.rejects(addDocument('binary.txt', { cwd }));
  await writeFile(join(cwd, 'large.md'), 'x'.repeat(262145));
  await assert.rejects(addDocument('large.md', { cwd }), /256 KiB/);
  await assert.rejects(removeDocument('global/../../standards.md', { cwd }));
  await writeFile(join(cwd, 'oraculo.config.json'), '{"permissions":{"filesystem":"read-only"}}');
  await assert.rejects(addDocument('standards.md', { cwd }), /read-only/);
  await writeFile(join(cwd, 'oraculo.config.json'), '{"permissions":{"filesystem":"disabled"}}');
  await assert.rejects(listDocuments({ cwd }), /disabled/);
});

test('seleção limita fontes ao projeto e detecta fonte inexistente', async (t) => {
  const cwd = await fixture(t);
  await addDocument('standards.md', { cwd });
  await addDocument('standards.md', { cwd, scope: 'global' });
  await mkdir(join(cwd, 'knowledge/projects/other'), { recursive: true });
  await writeFile(join(cwd, 'knowledge/projects/other/private.md'), 'outro projeto');
  const docs = await listDocuments({ cwd });
  const config = await loadConfig({ cwd });
  assert.equal(docs.length, 2);
  assert.equal(selectDocuments(docs, ['project/current'], config, cwd)[0].id, 'projects/demo/standards.md');
  assert.equal(selectDocuments(docs, ['global/standards', 'global/standards.md'], config, cwd).length, 1);
  assert.throws(() => selectDocuments(docs, ['global/missing'], config, cwd), { code: 'KNOWLEDGE_NOT_FOUND' });
  await assert.rejects(removeDocument('projects/other/private.md', { cwd }));
});

test('contexto inclui só trechos das fontes declaradas como dados de referência', async (t) => {
  const cwd = await fixture(t);
  await addDocument('standards.md', { cwd, scope: 'global' });
  await createAgent('backend', { cwd });
  await writeFile(join(cwd, 'agents/backend/agent.yaml'),
    'name: backend\ndescription: backend\nengine: codex\nknowledge: [global/standards]\n');
  const { context } = await prepareAgentRun({ agent: 'backend', prompt: 'autenticacao LDAP', cwd });
  assert.equal(context.knowledge.loaded, true);
  assert.equal(context.knowledge.trust, 'reference-data');
  assert.equal(context.knowledge.snippets[0].id, 'global/standards.md');
  assert.equal(context.task, 'autenticacao LDAP');
  assert.equal(context.permissions.gitRemote, 'disabled');
  await writeFile(join(cwd, 'agents/backend/agent.yaml'),
    'name: backend\ndescription: backend\nengine: codex\nknowledge: [global/standards]\npermissions:\n  filesystem: disabled\n');
  await assert.rejects(prepareAgentRun({ agent: 'backend', prompt: 'LDAP', cwd }), /filesystem do agent=disabled/);
});

test('CLI importa, busca JSON, lista e remove sem executar agentes', async (t) => {
  const cwd = await fixture(t);
  const run = (args) => exec(process.execPath, [cli, ...args], { cwd });
  await run(['knowledge', 'add', 'standards.md', '--scope', 'global']);
  assert.match((await run(['knowledge', 'list'])).stdout, /global\/standards.md/);
  const result = JSON.parse((await run(['knowledge', 'search', 'autenticacao', '--json'])).stdout);
  assert.equal(result[0].id, 'global/standards.md');
  await assert.rejects(run(['knowledge', 'search', 'ldap', '--limit', 'bad']), /Limit/);
  await run(['knowledge', 'remove', 'global/standards.md']);
  assert.match((await run(['knowledge', 'list'])).stdout, /Nenhum documento/);
});

test('prévia CLI recupera knowledge sem iniciar o engine', async (t) => {
  const cwd = await fixture(t);
  await addDocument('standards.md', { cwd, scope: 'global' });
  await createAgent('backend', { cwd });
  await writeFile(join(cwd, 'agents/backend/agent.yaml'),
    'name: backend\ndescription: teste\nengine: codex\nknowledge: [global/standards]\n');
  const result = await exec(process.execPath, [cli, 'agent', 'context', 'backend', 'LDAP'], { cwd });
  const context = JSON.parse(result.stdout);
  assert.equal(context.engine, 'codex');
  assert.equal(context.knowledge.snippets[0].id, 'global/standards.md');
  assert.equal(context.knowledge.snippets[0].line, 1);
  assert.equal(context.permissions.gitRemote, 'disabled');
});

test('importação não atravessa diretório knowledge simbólico', async (t) => {
  const cwd = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), 'oraculo-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(cwd, 'knowledge'));
  await assert.rejects(addDocument('standards.md', { cwd, scope: 'global' }), /Symlinks/);
  await assert.rejects(readFile(join(outside, 'global/standards.md')), { code: 'ENOENT' });
});
