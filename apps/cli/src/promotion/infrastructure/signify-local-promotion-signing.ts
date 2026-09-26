import { isDeepStrictEqual } from 'node:util';

import { closeComparison, selectPromotion } from '@devrandom/domain';
import {
  GOVERNOR_ALIAS,
  PERSONAL_AGENT_ALIAS,
  type GovernorAid,
  type IssuerAid,
  type LocalPromotionExchanges,
  type PersonalAgentAid,
  type StablePromotionExchange,
} from '@devrandom/identity';
import {
  decodeEvaluationClosure,
  decodeEvaluationManifest,
  preparePromotionSelectionRecord,
  type GovernorPromotionDecisionPayload,
} from '@devrandom/protocol';
import type {
  AgentPromotionSigning,
  ExactPromotionAuthority,
  GovernorPromotionSigning,
  VerifiedPromotionEvidence,
} from '@devrandom/runtime';

export interface LocalGovernorPromotionConfirmation {
  confirm(input: {
    readonly decision: GovernorPromotionDecisionPayload;
    readonly evidence: VerifiedPromotionEvidence;
  }): Promise<'Confirmed' | 'Pending'>;
}

export interface SignifyLocalPromotionSigningInput {
  readonly exchanges: LocalPromotionExchanges;
  readonly agentAid: PersonalAgentAid;
  readonly governorAid: GovernorAid;
  readonly issuerAid: IssuerAid;
  readonly authority: ExactPromotionAuthority;
  readonly confirm: LocalGovernorPromotionConfirmation['confirm'];
  now(): number;
}

function matchesDecision(
  decision: GovernorPromotionDecisionPayload,
  evidence: VerifiedPromotionEvidence,
): boolean {
  const manifest = decodeEvaluationManifest(evidence.manifest);
  const closure = decodeEvaluationClosure(evidence.closure);
  if (
    manifest.kind !== 'Accepted' ||
    closure.kind !== 'Accepted' ||
    evidence.closure.manifestSaid !== evidence.manifest.d ||
    evidence.closure.evaluationId !== evidence.manifest.evaluationId ||
    evidence.manifest.taskId !== decision.taskId ||
    evidence.manifest.hypothesisSaid !== evidence.hypothesisSaid ||
    evidence.manifest.taskRevisionSaid !== decision.taskRevisionSaid ||
    evidence.manifest.revisions.H1 !== decision.expectedIncumbentRevisionSaid ||
    evidence.manifest.d !== decision.evaluationManifestSaid ||
    evidence.closure.d !== decision.evaluationClosureSaid ||
    evidence.comparison.evidence !== 'Acknowledged'
  )
    return false;
  const selection = selectPromotion(evidence.comparison);
  if (selection.kind === 'SelectionBlocked') return false;
  const expectedSelection =
    selection.kind === 'RetainIncumbent'
      ? { kind: 'RetainIncumbent' as const }
      : (() => {
          const comparison = closeComparison(
            evidence.comparison.conditions,
            evidence.comparison.observations,
          );
          if (comparison.kind !== 'EvidenceOnly') return undefined;
          const artifactSaids = ([1, 2, 3] as const).map(
            (repetition) =>
              comparison.measurements.find(
                (measurement) =>
                  measurement.slot.arm === selection.arm &&
                  measurement.slot.repetition === repetition,
              )?.artifactSaid,
          );
          if (artifactSaids.some((said) => said === undefined)) return undefined;
          return {
            kind: 'Activate' as const,
            candidateRevisionSaid: selection.revisionSaid,
            artifactSaids,
          };
        })();
  if (expectedSelection === undefined) return false;
  const record = preparePromotionSelectionRecord({
    taskId: decision.taskId,
    taskRevisionSaid: decision.taskRevisionSaid,
    harnessLineageId: decision.harnessLineageId,
    expectedIncumbentRevisionSaid: decision.expectedIncumbentRevisionSaid,
    expectedPointerVersion: decision.expectedPointerVersion,
    evaluationManifestSaid: decision.evaluationManifestSaid,
    evaluationClosureSaid: decision.evaluationClosureSaid,
    hypothesisSaid: evidence.hypothesisSaid,
    selection: expectedSelection,
  });
  return (
    record.kind === 'Prepared' &&
    isDeepStrictEqual(record.record, evidence.selectionRecord) &&
    isDeepStrictEqual(decision.disposition, {
      ...expectedSelection,
      selectionEvidenceSaid: record.record.d,
    })
  );
}

