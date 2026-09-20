import { z } from 'zod';
import { defaults } from './defaults.js';

const accessLevel = z.enum(['disabled', 'read-only', 'read-write']);

export const configSchema = z.object({
  project: z.object({ name: z.string().trim().min(1) }).strict().optional(),
  agents: z.object({
    default: z.string().trim().min(1).default(defaults.agents.default),
  }).strict().prefault({}),
  permissions: z.object({
    filesystem: accessLevel.default(defaults.permissions.filesystem),
    gitLocal: accessLevel.default(defaults.permissions.gitLocal),
    gitRemote: accessLevel.default(defaults.permissions.gitRemote),
  }).strict().prefault({}),
  git: z.object({
    protection: z.object({
      forcePush: z.boolean().default(false),
      pushMain: z.boolean().default(false),
      pushDevelop: z.boolean().default(false),
      deleteRemoteBranch: z.boolean().default(false),
      deleteRemoteTag: z.boolean().default(false),
    }).strict().prefault({}),
  }).strict().prefault({}),
  runtime: z.object({
    timeout: z.number().int().min(1).max(2147483647).default(defaults.runtime.timeout),
  }).strict().prefault({}),
}).strict();