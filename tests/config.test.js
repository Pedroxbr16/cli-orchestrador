import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config/loader.js';
import { defaults } from '../src/config/defaults.js';
import { AgentManager } from '../src/agents/agent-manager.js';

const exec = promisify(execFile);
const cli = resolve('src/cli.js');
async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('arquivo ausente e objetos parciais recebem defaults independentes', async (t) => {
  const cwd = await fixture(t);
  const config = await loadConfig({ cwd });
  assert.deepEqual(config, defaults);
  config.permissions.gitRemote = 'read-write';
  assert.equal((await loadConfig({ cwd })).permissions.gitRemote, 'disabled');
  await writeFile(join(cwd, 'oraculo.config.json'), JSON.stringify({
    agents: {}, permissions: { gitLocal: 'read-only' },
  }));
  assert.deepEqual(await loadConfig({ cwd }), {
    ...defaults, permissions: { ...defaults.permissions, gitLocal: 'read-only' },
  });
});

test('configuração explícita é preservada', async (t) => {
  const cwd = await fixture(t);
  await writeFile(join(cwd, 'oraculo.config.json'), JSON.stringify({
    project: { name: 'teste' }, agents: { default: 'codex' },
  }));
  const config = await loadConfig({ cwd });
  assert.equal(config.agents.default, 'codex');
  assert.equal(config.project.name, 'teste');
});

test('JSON, tipos, enums e chaves desconhecidas inválidos são rejeitados', async (t) => {
  const cwd = await fixture(t);
  for (const source of ['', '{', 'null', '[]', '{"agents":{"default":""}}',
    '{"permissions":{"gitRemote":true}}', '{"permissions":{"gitLocal":"all"}}',
    '{"agent":{"default":"codex"}}']) {
    await writeFile(join(cwd, 'oraculo.config.json'), source);
    await assert.rejects(loadConfig({ cwd }), (error) =>
      error.code === 'CONFIG_INVALID' && error.message.includes('oraculo.config.json'));
  }
});

test('erro de leitura não é confundido com ausência de configuração', async (t) => {
  const cwd = await fixture(t);
  await mkdir(join(cwd, 'oraculo.config.json'));
  await assert.rejects(loadConfig({ cwd }), { code: 'CONFIG_INVALID' });
});

test('agent manager rejeita nomes herdados do Object', () => {
  assert.throws(() => new AgentManager().getAgent('constructor'), /não encontrado/);
});

test('CLI: versão, ajuda, agentes explícitos, default e erros', async (t) => {
  const cwd = await fixture(t);
  for (const name of ['codex', 'opencode']) {
    await writeFile(join(cwd, name),
      '#!' + process.execPath + '\nconsole.log(JSON.stringify({engine: ' +
      JSON.stringify(name) + ', args: process.argv.slice(2), cwd: process.cwd()}));\n',
      { mode: 0o755 });
  }
  const options = { cwd, env: { ...process.env, NO_COLOR: '1',
    PATH: cwd + ':' + dirname(process.execPath) + ':' + process.env.PATH } };
  const run = (args) => exec(process.execPath, [cli, ...args], options);
  assert.match((await run(['--version'])).stdout, /0\.1\.0/);
  assert.match((await run(['--help'])).stdout, /ask/);
  await assert.rejects(run(['ask', 'teste padrão']), /OpenCode: integração segura ainda indisponível/);
  await writeFile(join(cwd, 'oraculo.config.json'), '{"agents":{"default":"codex"}}');
  await assert.rejects(run(['ask', 'teste padrão']), /Codex: escrita ainda indisponível/);
  await assert.rejects(run(['ask', 'opencode', 'responda', 'teste']), /OpenCode: integração segura ainda indisponível/);
  await assert.rejects(run(['ask', 'inexistente', 'teste']), /não encontrado/);
  await assert.rejects(run(['ask', '   ']), /prompt não pode estar vazio/);
  await assert.rejects(run(['ask']), /missing required argument/);
  await writeFile(join(cwd, 'oraculo.config.json'), '{');
  await assert.rejects(run(['ask', 'opencode', 'teste']), /JSON inválido/);
});