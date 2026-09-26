import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { prepareActivationCommitCommand } from './activation-command.js';
import { preparePromotionSelectionRecord } from './selection-record.js';
import { activationReceiptPayload, activationReceiptPayloadSchema } from './activation-receipt.js';

const said = (character: string): string => `E${character.repeat(43)}`;

describe('signed issuer activation receipt payload', () => {
  it('binds the exact command and intended CAS result without claiming a KERIA signature', () => {
    const selection = preparePromotionSelectionRecord({
      taskId: '11111111-1111-4111-8111-111111111111',
      taskRevisionSaid: said('t'),
      harnessLineageId: '22222222-2222-4222-8222-222222222222',
      expectedIncumbentRevisionSaid: said('h'),
      expectedPointerVersion: 1,
      evaluationManifestSaid: said('m'),
      evaluationClosureSaid: said('c'),
      hypothesisSaid: said('i'),
      selection: { kind: 'RetainIncumbent' },
    });
    if (selection.kind !== 'Prepared') throw new Error(selection.reason);
    const command = prepareActivationCommitCommand({
      version: 1,
      commandId: '33333333-3333-4333-8333-333333333333',
      taskId: selection.record.taskId,
      taskRevisionSaid: selection.record.taskRevisionSaid,
      harnessLineageId: selection.record.harnessLineageId,
      expectedIncumbentRevisionSaid: selection.record.expectedIncumbentRevisionSaid,
      expectedPointerVersion: selection.record.expectedPointerVersion,
      evaluationManifestSaid: selection.record.evaluationManifestSaid,
      evaluationClosureSaid: selection.record.evaluationClosureSaid,
      exactPromotionMandateSaid: said('a'),
      agentProposalExchangeSaid: said('p'),
      governorDecisionExchangeSaid: said('g'),
      selectionRecord: selection.record,
      disposition: { kind: 'RetainIncumbent', selectionEvidenceSaid: selection.record.d },
    });
    if (command.kind !== 'Prepared') throw new Error(command.reason);
    const payload = activationReceiptPayload(command.command);
    expect(Value.Check(activationReceiptPayloadSchema, payload)).toBe(true);
    expect(payload).toMatchObject({
      commandFingerprint: command.command.fingerprint,
      expectedPointerVersion: 1,
      pointerVersion: 2,
      activeRevisionSaid: said('h'),
      governorDecisionExchangeSaid: said('g'),
    });
    expect(Value.Check(activationReceiptPayloadSchema, { ...payload, pointerVersion: 1 })).toBe(
      false,
    );
  });
});
