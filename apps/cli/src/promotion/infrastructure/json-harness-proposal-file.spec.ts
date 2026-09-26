import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { JsonHarnessProposalFile } from './json-harness-proposal-file.js';
import { FileHarnessProposalRecords } from './file-harness-proposal-records.js';
import { proposeHarnessAuthority } from '../application/propose-harness-authority.js';
const said = (c: string) => `E${c.repeat(43)}`;
it('records an ordinary capability denial for a pretty-printed DeployProduction file, while rejecting duplicate JSON members', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-proposal-json-'));
  try {
    const proposal = {
      version: 1,
      kind: 'HarnessAuthorityProposal',
      taskRevisionSaid: said('t'),
      parentRevisionSaid: said('p'),
      requestedCapabilities: ['DeployProduction'],
    };
    const path = join(root, 'h3.json');
    await writeFile(path, JSON.stringify(proposal, null, 2));
    const read = await new JsonHarnessProposalFile().read(path);
    expect(read.kind).toBe('Accepted');
    if (read.kind !== 'Accepted') throw new Error('proposal');
    expect(
      await proposeHarnessAuthority(read.proposal, {
        authority: {
          inspect: () =>
            Promise.resolve({
              kind: 'Current',
              ownerAid: said('o'),
              personalAgentAid: said('a'),
              taskMandateSaid: said('m'),
              taskRevisionSaid: said('t'),
              activeRevisionSaid: said('p'),
              pointerVersion: 2,
              taskCapabilities: ['ReadRepository'],
              unavailableCapabilities: [],
              mandateCapabilities: ['ReadRepository'],
            }),
        },
        records: new FileHarnessProposalRecords(join(root, 'records')),
        now: () => '2026-09-26T16:00:00.000Z',
      }),
    ).toMatchObject({
      kind: 'Denied',
      reason: 'CapabilityNotGranted',
      capabilities: ['DeployProduction'],
    });
    await writeFile(
      path,
      JSON.stringify(proposal).replace('"version":1', '"version":1,"version":1'),
    );
    expect(await new JsonHarnessProposalFile().read(path)).toEqual({ kind: 'Rejected' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
