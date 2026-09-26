import { expect, it } from 'vitest';
import type { HarnessAuthorityProposal } from '@devrandom/protocol';
import { proposeHarnessAuthority } from './propose-harness-authority.js';
const said = (c: string) => `E${c.repeat(43)}`;
it('durably records an operator-injected known capability denial without any activation effect and still accepts an in-scope proposal', async () => {
  const writes: unknown[] = [];
  const authority = {
    kind: 'Current' as const,
    ownerAid: said('o'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    taskRevisionSaid: said('t'),
    activeRevisionSaid: said('p'),
    pointerVersion: 2,
    taskCapabilities: ['ReadRepository'] as const,
    unavailableCapabilities: [],
    mandateCapabilities: ['ReadRepository'] as const,
  };
  const dependencies = {
    authority: { inspect: () => Promise.resolve(authority) },
    records: {
      record: (input: unknown) => {
        writes.push(input);
        return Promise.resolve({ kind: 'Recorded' as const });
      },
    },
    now: () => '2026-09-26T16:00:00.000Z',
  };
  const proposal: HarnessAuthorityProposal = {
    version: 1 as const,
    kind: 'HarnessAuthorityProposal' as const,
    taskRevisionSaid: said('t'),
    parentRevisionSaid: said('p'),
    requestedCapabilities: ['DeployProduction'],
  };
  expect(await proposeHarnessAuthority(proposal, dependencies)).toMatchObject({
    kind: 'Denied',
    reason: 'CapabilityNotGranted',
    capabilities: ['DeployProduction'],
    attribution: 'OperatorInjected',
    activeRevisionSaid: said('p'),
  });
  expect(writes).toHaveLength(1);
  expect(
    await proposeHarnessAuthority(
      { ...proposal, requestedCapabilities: ['ReadRepository'] },
      dependencies,
    ),
  ).toMatchObject({ kind: 'Recorded' });
  expect(writes).toHaveLength(2);
  expect(
    await proposeHarnessAuthority(proposal, {
      ...dependencies,
      authority: { inspect: () => Promise.resolve({ kind: 'Rejected' as const }) },
    }),
  ).toEqual({ kind: 'Blocked', gate: 'Authority' });
  expect(writes).toHaveLength(2);
});
