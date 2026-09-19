#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { askCommand } from './commands/ask.js';

const program = new Command();

program
  .name('maestro')
  .description('Orquestrador local de agentes de desenvolvimento')
  .version('0.1.0');

program
  .command('ask')
  .description('Envia uma tarefa diretamente para um agente')
  .argument('<agent>', 'Agente que será utilizado: codex ou opencode')
  .argument('<prompt...>', 'Prompt que será enviado para o agente')
  .action(async (agent, promptParts) => {
    try {
      const prompt = promptParts.join(' ');

      await askCommand({
        agent,
        prompt,
      });
    } catch (error) {
      console.error(
        chalk.red('\nErro:'),
        error.message
      );

      process.exitCode = 1;
    }
  });

program.parse();