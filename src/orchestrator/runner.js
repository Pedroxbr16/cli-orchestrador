// Internal sequential coordinator. It has no CLI switch for arbitrary executors.
export async function executeSequence(plan, { execute, cancelSignal, onStep = async () => {} } = {}) {
  if (typeof execute !== 'function') throw new Error('Executor seguro não configurado.');
  const outputs = new Map();
  const steps = [];
  for (const step of plan.steps) {
    if (cancelSignal?.aborted) return { status: 'canceled', steps };
    const context = structuredClone(step.context);
    if (step.input) context.previous = {
      source: step.input, data: structuredClone(outputs.get(step.input)), trust: 'reference-data',
    };
    const startedAt = new Date().toISOString();
    try {
      const result = await execute({ ...step, context }, { cancelSignal });
      if (cancelSignal?.aborted) return { status: 'canceled', steps };
      if (!result || result.success !== true) throw Object.assign(new Error('Etapa falhou.'), { code: 'STEP_FAILED' });
      const data = result.output;
      const serialized = JSON.stringify(data);
      if (serialized === undefined || Buffer.byteLength(serialized) > 32768) {
        throw Object.assign(new Error('Output inválido ou excede 32 KiB.'), { code: 'OUTPUT_INVALID' });
      }
      outputs.set(step.output, JSON.parse(serialized));
      steps.push({ agent: step.agent, output: step.output, startedAt, status: 'completed' });
      await onStep([...steps]);
    } catch (error) {
      const status = cancelSignal?.aborted ? 'canceled' : 'failed';
      steps.push({ agent: step.agent, output: step.output, startedAt, status, code: error.code ?? 'STEP_FAILED' });
      await onStep([...steps]);
      return { status, steps };
    }
  }
  return { status: 'completed', steps, outputs: Object.fromEntries(outputs) };
}