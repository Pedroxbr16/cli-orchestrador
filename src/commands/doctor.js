import { runDiagnostic } from '../shell/executor.js';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../config/loader.js';
import { AgentManager } from '../agents/agent-manager.js';

export async function collectDiagnostics({
  cwd = process.cwd(),
  nodeVersion = process.versions.node,
  run = runDiagnostic,
  timeout = 5000,
} = {}) {
  const checks = [];
  const add = (name, status, message) => checks.push({ name, status, message });
  const major = Number(nodeVersion.split('.')[0]);
  add('Node', major >= 24 ? 'ok' : 'error',
    `v${nodeVersion}${major >= 24 ? '' : ' — use Node 24 ou superior'}`);

  let config;
  let defaultEngine;
  try {
    config = await loadConfig({ cwd });
    let source = 'defaults (arquivo ausente)';
    try {
      await access(resolve(cwd, 'oraculo.config.json'));
      source = 'oraculo.config.json';
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    add('Config', 'ok', source);
    try {
      const resolved = await new AgentManager().resolveAgent(config.agents.default, { cwd });
      defaultEngine = resolved.adapter.command;
      add('Agent padrão', 'ok', config.agents.default);
    } catch (error) {
      add('Agent padrão', 'error', error.message);
    }
    add('Permissões', 'warning',
      `filesystem=${config.permissions.filesystem}; Git local=${config.permissions.gitLocal}; Git remoto=${config.permissions.gitRemote}. Git Guard ativo em oraculo exec; ask bloqueado até integração segura.`);
  } catch (error) {
    add('Config', 'error', error.message);
  }

  const probe = async (command, args) => {
    try {
      const result = await run(command, args, {
        cwd, timeout, stdin: 'ignore', reject: false,
        cleanup: true, forceKillAfterDelay: 1000,
      });
      return result;
    } catch (error) {
      return error;
    }
  };
  const describeFailure = (result) => {
    if (result.timedOut) return 'tempo limite excedido';
    if (['ENOENT', 'COMMAND_NOT_FOUND'].includes(result.code)) return 'não encontrado no PATH';
    return `falhou (código ${result.exitCode ?? result.code ?? 'desconhecido'})`;
  };
  const available = {};
  for (const command of ['npm', 'git', 'codex', 'opencode']) {
    const result = await probe(command, ['--version']);
    available[command] = result.exitCode === 0 && !result.timedOut;
    const required = ['npm', 'git'].includes(command) ||
      command === defaultEngine;
    add(command, available[command] ? 'ok' : required ? 'error' : 'warning',
      available[command]
        ? (result.stdout?.trim().split(/\r?\n/)[0] || 'instalado')
        : describeFailure(result));
  }

  if (available.git) {
    const result = await probe('git', ['rev-parse', '--is-inside-work-tree']);
    if (result.exitCode === 0 && result.stdout?.trim() === 'true') {
      add('Repository', 'ok', 'repositório Git encontrado');
    } else if (result.exitCode === 128 && /not a git repository/i.test(result.stderr ?? '')) {
      add('Repository', 'warning', 'diretório atual fora de um repositório Git');
    } else {
      add('Repository', 'warning', `não foi possível confirmar o repositório: ${describeFailure(result)}`);
    }
  } else {
    add('Repository', 'warning', 'não verificado: Git indisponível');
  }
  add('Execução de agentes', 'warning', 'ask bloqueado: Codex e OpenCode ainda não têm integração com enforcement completo.');
  add('Auth', 'warning',
    'não verificada: --version confirma instalação, não autenticação ou quota. Confira o login no CLI de cada agente.');
  return { checks, success: !checks.some((check) => check.status === 'error') };
}

export async function doctorCommand(options = {}) {
  const report = await collectDiagnostics(options);
  console.log('\nORACULO DOCTOR\n');
  const markers = { ok: 'OK', warning: 'AVISO', error: 'ERRO' };
  for (const check of report.checks) {
    console.log(`[${markers[check.status]}] ${check.name}: ${check.message}`);
  }
  console.log(`\n${report.success ? 'Diagnóstico concluído sem erros.' : 'Corrija os erros indicados acima.'}\n`);
  return report;
}