import { describe, expect, it, vi } from 'vitest';
import {
  prepareActivationCommitCommand,
  preparePromotionSelectionRecord,
  type ActiveHarnessPointer,
} from '@devrandom/protocol';

import { readCurrentActivation } from './read-current-activation.js';

const said = (character: string): string => `E${character.repeat(43)}`;

function committed() {
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
  const command = prepared.command;
  const pointer: Extract<ActiveHarnessPointer, { kind: 'Committed' }> = {
    version: 1,
    kind: 'Committed',
    taskId: command.taskId,
    taskRevisionSaid: command.taskRevisionSaid,
    harnessLineageId: command.harnessLineageId,
    activeRevisionSaid: command.expectedIncumbentRevisionSaid,
    pointerVersion: 2,
    commandId: command.commandId,
    decisionReceiptSaid: said('r'),
    disposition: 'Retained',
  };
  return { command, pointer };
}

describe('current activation read', () => {
  it('never returns an initial pointer for another Task', async () => {
    const { command, pointer } = committed();
    expect(
      await readCurrentActivation(
        { ownerAid: said('o'), taskId: command.taskId },
        {
          source: {
            inspectCurrent: () =>
              Promise.resolve({
                kind: 'Initial' as const,
                pointer: {
                  version: 1 as const,
                  kind: 'Initial' as const,
                  taskId: '44444444-4444-4444-8444-444444444444',
                  taskRevisionSaid: pointer.taskRevisionSaid,
                  harnessLineageId: pointer.harnessLineageId,
                  activeRevisionSaid: pointer.activeRevisionSaid,
                  pointerVersion: 1 as const,
                },
              }),
          },
          receipts: {
            sign: () => Promise.resolve({ kind: 'Unavailable' }),
            inspect: () => Promise.resolve('Rejected'),
          },
        },
      ),
    ).toEqual({ kind: 'Conflict' });
  });

  it('requires the exact issuer receipt before exposing the committed pointer', async () => {
    const { command, pointer } = committed();
    const input = { ownerAid: said('o'), taskId: command.taskId };
    const source = {
      inspectCurrent: () =>
        Promise.resolve({ kind: 'Committed' as const, command, pointer, recipientAid: said('a') }),
    };
    const inspect = vi.fn(() => Promise.resolve<'Verified' | 'Rejected'>('Rejected'));
    const receipts = {
      sign: () => Promise.resolve({ kind: 'Unavailable' as const }),
      inspect,
    };
    expect(await readCurrentActivation(input, { source, receipts })).toEqual({ kind: 'Conflict' });
    inspect.mockResolvedValue('Verified');
    expect(await readCurrentActivation(input, { source, receipts })).toEqual({
      kind: 'Read',
      pointer,
    });
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        command,
        recipientAid: said('a'),
        receiptSaid: pointer.decisionReceiptSaid,
      }),
    );
  });

  it('rejects a substituted active revision before receipt verification', async () => {
    const { command, pointer } = committed();
    const inspect = vi.fn(() => Promise.resolve<'Verified'>('Verified'));
    expect(
      await readCurrentActivation(
        { ownerAid: said('o'), taskId: command.taskId },
        {
          source: {
            inspectCurrent: () =>
              Promise.resolve({
                kind: 'Committed' as const,
                command,
                pointer: { ...pointer, activeRevisionSaid: said('x') },
                recipientAid: said('a'),
              }),
          },
          receipts: { sign: () => Promise.resolve({ kind: 'Unavailable' }), inspect },
        },
      ),
    ).toEqual({ kind: 'Conflict' });
    expect(inspect).not.toHaveBeenCalled();
  });
});
