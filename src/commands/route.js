import { routeTask } from '../orchestrator/router.js';

export async function routeCommand(task, { skill = [], ...options } = {}) {
  const report = await routeTask(task, { ...options, skills: skill });
  console.log(JSON.stringify(report, null, 2));
  return report;
}