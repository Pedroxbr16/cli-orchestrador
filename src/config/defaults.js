export const defaults = {
  agents: { default: 'opencode' },
  permissions: {
    filesystem: 'read-write',
    gitLocal: 'read-write',
    gitRemote: 'disabled',
  },
  git: {
    protection: {
      forcePush: false,
      pushMain: false,
      pushDevelop: false,
      deleteRemoteBranch: false,
      deleteRemoteTag: false,
    },
  },
  runtime: { timeout: 300000 },
};