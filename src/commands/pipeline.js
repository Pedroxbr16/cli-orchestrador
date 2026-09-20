import { randomUUID } from 'node:crypto';
import { preparePipeline } from '../orchestrator/pipeline.js';
import { executeSequence } from '../orchestrator/runner.js';
import { assertAgentExecution } from '../permissions/permission-manager.js';
import { saveSession } from '../orchestrator/session.js';
import { AgentManager } from '../agents/agent-manager.js';

export async function pipelineCommand(task, { cwd = process.cwd(), file, dryRun = false } = {}) {
  const plan = await preparePipeline(task, { cwd, file });
  if (dryRun) {
    console.log(JSON.stringify({
      name: plan.name, execution: 'blocked-until-secure-engine', steps: plan.steps.map((step) => ({
        agent: step.agent, engine: step.context.engine, input: step.input, output: step.output,
        permissions: step.context.permissions,
      })),
    }, null, 2));
    return { success: true, plan };
  }
  // Check all engines before any session, worktree, or agent subprocess is created.
  // Pipelines incluem etapas de escrita: continuam bloqueados na Fase 10.
  for (const step of plan.steps) assertAgentExecution(step.engineName, { write: true });
  const session = { id: randomUUID(), name: plan.name, startedAt: new Date().toISOString(), status: 'running', steps: [] };
  await saveSession(session, { cwd, create: true });
  const result = await executeSequence(plan, {
    execute: (step) => new AgentManager().getAgent(step.context.engine).run(step.context.task, { cwd, context: step.context }),
    onStep: async (steps) => { session.steps = steps; await saveSession(session, { cwd }); },
  });
  session.status = result.status;
  session.steps = result.steps;
  await saveSession(session, { cwd });
  console.log(JSON.stringify({ id: session.id, status: session.status }, null, 2));
  return { success: result.status === 'completed' };
}