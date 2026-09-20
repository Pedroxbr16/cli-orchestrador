import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runAgent, prepareAgentRun } from '../src/agents/agent-runner.js';
import { extractAgentKnowledge } from '../src/knowledge/agent-knowledge.js';

const exec = promisify(execFile);

const FAKE = `#!/bin/sh
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
cat > "$out" <<'EOF'
Análise concluída.
<oraculo-knowledge>{"entries":[{"scope":"project","title":"Cache local","content":"O cache usa arquivos JSON validados antes da leitura."},{"scope":"global","title":"Segredos","content":"Nunca salvar token=abc123 na documentação."}]}</oraculo-knowledge>
EOF
`;

async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'oraculo-agent-knowledge-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await exec('git', ['init', '-b', 'main', cwd]);
  await exec('git', ['config', 'user.name', 'Oraculo test'], { cwd });
  await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd });
  await writeFile(join(cwd, 'sample.txt'), 'hello\n');
  await exec('git', ['add', 'sample.txt'], { cwd });
  await exec('git', ['commit', '-m', 'initial'], { cwd });
  await mkdir(join(cwd, 'agents/revisor'), { recursive: true });
  await writeFile(join(cwd, 'agents/revisor/agent.yaml'),
    'name: revisor\ndescription: revisao\nengine: codex\nrole: reviewer\n' +
    'knowledgeWrite: both\npermissions:\n  filesystem: read-only\n' +
    '  gitLocal: read-only\n  gitRemote: disabled\n');
  await writeFile(join(cwd, 'agents/revisor/prompt.md'), '# Revisor\nRevise.\n');
  const bin = await mkdtemp(join(tmpdir(), 'oraculo-fake-knowledge-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await writeFile(join(bin, 'codex'), FAKE, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = bin + ':' + previous;
  t.after(() => { process.env.PATH = previous; });
  return cwd;
}

test('agente propõe knowledge global e do projeto; Oraculo valida, grava e reaproveita', async (t) => {
  const cwd = await repository(t);
  const result = await runAgent({ agent: 'revisor', prompt: 'analise o cache', cwd });
  assert.equal(result.output, 'Análise concluída.');
  assert.equal(result.knowledge.written.length, 2);
  assert.equal(result.knowledge.errors.length, 0);
  assert.ok(result.knowledge.written.some((id) => id.startsWith('global/learned-revisor-')));
  assert.ok(result.knowledge.written.some((id) => id.startsWith('projects/oraculo-agent-knowledge-')));

  const globalFiles = await readdir(join(cwd, 'knowledge/global'));
  const projectRoot = join(cwd, 'knowledge/projects');
  const projects = await readdir(projectRoot);
  const projectFiles = await readdir(join(projectRoot, projects[0]));
  assert.equal(globalFiles.length, 1);
  assert.equal(projectFiles.length, 1);
  const globalText = await readFile(join(cwd, 'knowledge/global', globalFiles[0]), 'utf8');
  assert.match(globalText, /token=\[REDACTED\]/);
  assert.equal(globalText.includes('abc123'), false);

  const prepared = await prepareAgentRun({ agent: 'revisor', prompt: 'como funciona o cache JSON?', cwd });
  assert.equal(prepared.context.knowledge.automatic, true);
  assert.equal(prepared.context.knowledge.sources.length, 2);
  assert.ok(prepared.context.knowledge.snippets.some((snippet) => /cache/i.test(snippet.text)));

  const repeated = await runAgent({ agent: 'revisor', prompt: 'confirme o cache', cwd });
  assert.equal(repeated.knowledge.written.length, 0);
  assert.equal((await readdir(join(cwd, 'knowledge/global'))).length, 1);
  assert.equal((await readdir(join(projectRoot, projects[0]))).length, 1);
});

test('parser remove protocolo e recusa scope não autorizado ou conteúdo inválido', () => {
  const output =
    'Resposta\n<oraculo-knowledge>{"entries":[{"scope":"global","title":"X","content":"Y"}]}</oraculo-knowledge>';
  const denied = extractAgentKnowledge(output, { mode: 'project' });
  assert.equal(denied.output, 'Resposta');
  assert.equal(denied.entries.length, 0);
  assert.match(denied.errors[0], /não autorizado/);

  const malformed = extractAgentKnowledge(
    'Ok\n<oraculo-knowledge>{"entries":"x"}</oraculo-knowledge>',
    { mode: 'both' },
  );
  assert.equal(malformed.output, 'Ok');
  assert.equal(malformed.entries.length, 0);
  assert.match(malformed.errors[0], /entries/);
});

test('knowledge disabled ignora propostas e nunca autoriza escopos', () => {
  const output =
    'Ok\n<oraculo-knowledge>{"entries":[{"scope":"project","title":"X","content":"Y"}]}</oraculo-knowledge>';
  const result = extractAgentKnowledge(output, { mode: 'disabled' });
  assert.equal(result.output, 'Ok');
  assert.equal(result.entries.length, 0);
  assert.match(result.errors[0], /não autorizado/);
});
