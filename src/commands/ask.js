import { runAgent } from '../agents/agent-runner.js';
import { routeTask } from '../orchestrator/router.js';

export async function askCommand(options) {
  let result;
  if (options.auto) {
    if (options.agent) throw new Error('Use --auto com apenas a tarefa, sem agent explícito.');
    const report = await routeTask(options.prompt, { cwd: options.cwd });
    result = await runAgent({ ...options, agent: report.selected.agent });
  } else {
    result = await runAgent(options);
  }
  if (result?.output) console.log(result.output);
  return result;
}