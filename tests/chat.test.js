import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Writable } from 'node:stream';
import { chatCommand } from '../src/commands/chat.js';

const exec = promisify(execFile);
const cli = resolve('src/cli.js');

const FAKE = `#!/bin/sh
out=""; prev="";
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a";
done
printf 'resposta simulada\\n' > "$out"
exit 0
`;

async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-chat-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec('git', ['init', '-b', 'main', cwd]);
  await exec('git', ['config', 'user.name', 'Oraculo test'], { cwd });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd });
  await writeFile(join(cwd, 'sample.txt'), 'hello\n');
  await exec('git', ['add', 'sample.txt'], { cwd });
  await exec('git', ['commit', '-m', 'initial'], { cwd });
  await mkdir(join(cwd, 'agents/revisor'), { recursive: true });
  await writeFile(join(cwd, 'agents/revisor/agent.yaml'),
    'name: revisor\ndescription: revisao somente leitura\nengine: codex\nrole: reviewer\nskills: [code-review]\n' +
    'permissions:\n  filesystem: read-only\n  gitLocal: read-only\n  gitRemote: disabled\n');
  await writeFile(join(cwd, 'agents/revisor/prompt.md'), '# Revisor\nRevise sem modificar.\n');
  await mkdir(join(cwd, 'agents/bloqueado'), { recursive: true });
  await writeFile(join(cwd, 'agents/bloqueado/agent.yaml'),
    'name: bloqueado\ndescription: engine sem integração\nengine: opencode\nrole: developer\nskills: []\n');
  await writeFile(join(cwd, 'agents/bloqueado/prompt.md'), '# Bloqueado\nNada.\n');
  const bin = await mkdtemp(join(tmpdir(), 'oraculo-fakebin-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, 'codex'), FAKE, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = bin + ':' + previous;
  t.after(() => { process.env.PATH = previous; });
  return cwd;
}

function session(lines) {
  const input = Readable.from(lines.map((line) => line + '\n'));
  let text = '';
  const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  return { input, output, text: () => text };
}

test('chat responde turnos e encerra com /sair', async (t) => {
  const cwd = await repository(t);
  const { input, output, text } = session(['revise sample.txt', '/sair']);
  const result = await chatCommand({ agent: 'revisor', cwd, input, output });
  assert.equal(result.success, true);
  assert.equal(result.turns, 1);
  assert.match(text(), /resposta simulada/);
  assert.match(text(), /Sessão encerrada \(1 turno\(s\)\)/);
});

test('chat ignora vazio, ajuda, troca de agente e segue após erro', async (t) => {
  const cwd = await repository(t);
  const { input, output, text } = session(['', '/help', '/agent', '/agent inexistente', '/agent bloqueado', 'oi', '/sair']);
  const result = await chatCommand({ agent: 'revisor', cwd, input, output });
  assert.equal(result.turns, 0);
  assert.match(text(), /esta ajuda/);
  assert.match(text(), /Agente atual: revisor/);
  assert.match(text(), /não encontrado ou inválido/);
  assert.match(text(), /Agente: bloqueado/);
  assert.match(text(), /AGENT_POLICY_UNSUPPORTED/);
});

test('chat --auto roteia cada mensagem sem executar escrita', async (t) => {
  const cwd = await repository(t);
  const { input, output, text } = session(['revisar possíveis regressões', '/sair']);
  const result = await chatCommand({ auto: true, cwd, input, output });
  assert.equal(result.turns, 1);
  assert.match(text(), /→ revisor/);
  assert.match(text(), /resposta simulada/);
});

test('chat rejeita combinação e agente inválidos antes do loop', async (t) => {
  const cwd = await repository(t);
  const { input, output } = session(['/sair']);
  await assert.rejects(chatCommand({ agent: 'revisor', auto: true, cwd, input, output }), /sem agente explícito/);
  await assert.rejects(chatCommand({ agent: 'inexistente', cwd, input, output }), /não encontrado ou inválido/);
});

test('CLI expõe o comando chat', async (t) => {
  const cwd = await repository(t);
  const run = (args) => exec(process.execPath, [cli, ...args], { cwd });
  assert.match((await run(['chat', '--help'])).stdout, /interativa/);
});

test('histórico persiste capado em 200 linhas entre sessões', async (t) => {
  const cwd = await repository(t);
  await mkdir(join(cwd, '.oraculo'), { recursive: true });
  const filling = Array.from({ length: 250 }, (_, index) => `antiga-${index}`);
  await writeFile(join(cwd, '.oraculo/chat-history'), filling.join('\n') + '\n');
  const { input, output, text } = session(['nova pergunta', '/sair']);
  const result = await chatCommand({ agent: 'revisor', cwd, input, output });
  assert.equal(result.turns, 1);
  const saved = (await readFile(join(cwd, '.oraculo/chat-history'), 'utf8')).split('\n').filter(Boolean);
  assert.ok(saved.length <= 200);
  assert.ok(saved.includes('nova pergunta'));
  assert.match(text(), /resposta simulada/);
});

test('projeto read-only avisa e segue sem persistir histórico', async (t) => {
  const cwd = await repository(t);
  await writeFile(join(cwd, 'oraculo.config.json'), '{"permissions":{"filesystem":"read-only"}}');
  const { input, output, text } = session(['oi', '/sair']);
  const result = await chatCommand({ agent: 'bloqueado', cwd, input, output });
  assert.equal(result.turns, 0);
  assert.match(text(), /AGENT_POLICY_UNSUPPORTED/);
  assert.match(text(), /histórico não persistido/);
  await assert.rejects(access(join(cwd, '.oraculo/chat-history')));
});

test('com TTY o spinner não quebra o turno', async (t) => {
  const cwd = await repository(t);
  const input = Readable.from(['revise sample.txt\n', '/sair\n']);
  let text = '';
  const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  output.isTTY = true;
  // Stubs de cursor para o spinner (ora) sem terminal real.
  output.cursorTo = () => true;
  output.clearLine = () => true;
  output.moveCursor = () => true;
  const result = await chatCommand({ agent: 'revisor', cwd, input, output });
  assert.equal(result.turns, 1);
  assert.match(text, /resposta simulada/);
});

test('com TTY o visual usa caixa, prompt ❯ e barra na resposta', async (t) => {
  const cwd = await repository(t);
  const input = Readable.from(['revise sample.txt\n', '/sair\n']);
  let text = '';
  const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  output.isTTY = true;
  output.columns = 80;
  output.cursorTo = () => true;
  output.clearLine = () => true;
  output.moveCursor = () => true;
  const result = await chatCommand({ agent: 'revisor', cwd, input, output });
  assert.equal(result.turns, 1);
  assert.match(text, /╭/);
  assert.match(text, /╰/);
  assert.match(text, /ORACULO/);
  assert.match(text, /❯/);
  assert.match(text, /│ resposta simulada/);
  assert.equal(text.includes('oraculo/revisor>'), false);
});