/** Distinct managed AIDs sign only after the Governor rechecks M, selection and user consent. */
export function signifyLocalPromotionSigning(input: SignifyLocalPromotionSigningInput): {
  readonly agent: AgentPromotionSigning;
  readonly governor: GovernorPromotionSigning;
} {
  const deliveredProposals = new Set<string>();
  return {
    agent: {
      async sign(payload) {
        if (
          String(input.agentAid) === String(input.governorAid) ||
          String(input.agentAid) === String(input.issuerAid) ||
          String(input.governorAid) === String(input.issuerAid)
        )
          return { kind: 'Unavailable' };
        try {
          const stable = {
            kind: 'Proposal' as const,
            senderAlias: PERSONAL_AGENT_ALIAS,
            sourceAid: input.agentAid,
            recipientAid: input.issuerAid,
            preparedAt: input.now(),
            payload,
          } satisfies StablePromotionExchange;
          const prepared = await input.exchanges.prepare(stable);
          const delivered = await input.exchanges.deliver({ ...stable, ...prepared });
          if (delivered.exchangeSaid !== prepared.exchangeSaid) return { kind: 'Unavailable' };
          deliveredProposals.add(delivered.exchangeSaid);
          return {
            kind: 'Verified',
            exchangeSaid: delivered.exchangeSaid,
            sourceAid: input.agentAid,
            payload,
          };
        } catch {
          return { kind: 'Unavailable' };
        }
      },
    },
    governor: {
      async sign({ decision, mandate, evidence }) {
        if (
          String(input.agentAid) === String(input.governorAid) ||
          String(input.agentAid) === String(input.issuerAid) ||
          String(input.governorAid) === String(input.issuerAid) ||
          !deliveredProposals.has(decision.agentProposalExchangeSaid) ||
          mandate.credential.issuerAid !== input.issuerAid ||
          mandate.credential.issueeAid !== input.governorAid ||
          mandate.credential.credentialSaid !== decision.exactPromotionMandateSaid ||
          mandate.evaluationManifestSaid !== decision.evaluationManifestSaid ||
          mandate.taskId !== decision.taskId ||
          mandate.taskRevisionSaid !== decision.taskRevisionSaid ||
          mandate.harnessLineageId !== decision.harnessLineageId ||
          !matchesDecision(decision, evidence)
        )
          return { kind: 'Rejected' };
        try {
          const current = await input.authority.verify({
            taskId: decision.taskId,
            taskRevisionSaid: decision.taskRevisionSaid,
            harnessLineageId: decision.harnessLineageId,
            ownerAid: input.issuerAid,
            governorAid: input.governorAid,
            evaluationManifestSaid: decision.evaluationManifestSaid,
            evaluationClosureSaid: decision.evaluationClosureSaid,
          });
          if (
            current.kind !== 'Current' ||
            current.mandate.credential.credentialSaid !== mandate.credential.credentialSaid
          )
            return { kind: 'Rejected' };
          if ((await input.confirm({ decision, evidence })) !== 'Confirmed')
            return { kind: 'Rejected' };
          const stable = {
            kind: 'GovernorDecision' as const,
            senderAlias: GOVERNOR_ALIAS,
            sourceAid: input.governorAid,
            recipientAid: input.issuerAid,
            preparedAt: input.now(),
            payload: decision,
          } satisfies StablePromotionExchange;
          const prepared = await input.exchanges.prepare(stable);
          const delivered = await input.exchanges.deliver({ ...stable, ...prepared });
          return delivered.exchangeSaid === prepared.exchangeSaid &&
            delivered.exchangeSaid !== decision.agentProposalExchangeSaid
            ? {
                kind: 'Verified',
                exchangeSaid: delivered.exchangeSaid,
                sourceAid: input.governorAid,
                payload: decision,
              }
            : { kind: 'Unavailable' };
        } catch {
          return { kind: 'Unavailable' };
        }
      },
    },
  };
}
