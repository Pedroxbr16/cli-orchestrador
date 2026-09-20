#!/usr/bin/env node
import { worktreeListCommand, worktreeCreateCommand, worktreeRemoveCommand, worktreePlanCommand } from './commands/worktree.js';
import { initCommand } from './commands/init.js';
import { configCommand, configSetCommand, configUnsetCommand } from './commands/config.js';
import { chatCommand } from './commands/chat.js';
import { knowledgeAdd, knowledgeList, knowledgeSearch, knowledgeRemove } from './commands/knowledge.js';
import { Command } from 'commander';
import { routeCommand } from './commands/route.js';
import { pipelineCommand } from './commands/pipeline.js';
import { listSessions, readSession } from './orchestrator/session.js';
import { memoryAdd, memoryList } from './commands/memory.js';
import chalk from 'chalk';
import { askCommand } from './commands/ask.js';
import { doctorCommand } from './commands/doctor.js';
import { execCommand } from './commands/exec.js';
import { agentsCommand, createAgentCommand, showAgentCommand, runAgentCommand, previewAgentContext, updateAgentCommand, agentPermissionsCommand } from './commands/agent.js';

const program = new Command();
program.name('oraculo')
  .description('Orquestrador local de agentes de desenvolvimento')
  .version('0.1.0')
  .action(async () => {
    try {
      const result = await chatCommand({ auto: true });
      if (result?.success === false) process.exitCode = 1;
    } catch (error) {
      console.error(chalk.red('\nErro:'), error.code ?? '', error.message);
      process.exitCode = 1;
    }
  });

program.command('ask')
  .description('Envia uma tarefa diretamente para um agente')
  .argument('<agent-or-prompt>', 'Agente ou prompt entre aspas para o agente padrão')
  .argument('[prompt...]', 'Prompt para o agente explícito')
  .option('--auto', 'Seleciona agent por skills e intenção')
  .action(async (agentOrPrompt, promptParts, options) => {
    try {
      await askCommand({
        agent: promptParts.length ? agentOrPrompt : undefined,
        auto: options.auto,
        prompt: promptParts.length ? promptParts.join(' ') : agentOrPrompt,
      });
    } catch (error) {
      console.error(chalk.red('\nErro:'), error.message);
      process.exitCode = 1;
    }
  });

program.command('doctor')
  .description('Verifica ambiente e configuração sem consumir quota dos agentes')
  .action(async () => {
    try {
      const report = await doctorCommand();
      if (!report.success) process.exitCode = 1;
    } catch (error) {
      console.error(chalk.red('\nErro:'), error.message);
      process.exitCode = 1;
    }
  });

program.command('exec')
  .description('Executa operações Git permitidas pela política do projeto')
  .option('--dry-run', 'Valida a política sem iniciar processos')
  .argument('<command...>', 'Use -- git <operação> [argumentos]')
  .action(async (argv, options) => {
    try {
      const result = await execCommand(argv, { dryRun: options.dryRun });
      if (!result.success) process.exitCode = result.code === 'COMMAND_CANCELED' ? 130 : 1;
    } catch (error) {
      console.error(chalk.red('\nErro:'), error.code ?? '', error.message);
      process.exitCode = 1;
    }
  });

function agentAction(action) {
  return async (...args) => {
    try {
      const result = await action(...args);
      if (result?.success === false) process.exitCode = 1;
    } catch (error) {
      console.error(chalk.red('\nErro:'), error.code ?? '', error.message);
      process.exitCode = 1;
    }
  };
}

program.command('agents')
  .description('Lista engines e agents personalizados do projeto')
  .action(agentAction(() => agentsCommand()));

const agent = program.command('agent').description('Gerencia agents personalizados');
agent.command('create')
  .argument('<name>', 'Nome em letras minúsculas e hífens')
  .option('--engine <engine>', 'Engine: codex, claude ou opencode', 'opencode')
  .option('--role <role>', 'Responsabilidade do agent', 'developer')
  .option('--model <model>', 'Modelo do engine (ex: codex "astra", claude "sonnet")')
  .action(agentAction((name, options) => createAgentCommand(name, options)));
agent.command('show')
  .argument('<name>')
  .action(agentAction((name) => showAgentCommand(name)));
agent.command('update')
  .description('Altera engine, role, model ou descrição sem editar YAML na mão')
  .argument('<name>')
  .option('--engine <engine>', 'Engine: codex, claude ou opencode')
  .option('--role <role>', 'Responsabilidade do agent')
  .option('--model <model>', 'Modelo do engine (ex: astra, provedor/modelo)')
  .option('--description <text>', 'Descrição do perfil')
  .option('--clear-model', 'Remove o modelo (volta ao padrão do engine)')
  .action(agentAction((name, options) => updateAgentCommand(name, options)));
agent.command('permissions')
  .description('Mostra ou altera permissões do perfil')
  .argument('<name>')
  .option('--worktree <level>', 'Atalho para filesystem e Git local')
  .option('--filesystem <level>', 'disabled, read-only ou read-write')
  .option('--git-local <level>', 'disabled, read-only ou read-write')
  .option('--git-remote <level>', 'disabled, read-only ou read-write')
  .option('--knowledge <scope>', 'disabled, project, global ou both')
  .action(agentAction((name, options) => agentPermissionsCommand(name, {
    ...options,
    knowledgeWrite: options.knowledge,
  })));
agent.command('run')
  .argument('<name>')
  .argument('<prompt...>')
  .action(agentAction((name, parts) => runAgentCommand(name, parts)));

