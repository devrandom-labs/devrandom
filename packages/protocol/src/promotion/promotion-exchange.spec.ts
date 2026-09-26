import { describe, expect, it } from 'vitest';
import Value from 'typebox/value';

import { prepareActivationCommitCommand } from './activation-command.js';
import { preparePromotionSelectionRecord } from './selection-record.js';
import {
  activationExchangeBindings,
  governorPromotionDecisionPayloadSchema,
  promotionProposalPayloadSchema,
} from './promotion-exchange.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const taskId = '4df838a8-5109-49fd-bdad-805880a3ecee';
const lineageId = '5ebf49b9-df26-4a49-9194-da868f97cf9d';
const disposition = {
  kind: 'Activate' as const,
  selectionEvidenceSaid: said('s'),
  candidateRevisionSaid: said('c'),
  artifactSaids: [said('x'), said('y'), said('z')],
};
const selectionRecord = preparePromotionSelectionRecord({
  taskId,
  taskRevisionSaid: said('t'),
  harnessLineageId: lineageId,
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
if (selectionRecord.kind !== 'Prepared') throw new Error('selection fixture rejected');
disposition.selectionEvidenceSaid = selectionRecord.record.d;
const proposal = {
  version: 1 as const,
  kind: 'PromotionProposal' as const,
  taskId,
  taskRevisionSaid: said('t'),
  harnessLineageId: lineageId,
  expectedIncumbentRevisionSaid: said('h'),
  expectedPointerVersion: 1,
  hypothesisSaid: said('i'),
  evaluationManifestSaid: said('m'),
  evaluationClosureSaid: said('e'),
  disposition,
};
const decision = {
  version: 1 as const,
  kind: 'GovernorPromotionDecision' as const,
  taskId,
  taskRevisionSaid: said('t'),
  harnessLineageId: lineageId,
  expectedIncumbentRevisionSaid: said('h'),
  expectedPointerVersion: 1,
  evaluationManifestSaid: said('m'),
  evaluationClosureSaid: said('e'),
  exactPromotionMandateSaid: said('a'),
  agentProposalExchangeSaid: said('p'),
  disposition,
};
const command = prepareActivationCommitCommand({
  version: 1,
  commandId: '6eb93221-1ad0-4555-9aa3-b2ff2ed541a6',
  taskId,
  taskRevisionSaid: said('t'),
  harnessLineageId: lineageId,
  expectedIncumbentRevisionSaid: said('h'),
  expectedPointerVersion: 1,
  evaluationManifestSaid: said('m'),
  evaluationClosureSaid: said('e'),
  exactPromotionMandateSaid: said('a'),
  agentProposalExchangeSaid: said('p'),
  governorDecisionExchangeSaid: said('g'),
  selectionRecord: selectionRecord.record,
  disposition,
});

describe('promotion EXN payload bindings', () => {
  it('requires closed, exact proposal and Governor decision payloads', () => {
    expect(Value.Check(promotionProposalPayloadSchema, proposal)).toBe(true);
    expect(Value.Check(governorPromotionDecisionPayloadSchema, decision)).toBe(true);
    expect(Value.Check(promotionProposalPayloadSchema, { ...proposal, ownerAid: said('o') })).toBe(
      false,
    );
    expect(
      Value.Check(governorPromotionDecisionPayloadSchema, { ...decision, decisionByModel: true }),
    ).toBe(false);
  });

  it('binds both signed payloads to the same exact CAS command', () => {
    if (command.kind !== 'Prepared') throw new Error('command fixture rejected');
    expect(activationExchangeBindings(command.command, proposal, decision)).toBe('Matched');
    expect(
      activationExchangeBindings(
        command.command,
        { ...proposal, hypothesisSaid: said('w') },
        decision,
      ),
    ).toBe('Mismatch');
    expect(
      activationExchangeBindings(
        command.command,
        { ...proposal, evaluationClosureSaid: said('q') },
        decision,
      ),
    ).toBe('Mismatch');
    expect(
      activationExchangeBindings(command.command, proposal, {
        ...decision,
        disposition: { ...disposition, candidateRevisionSaid: said('w') },
      }),
    ).toBe('Mismatch');
    expect(
      activationExchangeBindings(command.command, proposal, {
        ...decision,
        agentProposalExchangeSaid: said('q'),
      }),
    ).toBe('Mismatch');
  });
});
