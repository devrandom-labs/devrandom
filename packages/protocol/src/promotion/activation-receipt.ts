import Type from 'typebox';

import {
  decodeActivationCommitCommand,
  type ActivationCommitCommand,
} from './activation-command.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

export const activationReceiptExchangeRoute = '/devrandom/promotion/receipt/1' as const;

/** Signed by the issuer only for a durably reserved exact command and CAS outcome. */
export const activationReceiptPayloadSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('ActivationCommitReceipt'),
    commandId: uuid,
    commandFingerprint: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    taskId: uuid,
    taskRevisionSaid: said,
    harnessLineageId: uuid,
    expectedIncumbentRevisionSaid: said,
    expectedPointerVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 }),
    pointerVersion: Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }),
    activeRevisionSaid: said,
    disposition: Type.Union([Type.Literal('Activated'), Type.Literal('Retained')]),
    evaluationManifestSaid: said,
    evaluationClosureSaid: said,
    selectionEvidenceSaid: said,
    exactPromotionMandateSaid: said,
    agentProposalExchangeSaid: said,
    governorDecisionExchangeSaid: said,
  },
  { additionalProperties: false },
);

export type ActivationReceiptPayload = Type.Static<typeof activationReceiptPayloadSchema>;

/** Pure expected payload; KERIA custody and pointer read-back are separate gates. */
export function activationReceiptPayload(
  command: ActivationCommitCommand,
): ActivationReceiptPayload {
  if (
    decodeActivationCommitCommand(command).kind !== 'Accepted' ||
    command.expectedPointerVersion >= Number.MAX_SAFE_INTEGER
  )
    throw new Error('activation receipt command is invalid');
  return {
    version: 1,
    kind: 'ActivationCommitReceipt',
    commandId: command.commandId,
    commandFingerprint: command.fingerprint,
    taskId: command.taskId,
    taskRevisionSaid: command.taskRevisionSaid,
    harnessLineageId: command.harnessLineageId,
    expectedIncumbentRevisionSaid: command.expectedIncumbentRevisionSaid,
    expectedPointerVersion: command.expectedPointerVersion,
    pointerVersion: command.expectedPointerVersion + 1,
    activeRevisionSaid:
      command.disposition.kind === 'Activate'
        ? command.disposition.candidateRevisionSaid
        : command.expectedIncumbentRevisionSaid,
    disposition: command.disposition.kind === 'Activate' ? 'Activated' : 'Retained',
    evaluationManifestSaid: command.evaluationManifestSaid,
    evaluationClosureSaid: command.evaluationClosureSaid,
    selectionEvidenceSaid: command.selectionRecord.d,
    exactPromotionMandateSaid: command.exactPromotionMandateSaid,
    agentProposalExchangeSaid: command.agentProposalExchangeSaid,
    governorDecisionExchangeSaid: command.governorDecisionExchangeSaid,
  };
}
