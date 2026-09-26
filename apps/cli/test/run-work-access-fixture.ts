import type {
  RunWorkAccessGrant,
  RunWorkAccessRenewal,
} from '../src/work-access/application/run-work-access.js';

export function runWorkAccessFixture(
  grant: Partial<RunWorkAccessGrant> = {},
): RunWorkAccessRenewal {
  return {
    initialGrant: {
      userAid: 'user',
      credentialSaid: 'credential',
      clientInstanceId: 'client',
      issuerAid: 'issuer',
      scopes: ['run:execute', 'evidence:append', 'evidence:seal'],
      deadline: 1_800_000,
      runs: { renewLease: () => Promise.reject(new Error('not used')) },
      evidence: {
        storeArtifact: () => Promise.reject(new Error('not used')),
        appendBatch: () => Promise.reject(new Error('not used')),
        reconcileSeal: () => Promise.reject(new Error('not used')),
      },
      release: () => Promise.resolve(),
      ...grant,
    },
    acquire: () => Promise.reject(new Error('not used')),
  };
}
