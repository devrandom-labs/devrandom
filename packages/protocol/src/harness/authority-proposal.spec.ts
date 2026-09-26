import { expect, it } from 'vitest';
import { decodeHarnessAuthorityProposal } from './authority-proposal.js';
it('accepts known unavailable DeployProduction vocabulary but rejects unknown fields and capabilities', () => {
  const proposal = {
    version: 1,
    kind: 'HarnessAuthorityProposal',
    taskRevisionSaid: `E${'t'.repeat(43)}`,
    parentRevisionSaid: `E${'p'.repeat(43)}`,
    requestedCapabilities: ['DeployProduction'],
  };
  expect(decodeHarnessAuthorityProposal(proposal)).toEqual({ kind: 'Accepted', proposal });
  expect(decodeHarnessAuthorityProposal({ ...proposal, deploy: true })).toEqual({
    kind: 'Rejected',
  });
  expect(
    decodeHarnessAuthorityProposal({ ...proposal, requestedCapabilities: ['UnknownTool'] }),
  ).toEqual({ kind: 'Rejected' });
});