agent.command('context')
  .description('Mostra o contexto e knowledge recuperado sem executar o engine')
  .argument('<name>')
  .argument('<prompt...>')
  .action(agentAction((name, parts) => previewAgentContext(name, parts)));

const knowledge = program.command('knowledge').description('Base local de Markdown e texto');
knowledge.command('add')
  .argument('<file>')
  .option('--scope <scope>', 'global ou project', 'project')
  .action(agentAction((file, options) => knowledgeAdd(file, options)));
knowledge.command('list')
  .option('--scope <scope>', 'global ou project; padrão: ambos')
  .action(agentAction((options) => knowledgeList(options)));
knowledge.command('search')
  .argument('<query>')
  .option('--scope <scope>', 'global ou project; padrão: ambos')
  .option('--limit <number>', 'Número máximo de trechos (1 a 20)', '5')
  .option('--json', 'Saída JSON')
  .action(agentAction((query, options) => knowledgeSearch(query, options)));
knowledge.command('remove')
  .argument('<id>', 'ID exibido por knowledge list')
  .action(agentAction((id) => knowledgeRemove(id)));

const memory = program.command('memory').description('Histórico local de decisões, bugs e mudanças');
memory.command('add')
  .argument('<type>', 'decision, bug ou change')
  .argument('<text>')
  .option('--solution <text>', 'Solução para o problema registrado')
  .action(agentAction((type, text, options) => memoryAdd(type, text, options)));
memory.command('list')
  .option('--type <type>', 'decision, bug ou change')
  .option('--query <text>', 'Filtro textual')
  .option('--limit <number>', 'Quantidade de registros (1 a 100)', '20')
  .action(agentAction((options) => memoryList(options)));

program.command('pipeline')
  .argument('<task>')
  .option('--file <path>', 'Pipeline YAML no projeto')
  .option('--dry-run', 'Valida e mostra etapas sem executar')
  .action(agentAction((task, options) => pipelineCommand(task, options)));
const sessions = program.command('sessions').description('Metadados das execuções');
sessions.command('list').action(agentAction(async () => console.log(JSON.stringify(await listSessions(), null, 2))));
sessions.command('show').argument('<id>')
  .action(agentAction(async (id) => console.log(JSON.stringify(await readSession(id), null, 2))));

program.command('route')
  .description('Seleciona um agent e explica os critérios; não executa')
  .argument('<task>')
  .option('--skill <skill>', 'Skill obrigatória; pode repetir', (value, previous) => [...previous, value], [])
  .action(agentAction((task, options) => routeCommand(task, options)));

program.command('chat')
  .description('Interface interativa pergunta-resposta sobre o mesmo funil do ask')
  .argument('[agent]', 'Agente fixo da sessão (omitido roteia automaticamente)')
  .option('--auto', 'Roteia cada mensagem para um agent por skills e intenção')
  .action(async (agent, options) => {
    try {
      const result = await chatCommand({ agent, auto: options.auto });
      if (result?.success === false) process.exitCode = 1;
    } catch (error) {
      console.error(chalk.red('\nErro:'), error.code ?? '', error.message);
      process.exitCode = 1;
    }
  });

program.command('init')
  .description('Cria oraculo.config.json, agents/, knowledge/ e .oraculo/ sem sobrescrever nada')
  .option('--dry-run', 'Mostra o que seria criado sem criar nada')
  .action(agentAction((options) => initCommand(options)));

const configCmd = program.command('config')
  .description('Mostra a configuração efetiva (arquivo + defaults)')
  .argument('[path]', 'Caminho pontilhado (ex: permissions.gitLocal)')
  .action(agentAction((path, options) => configCommand(path, options)));

configCmd.command('set')
  .description('Define um valor com validação: config set runtime.timeout 60000')
  .argument('<path>', 'Caminho pontilhado (ex: permissions.gitLocal)')
  .argument('<value>', 'Valor JSON (true, 60000) ou texto')
  .action(agentAction((path, value, options) => configSetCommand(path, value, options)));
configCmd.command('unset')
  .description('Remove uma chave do arquivo (volta ao default)')
  .argument('<path>', 'Caminho pontilhado (ex: project.name)')
  .action(agentAction((path, options) => configUnsetCommand(path, options)));

const worktree = program.command('worktree').description('Isolamento Git para execução paralela; não executa engines');worktree.command('list')
  .description('Lista worktrees registradas (somente leitura)')
  .action(agentAction(() => worktreeListCommand()));
worktree.command('create')
  .description('Cria worktrees/<nome> com uma branch nova; exige filesystem e Git local em read-write')
  .argument('<name>', 'Nome em letras minúsculas e hífens')
  .option('--branch <branch>', 'Branch nova a criar (padrão: wt/<nome>)')
  .option('--dry-run', 'Valida e mostra o plano sem criar nada')
  .action(agentAction((name, options) => worktreeCreateCommand(name, options)));
worktree.command('remove')
  .description('Remove worktrees/<nome>; nunca apaga o checkout principal')
  .argument('<name>', 'Nome criado por worktree create')
  .option('--force', 'Remove mesmo com alterações não salvas')
  .option('--dry-run', 'Valida e mostra o plano sem remover nada')
  .action(agentAction((name, options) => worktreeRemoveCommand(name, options)));
worktree.command('plan')
  .description('Atribui um worktree por etapa do pipeline sem criar nada nem executar engines')
  .argument('<task>', 'Tarefa a distribuir entre worktrees isolados')
  .option('--file <path>', 'Pipeline YAML no projeto')
  .action(agentAction((task, options) => worktreePlanCommand(task, options)));

await program.parseAsync();