import { describe, expect, it, vi } from 'vitest';

import {
  prepareActivationCommitCommand,
  preparePromotionSelectionRecord,
  type ActivationCommitReceipt,
} from '@devrandom/protocol';

import { commitActivation } from './commit-activation.js';

const said = (character: string): string => `E${character.repeat(43)}`;

describe('hosted activation commit', () => {
  it('never finalizes a reserved successor without an exact issuer-signed receipt', async () => {
    const selection = preparePromotionSelectionRecord({
      taskId: '22222222-2222-4222-8222-222222222222',
      taskRevisionSaid: said('t'),
      harnessLineageId: '33333333-3333-4333-8333-333333333333',
      expectedIncumbentRevisionSaid: said('h'),
      expectedPointerVersion: 1,
      evaluationManifestSaid: said('m'),
      evaluationClosureSaid: said('e'),
      hypothesisSaid: said('i'),
      selection: {
        kind: 'Activate',
        candidateRevisionSaid: said('c'),
        artifactSaids: [said('x'), said('y'), said('z')],
      },
    });
    if (selection.kind !== 'Prepared') throw new Error(selection.reason);
    const prepared = prepareActivationCommitCommand({
      version: 1,
      commandId: '11111111-1111-4111-8111-111111111111',
      taskId: selection.record.taskId,
      taskRevisionSaid: selection.record.taskRevisionSaid,
      harnessLineageId: selection.record.harnessLineageId,
      expectedIncumbentRevisionSaid: selection.record.expectedIncumbentRevisionSaid,
      expectedPointerVersion: 1,
      evaluationManifestSaid: selection.record.evaluationManifestSaid,
      evaluationClosureSaid: selection.record.evaluationClosureSaid,
      exactPromotionMandateSaid: said('a'),
      agentProposalExchangeSaid: said('p'),
      governorDecisionExchangeSaid: said('g'),
      selectionRecord: selection.record,
      disposition: {
        kind: 'Activate',
        selectionEvidenceSaid: selection.record.d,
        candidateRevisionSaid: said('c'),
        artifactSaids: [said('x'), said('y'), said('z')],
      },
    });
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    const command = prepared.command;
    const finalize = vi.fn(() =>
      Promise.resolve({
        kind: 'Committed' as const,
        receipt: {
          kind: 'Committed' as const,
          decisionReceiptSaid: said('r'),
          activeRevisionSaid: said('c'),
          pointerVersion: 2,
          disposition: 'Activated' as const,
        } satisfies ActivationCommitReceipt,
      }),
    );
    const result = await commitActivation(
      { ownerAid: said('o'), command },
      {
        authority: {
          verify: () =>
            Promise.resolve({
              kind: 'Authorized',
              personalAgentAid: said('a'),
              governorAid: said('g'),
            }),
        },
        storage: {
          inspect: () => Promise.resolve({ kind: 'Absent' }),
          reserve: () => Promise.resolve({ kind: 'Reserved', preparedAt: 1_790_000_000_000 }),
          finalize,
        },
        receipts: {
          sign: () => Promise.resolve({ kind: 'Rejected' }),
          inspect: () => Promise.resolve('Rejected' as const),
        },
      },
    );
    expect(result).toEqual({ kind: 'Rejected', gate: 'Signature' });
    expect(finalize).not.toHaveBeenCalled();
  });

  it('does not disclose a prepared issuer receipt when final pointer CAS fails', async () => {
    const selection = preparePromotionSelectionRecord({
      taskId: '22222222-2222-4222-8222-222222222222',
      taskRevisionSaid: said('t'),
      harnessLineageId: '33333333-3333-4333-8333-333333333333',
      expectedIncumbentRevisionSaid: said('h'),
      expectedPointerVersion: 1,
      evaluationManifestSaid: said('m'),
      evaluationClosureSaid: said('e'),
      hypothesisSaid: said('i'),
      selection: { kind: 'RetainIncumbent' },
    });
    if (selection.kind !== 'Prepared') throw new Error(selection.reason);
    const prepared = prepareActivationCommitCommand({
      version: 1,
      commandId: '11111111-1111-4111-8111-111111111111',
      taskId: selection.record.taskId,
      taskRevisionSaid: selection.record.taskRevisionSaid,
      harnessLineageId: selection.record.harnessLineageId,
      expectedIncumbentRevisionSaid: selection.record.expectedIncumbentRevisionSaid,
      expectedPointerVersion: 1,
      evaluationManifestSaid: selection.record.evaluationManifestSaid,
      evaluationClosureSaid: selection.record.evaluationClosureSaid,
      exactPromotionMandateSaid: said('a'),
      agentProposalExchangeSaid: said('p'),
      governorDecisionExchangeSaid: said('g'),
      selectionRecord: selection.record,
      disposition: { kind: 'RetainIncumbent', selectionEvidenceSaid: selection.record.d },
    });
    if (prepared.kind !== 'Prepared') throw new Error(prepared.reason);
    const receiptSaid = said('r');
    const outcome = await commitActivation(
      { ownerAid: said('o'), command: prepared.command },
      {
        authority: {
          verify: () =>
            Promise.resolve({
              kind: 'Authorized',
              personalAgentAid: said('a'),
              governorAid: said('g'),
            }),
        },
        storage: {
          inspect: () => Promise.resolve({ kind: 'Absent' }),
          reserve: () => Promise.resolve({ kind: 'Reserved', preparedAt: 1_790_000_000_000 }),
          finalize: () => Promise.resolve({ kind: 'Conflict' }),
        },
        receipts: {
          sign: () => Promise.resolve({ kind: 'Signed', receiptSaid }),
          inspect: () => Promise.resolve('Verified'),
        },
      },
    );
    expect(outcome).toEqual({ kind: 'Conflict' });
    expect(JSON.stringify(outcome)).not.toContain(receiptSaid);
  });
});
