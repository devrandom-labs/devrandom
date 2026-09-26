import { describe, expect, it } from 'vitest';
import Value from 'typebox/value';

import {
  activationCommitCommandSchema,
  activationCommitReceiptSchema,
  decodeActivationCommitCommand,
  prepareActivationCommitCommand,
  type ActivationCommitCommandInput,
} from './activation-command.js';
import { preparePromotionSelectionRecord } from './selection-record.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const selection = preparePromotionSelectionRecord({
  taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
  taskRevisionSaid: said('t'),
  harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
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
if (selection.kind !== 'Prepared') throw new Error('selection fixture rejected');
const input: ActivationCommitCommandInput = {
  version: 1,
  commandId: '6eb93221-1ad0-4555-9aa3-b2ff2ed541a6',
  taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
  taskRevisionSaid: said('t'),
  harnessLineageId: '5ebf49b9-df26-4a49-9194-da868f97cf9d',
  expectedIncumbentRevisionSaid: said('h'),
  expectedPointerVersion: 1,
  evaluationManifestSaid: said('m'),
  evaluationClosureSaid: said('e'),
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
};

describe('activation CAS command contract', () => {
  it('prepares one stable fingerprint and accepts an exact retry', () => {
    const prepared = prepareActivationCommitCommand(input);
    expect(prepared).toMatchObject({ kind: 'Prepared', command: { ...input } });
    if (prepared.kind !== 'Prepared') throw new Error('fixture rejected');
    expect(prepared.command.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(decodeActivationCommitCommand(prepared.command)).toEqual({
      kind: 'Accepted',
      command: prepared.command,
    });
    expect(prepareActivationCommitCommand(input)).toEqual(prepared);
  });

  it('rejects changed candidate or evidence after command fingerprint is frozen', () => {
    const prepared = prepareActivationCommitCommand(input);
    if (prepared.kind !== 'Prepared') throw new Error('fixture rejected');
    expect(
      decodeActivationCommitCommand({
        ...prepared.command,
        evaluationClosureSaid: said('q'),
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SelectionRecordMismatch' });
    expect(
      decodeActivationCommitCommand({
        ...prepared.command,
        disposition: { ...input.disposition, candidateRevisionSaid: said('w') },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SelectionRecordMismatch' });
  });

  it('rejects a substituted selection record even with a recomputed command fingerprint', () => {
    const alternative = preparePromotionSelectionRecord({
      taskId: input.taskId,
      taskRevisionSaid: input.taskRevisionSaid,
      harnessLineageId: input.harnessLineageId,
      expectedIncumbentRevisionSaid: input.expectedIncumbentRevisionSaid,
      expectedPointerVersion: input.expectedPointerVersion,
      evaluationManifestSaid: input.evaluationManifestSaid,
      evaluationClosureSaid: input.evaluationClosureSaid,
      hypothesisSaid: said('w'),
      selection: selection.record.selection,
    });
    if (alternative.kind !== 'Prepared') throw new Error('alternative fixture rejected');
    expect(
      prepareActivationCommitCommand({ ...input, selectionRecord: alternative.record }),
    ).toEqual({ kind: 'Rejected', reason: 'SelectionRecordMismatch' });
    const prepared = prepareActivationCommitCommand(input);
    if (prepared.kind !== 'Prepared') throw new Error('fixture rejected');
    expect(
      decodeActivationCommitCommand({ ...prepared.command, agentProposalExchangeSaid: said('q') }),
    ).toEqual({ kind: 'Rejected', reason: 'FingerprintMismatch' });
  });

  it('does not accept H1 as its own successor, owner overrides, or missing signed references', () => {
    expect(
      prepareActivationCommitCommand({
        ...input,
        disposition: {
          ...input.disposition,
          candidateRevisionSaid: input.expectedIncumbentRevisionSaid,
        },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'IncumbentAsSuccessor' });
    expect(prepareActivationCommitCommand({ ...input, ownerAid: said('o') })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
    expect(prepareActivationCommitCommand({ ...input, governorDecisionExchangeSaid: '' })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
  });

  it('retention is an explicit signed record with no active-pointer switch', () => {
    const retainedSelection = preparePromotionSelectionRecord({
      taskId: input.taskId,
      taskRevisionSaid: input.taskRevisionSaid,
      harnessLineageId: input.harnessLineageId,
      expectedIncumbentRevisionSaid: input.expectedIncumbentRevisionSaid,
      expectedPointerVersion: input.expectedPointerVersion,
      evaluationManifestSaid: input.evaluationManifestSaid,
      evaluationClosureSaid: input.evaluationClosureSaid,
      hypothesisSaid: selection.record.hypothesisSaid,
      selection: { kind: 'RetainIncumbent' },
    });
    if (retainedSelection.kind !== 'Prepared') throw new Error('retained fixture rejected');
    const retained = prepareActivationCommitCommand({
      ...input,
      selectionRecord: retainedSelection.record,
      disposition: { kind: 'RetainIncumbent', selectionEvidenceSaid: retainedSelection.record.d },
    });
    expect(retained).toMatchObject({
      kind: 'Prepared',
      command: { disposition: { kind: 'RetainIncumbent' } },
    });
    if (retained.kind !== 'Prepared') throw new Error('retention fixture rejected');
    expect(decodeActivationCommitCommand(retained.command).kind).toBe('Accepted');
    expect(
      decodeActivationCommitCommand({
        ...retained.command,
        disposition: { ...retained.command.disposition, candidateRevisionSaid: said('c') },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SchemaInvalid' });
  });

  it('keeps commit receipts closed and attributable to one pointer version', () => {
    const accepted = {
      kind: 'Committed',
      decisionReceiptSaid: said('r'),
      activeRevisionSaid: said('c'),
      pointerVersion: 2,
      disposition: 'Activated',
    };
    expect(Value.Check(activationCommitReceiptSchema, accepted)).toBe(true);
    expect(
      Value.Check(activationCommitReceiptSchema, { ...accepted, selectedByServer: 'C2' }),
    ).toBe(false);
    expect(
      Value.Check(activationCommitCommandSchema, {
        ...input,
        fingerprint: `sha256:${'f'.repeat(64)}`,
      }),
    ).toBe(true);
  });
});
