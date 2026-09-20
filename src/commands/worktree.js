import { listWorktrees, createWorktree, removeWorktree, planWorktrees } from '../git/worktree.js';

export async function worktreeListCommand(options = {}) {
  const worktrees = await listWorktrees(options);
  console.log(JSON.stringify(worktrees, null, 2));
  return worktrees;
}

export async function worktreeCreateCommand(name, options = {}) {
  const result = await createWorktree(name, options);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function worktreeRemoveCommand(name, options = {}) {
  const result = await removeWorktree(name, options);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

export async function worktreePlanCommand(task, options = {}) {
  const report = await planWorktrees(task, options);
  console.log(JSON.stringify(report, null, 2));
  return report;
}
