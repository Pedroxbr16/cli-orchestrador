import readline from 'node:readline';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Chalk } from 'chalk';
import ora from 'ora';
import { runAgent } from '../agents/agent-runner.js';
import { routeTask } from '../orchestrator/router.js';
import { loadConfig } from '../config/loader.js';
import { requireAccess } from '../permissions/policies.js';
import { AgentManager } from '../agents/agent-manager.js';
import { listAgents } from '../agents/agent-loader.js';
import { agentOptionsCommand, agentPermissionsCommand, updateAgentCommand } from './agent.js';
import { listWorktrees, createWorktree, removeWorktree } from '../git/worktree.js';

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
  // Sem agente explícito, o chat trabalha no modo automático. A interface
  // pública conhece apenas perfis; engines são detalhes internos dos adapters.
  auto = auto || !agent;
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
  // O layout visual só aparece com TTY: em pipe a saída permanece limpa e
  // determinística para scripts e testes.
  const chalk = new Chalk({ level: output.isTTY ? undefined : 0 });
  const pretty = Boolean(output.isTTY);
  const say = (line = '') => output.write(line + '\n');
  const accent = chalk.cyan;
  const answerBlock = (text, label) => {
    if (!pretty) return say(text);
    say();
    say(`  ${accent('◆')} ${chalk.bold(label)}`);
    for (const line of String(text).trimEnd().split('\n')) {
      say(`  ${chalk.dim('│')} ${line}`);
    }
    say();
  };
  const safeProjectName = basename(cwd)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .slice(0, 48) || 'projeto';
  const renderWelcome = (selected) => {
    const wide = (output.columns || 80) >= 44;
    say();
    if (wide) {
      say(accent('  █▀█ █▀▄ ▄▀█ █▀▀ █ █ █   █▀█'));
      say(accent('  █▄█ █▀▄ █▀█ █▄▄ █▄█ █▄▄ █▄█'));
    } else {
      say(accent.bold('  ORACULO'));
    }
    say();
    say(`  ${chalk.bold('Agentes para o seu projeto')}  ${chalk.dim(safeProjectName)}`);
    say();
    say(`  ${accent('◆')} ${chalk.bold(selected ?? 'auto')}  ${chalk.dim(selected ? 'agente ativo' : 'escolhe o agente para cada tarefa')}`);
    say(`  ${chalk.dim('/help')}  ${chalk.dim('ver comandos')}`);
    say();
  };
  const describe = async (name) => {
    try {
      const resolved = await manager.resolveAgent(name, { cwd });
      if (!resolved.definition) {
        throw new Error('use um perfil definido em agents/, não o nome de um engine.');
      }
      return name;
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
    current = agent ?? null;
    if (current) await describe(current);

    if (!pretty) {
      say(chalk.bold('Oraculo chat') + ' — comandos: /help, /agents, /agent [nome], /permissions, /worktrees, /sair.');
      say(current ? `Agente: ${chalk.cyan(await describe(current))}` : 'Agente: auto (roteado por mensagem).');
    } else {
      renderWelcome(current);
    }

    // Histórico da sessão anterior; ausência de arquivo é normal na 1ª sessão.
    // Array próprio (ordem cronológica): o readline só registra com TTY.
    hist.push(...((await loadHistory(cwd)) ?? []));
    rl.history.push(...[...hist].reverse());
    for (;;) {
      const label = current ?? 'auto';
      if (pretty) output.write(`  ${accent('┃')}  `);
      else output.write(`oraculo/${label}> `);
      const next = await lines.next();
      if (next.done) break;
      const text = String(next.value ?? '').trim();
      if (!text) continue;
      if (['/sair', '/exit', '/quit'].includes(text)) break;
      if (text === '/help' || text === '/ajuda') {
        say(chalk.cyan('/help') + ' — esta ajuda');
        say(chalk.cyan('/agents') + ' — lista perfis, engines, modelos e permissões');
        say(chalk.cyan('/agent [nome]') + ' — mostra o agente atual ou troca de agente');
        say(chalk.cyan('/agent options') + ' — lista engines e formatos de modelo');
        say(chalk.cyan('/agent config <nome> [engine|model|effort] [valor]') + ' — consulta ou altera o perfil');
        say(chalk.cyan('/permissions [agente] [campo] [valor]') + ' — consulta ou altera permissões');
        say(chalk.cyan('/worktrees') + ' — lista worktrees');
        say(chalk.cyan('/worktree create <nome> [branch]') + ' — cria uma worktree');
        say(chalk.cyan('/worktree remove <nome>') + ' — remove uma worktree limpa');
        say(chalk.cyan('/sair') + ' — encerra (Ctrl+D também encerra)');
        say('Campos: worktree, filesystem, git, git-local, git-remote e knowledge.');
        say('Valores: disabled, read-only, read-write; knowledge aceita project, global ou both.');
        say('Qualquer outra linha é enviada como tarefa ao agente atual.');
        continue;
      }
      if (text === '/agents') {
        const entries = await listAgents({ cwd });
        if (!entries.length) say('Nenhum perfil definido em agents/.');
        for (const entry of entries) {
          if (entry.error) {
            say(chalk.red('ERRO') + ' ' + entry.name + ': ' + entry.error);
            continue;
          }
          const permissions = entry.agent.permissions;
          const worktree = permissions.filesystem === permissions.gitLocal
            ? (permissions.filesystem ?? 'project-default')
            : 'mixed';
          const selected = current === entry.name;
          const model = entry.agent.model ?? 'default';
          const effort = entry.agent.reasoningEffort ?? 'default';
          if (pretty) {
            say(`  ${selected ? accent('◆') : ' '} ${chalk.cyan(entry.name)}  ${chalk.dim(entry.agent.role)}`);
            say(chalk.dim(
              `      ${entry.agent.engine} · ${model} · effort ${effort} · worktree ${worktree} · remote ${permissions.gitRemote ?? 'project-default'} · knowledge ${entry.agent.knowledgeWrite ?? 'disabled'}`
            ));
          } else {
            say((selected ? '* ' : '  ') + entry.name +
              ' | role=' + entry.agent.role +
              ' | engine=' + entry.agent.engine +
              ' | model=' + model +
              ' | effort=' + effort +
              ' | worktree=' + worktree +
              ' | gitRemote=' + (permissions.gitRemote ?? 'project-default') +
              ' | knowledge=' + (entry.agent.knowledgeWrite ?? 'disabled'));
          }
        }
        say(pretty
          ? chalk.dim('  /agent options · /agent config <nome>')
          : 'Opções: /agent options | Configurar: /agent config <nome>');
        continue;
      }
      if (text === '/permissions' || text.startsWith('/permissions ')) {
        const parts = text.slice('/permissions'.length).trim().split(/\s+/).filter(Boolean);
        let target;
        let field;
        let value;
        if (!parts.length) {
          target = current;
        } else if (parts.length === 1) {
          target = parts[0];
        } else if (parts.length === 2 && current) {
          target = current;
          [field, value] = parts;
        } else if (parts.length === 3) {
          [target, field, value] = parts;
        }
        if (!target || (field && value === undefined)) {
          say('Uso: /permissions <agente> [worktree|filesystem|git|git-local|git-remote|knowledge] [valor]');
          continue;
        }
        try {
          const options = { cwd, print: false };
          const fields = {
            worktree: 'worktree',
            filesystem: 'filesystem',
            git: 'gitLocal',
            'git-local': 'gitLocal',
            'git-remote': 'gitRemote',
            knowledge: 'knowledgeWrite',
          };
          if (field) {
            const key = fields[field];
            if (!key) throw new Error('campo inválido.');
            options[key] = value;
          }
          const report = await agentPermissionsCommand(target, options);
          say(chalk.cyan(report.name) +
            ' | worktree=' + report.worktree +
            ' | filesystem=' + report.effectivePermissions.filesystem +
            ' | gitLocal=' + report.effectivePermissions.gitLocal +
            ' | gitRemote=' + report.effectivePermissions.gitRemote +
            ' | knowledge=' + report.knowledgeWrite);
        } catch (error) {
          say(chalk.red('Erro: ' + error.message));
        }
        continue;
      }
      if (text === '/worktrees') {
        try {
          const entries = await listWorktrees({ cwd });
          if (!entries.length) say('Nenhuma worktree encontrada.');
          for (const entry of entries) say(entry.path + ' | ' + (entry.branch ?? 'detached'));
        } catch (error) {
          say(chalk.red('Erro: ' + error.message));
        }
        continue;
      }
      if (text === '/worktree' || text.startsWith('/worktree ')) {
        const [action, name, branch, ...extra] = text.slice('/worktree'.length).trim().split(/\s+/).filter(Boolean);
        if (!action || !name || extra.length || !['create', 'remove'].includes(action) ||
            (action === 'remove' && branch)) {
          say('Uso: /worktree create <nome> [branch] | /worktree remove <nome>');
          continue;
        }
        try {
          const report = action === 'create'
            ? await createWorktree(name, { cwd, ...(branch ? { branch } : {}) })
            : await removeWorktree(name, { cwd });
          say((action === 'create' ? 'Worktree criada: ' : 'Worktree removida: ') + report.path);
        } catch (error) {
          say(chalk.red('Erro: ' + error.message));
        }
        continue;
      }
      if (text === '/agent' || text.startsWith('/agent ')) {
        const args = text.slice('/agent'.length).trim().split(/\s+/).filter(Boolean);
        if (args[0] === 'options') {
          if (args.length !== 1) {
            say('Uso: /agent options');
            continue;
          }
          const report = agentOptionsCommand({ print: false });
          say(pretty ? `  ${chalk.bold('Engines e modelos')}` : 'Engines e modelos:');
          for (const option of report.engines) {
            say(`  ${chalk.cyan(option.id)}  ${option.models.join(' | ')}`);
            say(`    ${chalk.dim(option.discovery)}`);
          }
          say(`  effort  ${report.reasoningEfforts.join(' | ')}`);
          say(chalk.dim('  default usa o modelo ou esforço padrão do engine.'));
          continue;
        }
        if (args[0] === 'config') {
          const [, target, field, value, ...extra] = args;
          if (!target || extra.length || (field && value === undefined) ||
              (field && !['engine', 'model', 'effort'].includes(field))) {
            say('Uso: /agent config <nome> [engine|model|effort] [valor|default]');
            continue;
          }
          try {
            if (!field) {
              const resolved = await manager.resolveAgent(target, { cwd });
              if (!resolved.definition) throw new Error('use um perfil definido em agents/.');
              say(
                `${chalk.cyan(target)} | engine=${resolved.definition.engine}` +
                ` | model=${resolved.definition.model ?? 'default'}` +
                ` | effort=${resolved.definition.reasoningEffort ?? 'default'}`
              );
              say(chalk.dim('Engines: codex, claude, opencode · use /agent options para modelos e esforços.'));
            } else {
              const options = { cwd, print: false };
              if (field === 'engine') {
                options.engine = value;
                options.clearModel = true;
              } else if (field === 'model' && value === 'default') {
                options.clearModel = true;
              } else if (field === 'model') {
                options.model = value;
              } else if (value === 'default') {
                options.clearReasoningEffort = true;
              } else {
                options.reasoningEffort = value;
              }
              const report = await updateAgentCommand(target, options);
              say(
                `${chalk.cyan(target)} | engine=${report.agent.engine}` +
                ` | model=${report.agent.model ?? 'default'}` +
                ` | effort=${report.agent.reasoningEffort ?? 'default'}`
              );
              if (field === 'engine') say(chalk.dim('Modelo redefinido para o padrão do novo engine.'));
            }
          } catch (error) {
            say(chalk.red(`Erro: ${error.message}`));
          }
          continue;
        }
        const name = args.join(' ');
        if (!name) {
          say(current ? `Agente atual: ${chalk.cyan(await describe(current))}` : 'Agente atual: auto.');
          continue;
        }
        if (name === 'auto') {
          current = null;
          auto = true;
          say(pretty
            ? `  ${accent('◆')} ${chalk.bold('auto')}  ${chalk.dim('roteamento automático')}`
            : `Agente: ${chalk.cyan('auto')}`);
          continue;
        }
        try {
          const selected = await describe(name);
          say(pretty
            ? `  ${accent('◆')} ${chalk.bold(selected)}  ${chalk.dim('agente ativo')}`
            : `Agente: ${chalk.cyan(selected)}`);
          current = name;
          auto = false;
        } catch (error) {
          say(chalk.red(`Erro: ${error.message}`));
        }
        continue;
      }
      // Spinner só com TTY real dimensionado (com métodos de cursor e
      // colunas): pty degenerado (0 colunas) trava o ora em loop. Em pipe
      // ou stream simples a saída fica limpa para scripts/testes.
      const interactive = Boolean(output.isTTY) && typeof output.cursorTo === 'function' && (output.columns || 0) > 0;
      const spinner = interactive
        ? ora({ text: 'Pensando…', stream: output, isEnabled: true, color: 'cyan' }).start()
        : null;
      try {
        let target = current;
        if (auto) {
          const report = await routeTask(text, { cwd });
          target = report.selected.agent;
          const reason = report.selected.reasons.join('; ') || 'padrão';
          const route = `→ ${target}: ${reason}`;
          if (spinner) spinner.text = `${target} · ${reason}`;
          else say(route);
        }
        running = new AbortController();
        try {
          const result = await runAgent({ agent: target, prompt: text, cwd, cancelSignal: running.signal });
          if (spinner) spinner.stop();
          if (result?.output) answerBlock(result.output, target);
          if (result?.knowledge?.written?.length) say(chalk.dim('Knowledge: ' + result.knowledge.written.join(', ')));
          if (result?.knowledge?.errors?.length) say(chalk.yellow('Aviso de knowledge: ' + result.knowledge.errors.join('; ')));
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
  say(pretty
    ? chalk.dim(`  Sessão encerrada · ${turns} turno(s)`)
    : `Sessão encerrada (${turns} turno(s)).`);
  return { success: true, turns };
}
