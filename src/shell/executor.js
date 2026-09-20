import { loadConfig } from '../config/loader.js';
import { guardCommand } from '../permissions/command-guard.js';
import { runGit } from '../git/git-manager.js';
import { runProcess } from './process.js';
import { policyError } from '../permissions/policies.js';

export async function executeCommand(argv, { cwd = process.cwd(), dryRun = false, cancelSignal } = {}) {
  const config = await loadConfig({ cwd });
  const operation = guardCommand(argv, config);
  if (dryRun) return { success: true, dryRun: true, exitCode: 0, operation };
  return runGit(operation, { cwd, timeout: config.runtime.timeout, cancelSignal });
}

// Doctor intentionally probes installations even when the task policy denies Git.
export function runDiagnostic(command, args, options = {}) {
  const version = ['npm', 'git', 'codex', 'claude', 'opencode'].includes(command) &&
    args.length === 1 && args[0] === '--version';
  const repository = command === 'git' &&
    JSON.stringify(args) === JSON.stringify(['rev-parse', '--is-inside-work-tree']);
  if (!version && !repository) throw policyError('diagnóstico não permitido.', 'COMMAND_DENIED');
  return runProcess(command, args, { cwd: options.cwd, timeout: options.timeout ?? 5000 });
}