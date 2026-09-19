import chalk from 'chalk';
import ora from 'ora';
import { AgentManager } from '../agents/agent-manager.js';

export async function askCommand({ agent, prompt }) {
  const agentManager = new AgentManager();

  const selectedAgent = agentManager.getAgent(agent);

  console.log('');
  console.log(chalk.bold.cyan('MAESTRO'));
  console.log(chalk.gray('────────────────────────────'));
  console.log(`${chalk.bold('Agent:')} ${selectedAgent.name}`);
  console.log(`${chalk.bold('Prompt:')} ${prompt}`);
  console.log('');

  const spinner = ora(`Executando ${selectedAgent.name}...`).start();

  try {
    const result = await selectedAgent.run(prompt);

    spinner.succeed(`${selectedAgent.name} finalizado`);

    console.log('');
    console.log(chalk.gray('────────────────────────────'));
    console.log('');
    console.log(result);
    console.log('');
  } catch (error) {
    spinner.fail(`${selectedAgent.name} falhou`);

    throw error;
  }
}