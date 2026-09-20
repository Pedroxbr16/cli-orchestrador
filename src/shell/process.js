import { execa } from 'execa';

// Internal transport. User commands must go through executor.js.
export async function runProcess(command, args, {
  cwd = process.cwd(), timeout = 300000, env, cancelSignal,
} = {}) {
  const started = performance.now();
  const controller = new AbortController();
  let child;
  let deadline;
  let cancellationDeadline;
  const killGroup = () => {
    if (child?.pid && process.platform !== 'win32') {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL');
      }
    }
  };
  const cancel = () => {
    controller.abort();
    cancellationDeadline ??= setTimeout(killGroup, 1000);
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  if (cancelSignal?.aborted) controller.abort();
  cancelSignal?.addEventListener('abort', cancel, { once: true });
  let failed = true;
  try {
    child = execa(command, args, {
      cwd, env, extendEnv: env === undefined,
      timeout, cancelSignal: controller.signal, shell: false,
      stdin: 'ignore', reject: false, cleanup: true, forceKillAfterDelay: 1000,
      maxBuffer: 10 * 1024 * 1024,
      detached: process.platform !== 'win32',
    });
    // Execa terminates the direct child; also bound the lifetime of Git helpers.
    deadline = setTimeout(killGroup, Math.min(timeout + 1000, 2147483647));
    const result = await child;
    failed = result.failed;
    return {
      success: result.exitCode === 0 && !result.failed,
      stdout: result.stdout ?? '', stderr: result.stderr ?? '',
      exitCode: result.exitCode ?? 1,
      code: result.timedOut ? 'COMMAND_TIMEOUT' : result.isCanceled ? 'COMMAND_CANCELED' :
        result.code === 'ENOENT' ? 'COMMAND_NOT_FOUND' : result.failed ? 'COMMAND_FAILED' : undefined,
      timedOut: result.timedOut, isCanceled: result.isCanceled,
      duration: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(deadline);
    clearTimeout(cancellationDeadline);
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
    cancelSignal?.removeEventListener('abort', cancel);
    if (failed) killGroup();
  }
}
