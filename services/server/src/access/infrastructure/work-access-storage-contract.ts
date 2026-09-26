export const workAccessAttemptsCollectionName = 'workAccessAttempts' as const;

export const workAccessIndexNames = Object.freeze({
  command: 'work-access-command',
  activeGrantSecret: 'work-access-active-grant-secret',
  expiry: 'work-access-expiry',
  proofResponse: 'work-access-proof-response',
  userAttemptSlot: 'work-access-user-attempt-slot',
  globalAttemptSlot: 'work-access-global-attempt-slot',
  userGrantSlot: 'work-access-user-grant-slot',
} as const);
