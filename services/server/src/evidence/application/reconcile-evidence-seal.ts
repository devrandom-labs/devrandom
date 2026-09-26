import type { EvidenceStream } from '@devrandom/domain';
import type { EvidenceSealPayload } from '@devrandom/protocol';

import type {
  EvidenceSealCommitment,
  EvidenceSealContexts,
  EvidenceSealExchanges,
  EvidenceSeals,
} from './evidence-seals.js';

export interface ReconcileEvidenceSealInput {
  readonly ownerAid: string;
  readonly runId: string;
  readonly sealExchangeSaid: string;
  readonly observedAt: string;
}

export interface ReconcileEvidenceSealDependencies {
  readonly issuerAid: string;
  readonly contexts: EvidenceSealContexts;
  readonly exchanges: EvidenceSealExchanges;
  readonly seals: EvidenceSeals;
}

export type ReconcileEvidenceSealOutcome =
  | EvidenceSealCommitment
  | {
      readonly kind: 'EvidenceSealPending';
      readonly sealExchangeSaid: string;
      readonly stream: EvidenceStream;
    }
  | {
      readonly kind: 'EvidenceSealRejected';
      readonly reason:
        | 'SealExchangeMalformed'
        | 'SealExchangeSaidMismatch'
        | 'SealRouteMismatch'
        | 'SealRecipientMismatch'
        | 'SealSignerMismatch'
        | 'SealPayloadMismatch';
    }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'Keria' };

function rejectedReason(
  reason: Extract<
    Awaited<ReturnType<EvidenceSealExchanges['inspect']>>,
    { readonly kind: 'Rejected' }
  >['reason'],
): Extract<ReconcileEvidenceSealOutcome, { readonly kind: 'EvidenceSealRejected' }>['reason'] {
  switch (reason) {
    case 'SealExchangeMalformed':
    case 'SealExchangeSaidMismatch':
      return reason;
    case 'SealExchangeRouteMismatch':
      return 'SealRouteMismatch';
    case 'SealExchangeSourceMismatch':
      return 'SealSignerMismatch';
    case 'SealExchangeRecipientMismatch':
      return 'SealRecipientMismatch';
    case 'SealExchangePayloadMismatch':
      return 'SealPayloadMismatch';
  }
}

export async function reconcileEvidenceSeal(
  input: ReconcileEvidenceSealInput,
  dependencies: ReconcileEvidenceSealDependencies,
): Promise<ReconcileEvidenceSealOutcome> {
  const context = await dependencies.contexts.inspect({
    ownerAid: input.ownerAid,
    runId: input.runId,
  });
  if (context.kind !== 'EvidenceSealContextFound') {
    return context;
  }
  const cursor = context.stream.cursor;
  if (cursor.kind === 'Genesis' || context.stream.provisional.kind === 'None') {
    return { kind: 'EvidenceSealCursorIncomplete', acceptedEventCount: 0 };
  }
  const payload: EvidenceSealPayload = {
    version: 1,
    kind: 'EvidenceStreamSeal',
    runId: context.run.binding.runId,
    evidenceStreamId: context.run.binding.evidenceStreamId,
    eventCount: cursor.acceptedThrough + 1,
    finalSequence: cursor.acceptedThrough,
    chainHeadSaid: cursor.chainHeadSaid,
    harnessRevisionSaid: context.run.binding.initialHarnessRevisionSaid,
    taskMandateSaid: context.run.binding.taskMandateSaid,
  };
  const inspected = await dependencies.exchanges.inspect({
    exchangeSaid: input.sealExchangeSaid,
    sourceAid: context.run.binding.personalAgentAid,
    recipientAid: dependencies.issuerAid,
    payload,
  });
  switch (inspected.kind) {
    case 'Pending':
      return {
        kind: 'EvidenceSealPending',
        sealExchangeSaid: input.sealExchangeSaid,
        stream: context.stream,
      };
    case 'Rejected':
      return { kind: 'EvidenceSealRejected', reason: rejectedReason(inspected.reason) };
    case 'Unavailable':
      return { kind: 'DependencyUnavailable', dependency: inspected.dependency };
    case 'Verified':
      return dependencies.seals.commit({
        ownerAid: input.ownerAid,
        runId: input.runId,
        expectedRunVersion: context.run.version,
        expectedStreamVersion: context.stream.version,
        exchangeSaid: inspected.exchangeSaid,
        sealedAt:
          context.stream.seal.kind === 'Sealed' &&
          context.stream.seal.exchangeSaid === inspected.exchangeSaid
            ? context.stream.seal.sealedAt
            : input.observedAt,
      });
  }
}
