import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { safePath } from '../knowledge/knowledge-manager.js';
import { prepareAgentRun } from '../agents/agent-runner.js';

const identifier = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const pipelineSchema = z.object({
  name: identifier,
  steps: z.array(z.object({
    agent: identifier,
    input: identifier.optional(),
    output: identifier,
  }).strict()).min(1).max(20),
}).strict().superRefine((pipeline, ctx) => {
  const outputs = new Set();
  pipeline.steps.forEach((step, index) => {
    if (step.input && !outputs.has(step.input)) ctx.addIssue({
      code: 'custom', path: ['steps', index, 'input'], message: 'Input deve referenciar output de uma etapa anterior.',
    });
    if (outputs.has(step.output)) ctx.addIssue({
      code: 'custom', path: ['steps', index, 'output'], message: 'Output duplicado.',
    });
    outputs.add(step.output);
  });
});

const defaultPipeline = {
  name: 'default-development',
  steps: [
    { agent: 'architect', output: 'plan' },
    { agent: 'developer', input: 'plan', output: 'implementation' },
    { agent: 'reviewer', input: 'implementation', output: 'review' },
    { agent: 'developer', input: 'review', output: 'fix' },
  ],
};

export async function loadPipeline({ cwd = process.cwd(), file } = {}) {
  if (!file) return pipelineSchema.parse(defaultPipeline);
  const path = resolve(cwd, file);
  await safePath(cwd, path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 65536) throw new Error('Pipeline deve ser arquivo regular de até 64 KiB.');
  const document = parseDocument(await readFile(path, 'utf8'), { uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new Error('YAML de pipeline inválido.');
  return pipelineSchema.parse(document.toJS({ maxAliasCount: 0 }));
}

export async function preparePipeline(task, { cwd = process.cwd(), file } = {}) {
  const pipeline = await loadPipeline({ cwd, file });
  const steps = [];
  for (const step of pipeline.steps) {
    const { context, adapter } = await prepareAgentRun({ agent: step.agent, prompt: task, cwd });
    steps.push({ ...step, context, engineName: adapter.name });
  }
  return { name: pipeline.name, task, steps };
}