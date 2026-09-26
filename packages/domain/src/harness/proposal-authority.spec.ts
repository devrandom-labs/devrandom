import { expect, it } from 'vitest';
import { authorizeHarnessProposal } from './proposal-authority.js';
it('uses the same current scope intersection for ordinary requests and unavailable authority proposals', () => {
  const scope = {
    taskCapabilities: ['ReadRepository'] as const,
    unavailableCapabilities: ['EditRepository'] as const,
    mandateCapabilities: ['ReadRepository', 'EditRepository'] as const,
  };
  expect(authorizeHarnessProposal({ ...scope, requestedCapabilities: ['ReadRepository'] })).toEqual(
    { kind: 'InScope' },
  );
  for (const capability of [
    'DeployProduction',
    'ActivateHarnessRevision',
    'ReplaceProtectedEvaluationManifest',
    'DeleteEvaluationEvidence',
    'ExpandMandate',
  ] as const)
    expect(authorizeHarnessProposal({ ...scope, requestedCapabilities: [capability] })).toEqual({
      kind: 'Denied',
      reason: 'CapabilityNotGranted',
      capabilities: [capability],
    });
  expect(authorizeHarnessProposal({ ...scope, requestedCapabilities: ['EditRepository'] })).toEqual(
    { kind: 'Denied', reason: 'CapabilityNotGranted', capabilities: ['EditRepository'] },
  );
  expect(
    authorizeHarnessProposal({
      ...scope,
      mandateCapabilities: [],
      requestedCapabilities: ['ReadRepository'],
    }),
  ).toEqual({ kind: 'Denied', reason: 'CapabilityNotGranted', capabilities: ['ReadRepository'] });
});
