import readline from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Chalk } from 'chalk';
import ora from 'ora';
import { runAgent } from '../agents/agent-runner.js';
import { routeTask } from '../orchestrator/router.js';
import { loadConfig } from '../config/loader.js';
import { requireAccess } from '../permissions/policies.js';
import { AgentManager } from '../agents/agent-manager.js';

// Histórico persistente do REPL: últimas linhas, sem segredos além do que o
// próprio usuário digitou. Falha de persistência nunca interrompe a sessão.
const HISTORY_FILE = '.oraculo/chat-history';
const HISTORY_LIMIT = 200;

async function loadHistory(cwd) {
  try {
    const text = await readFile(join(cwd, HISTORY_FILE), 'utf8');
    return text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-HISTORY_LIMIT);
  } catch {
    return null;
  }
}

async function saveHistory(cwd, lines) {
  const trimmed = lines.slice(-HISTORY_LIMIT);
  await mkdir(join(cwd, '.oraculo'), { recursive: true, mode: 0o700 });
  await writeFile(join(cwd, HISTORY_FILE), trimmed.length ? trimmed.join('\n') + '\n' : '', { mode: 0o600 });
}

// Interface interativa no estilo dos CLIs dos engines: loop pergunta-resposta
// sobre o MESMO funil do ask (roteamento, permissões, bloqueio, auditoria).
// Nada aqui executa por conta própria; cada turno chama runAgent.
export async function chatCommand({ agent, auto = false, cwd = process.cwd(), input = process.stdin, output = process.stdout } = {}) {
  if (agent && auto) throw new Error('Use --auto sem agente explícito, ou informe o agente sem --auto.');
  // Anexa ao input ANTES de qualquer await: dados de pipe que chegam
  // durante o setup são enfileirados pelo iterador em vez de perdidos.
  const rl = readline.createInterface({ input, output, terminal: Boolean(output.isTTY), historySize: HISTORY_LIMIT });
  const lines = rl[Symbol.asyncIterator]();
  let running = null;
  rl.on('SIGINT', () => {
    // Ctrl+C cancela o turno em andamento; sem turno, só repete o prompt.
    if (running) running.abort();
  });
  const manager = new AgentManager();
  // Cores só com TTY: em pipe a saída fica limpa e determinística.
  const chalk = new Chalk({ level: output.isTTY ? undefined : 0 });
  const say = (line = '') => output.write(line + '\n');
  const describe = async (name) => {
    try {
      const resolved = await manager.resolveAgent(name, { cwd });
      const definition = resolved.definition;
      const engine = definition?.engine ?? resolved.adapter.command;
      const model = definition?.model ? `, model ${definition.model}` : '';
      return `${name} (${engine}${model})`;
    } catch (error) {
      throw new Error(`Agente "${name}" não encontrado ou inválido: ${error.message}`);
    }
  };
  let current = null;
  let turns = 0;
  let config = null;
  const hist = [];
  try {
    config = await loadConfig({ cwd });
    current = agent ?? (auto ? null : config.agents.default);
    if (current) await describe(current);

    say(chalk.bold('Oraculo chat') + ' — comandos: /help, /agent [nome], /sair.');
    say(current ? `Agente: ${chalk.cyan(await describe(current))}` : 'Agente: auto (roteado por mensagem).');

    // Histórico da sessão anterior; ausência de arquivo é normal na 1ª sessão.
    // Array próprio (ordem cronológica): o readline só registra com TTY.
    hist.push(...((await loadHistory(cwd)) ?? []));
    rl.history.push(...[...hist].reverse());
    for (;;) {
      const label = current ?? 'auto';
      output.write(`oraculo/${label}> `);
      const next = await lines.next();
      if (next.done) break;
      const text = String(next.value ?? '').trim();
      if (!text) continue;
      if (['/sair', '/exit', '/quit'].includes(text)) break;
      if (text === '/help' || text === '/ajuda') {
        say('/help — esta ajuda');
        say('/agent [nome] — mostra o agente atual ou troca de agente');
        say('/sair — encerra (Ctrl+D também encerra)');
        say('Qualquer outra linha é enviada como tarefa ao agente atual.');
        continue;
      }
      if (text === '/agent' || text.startsWith('/agent ')) {
        const name = text.slice('/agent'.length).trim();
        if (!name) {
          say(current ? `Agente atual: ${chalk.cyan(await describe(current))}` : 'Agente atual: auto.');
          continue;
        }
        try {
          say(`Agente: ${chalk.cyan(await describe(name))}`);
          current = name;
        } catch (error) {
          say(chalk.red(`Erro: ${error.message}`));
        }
        continue;
      }
      // Spinner só com TTY real (com métodos de cursor): em pipe ou stream
      // simples a saída fica limpa para scripts/testes.
      const interactive = Boolean(output.isTTY) && typeof output.cursorTo === 'function';
      const spinner = interactive
        ? ora({ text: `Consultando ${current ?? 'agente'}…`, stream: output, isEnabled: true }).start()
        : null;
      try {
        let target = current;
        if (auto) {
          const report = await routeTask(text, { cwd });
          target = report.selected.agent;
          const route = `→ ${target} (${report.selected.engine}${report.selected.model ? `, ${report.selected.model}` : ''}): ${report.selected.reasons.join('; ') || 'padrão'}`;
          if (spinner) spinner.text = route;
          else say(route);
        }
        running = new AbortController();
        try {
          const result = await runAgent({ agent: target, prompt: text, cwd, cancelSignal: running.signal });
          if (spinner) spinner.succeed('Resposta recebida.');
          if (result?.output) say(result.output);
          hist.push(text);
        } finally {
          running = null;
        }
        turns++;
      } catch (error) {
        if (spinner) spinner.fail('Falha no turno.');
        say(chalk.red(`Erro${error.code ? ` (${error.code})` : ''}: ${error.message}`));
      } finally {
        if (spinner) spinner.stop();
      }
    }
  } finally {
    rl.close();
    // Persiste o histórico conforme a política do projeto; falha só avisa.
    let persist = true;
    try {
      requireAccess(config?.permissions?.filesystem ?? 'read-write', true, 'filesystem');
    } catch {
      persist = false;
    }
    if (!persist) {
      say(chalk.yellow('Aviso: histórico não persistido (filesystem sem escrita).'));
    } else {
      try {
        await saveHistory(cwd, hist);
      } catch {
        say(chalk.yellow('Aviso: histórico não persistido (falha de escrita).'));
      }
    }
  }
  say(`Sessão encerrada (${turns} turno(s)).`);
  return { success: true, turns };
}
