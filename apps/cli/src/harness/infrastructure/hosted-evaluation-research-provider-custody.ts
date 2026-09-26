import { preservesEvaluationPosition } from './evaluation-position-continuity.js';
import { isDeepStrictEqual } from 'node:util';
import type { EvaluationExecutionBinding } from '@devrandom/domain';
import { decodeEvaluationPolicy, type EvaluationPolicy } from '@devrandom/protocol';
import {
  AcceptedConcentrateProviderUsage,
  type EvaluationResearchProviderCustody,
} from '@devrandom/runtime';
import type { ServerEvaluationHttp } from './server-evaluation-http.js';
import { HostedEvaluationEvidenceReading } from './hosted-evaluation-evidence-reading.js';

type Current = Extract<
  Awaited<ReturnType<EvaluationResearchProviderCustody['inspect']>>,
  { kind: 'ResearchCurrent' }
>;
type Admission = Parameters<ServerEvaluationHttp['admit']>[0];
type Hosted = Pick<
  ServerEvaluationHttp,
  'admit' | 'readPosition' | 'readEvidencePage' | 'readPublicArtifact'
>;

/** Reconciles exact admitted policy rights and raw usage without inventing a locked manifest. */
export class HostedEvaluationResearchProviderCustody implements EvaluationResearchProviderCustody {
  readonly #reading: HostedEvaluationEvidenceReading;
  readonly #input: {
    readonly ownerAid: string;
    readonly policy: EvaluationPolicy;
    readonly command: Admission;
    readonly http: Hosted;
  };
  constructor(input: {
    readonly ownerAid: string;
    readonly policy: EvaluationPolicy;
    readonly command: Admission;
    readonly http: Hosted;
  }) {
    this.#reading = new HostedEvaluationEvidenceReading(input.http);
    this.#input = {
      ...input,
      policy: structuredClone(input.policy),
      command: structuredClone(input.command),
    };
  }

  async inspect(
    binding: EvaluationExecutionBinding,
  ): ReturnType<EvaluationResearchProviderCustody['inspect']> {
    const { ownerAid, policy, command, http } = this.#input;
    if (
      decodeEvaluationPolicy(policy).kind !== 'Accepted' ||
      binding.phase.kind !== 'Research' ||
      binding.phase.policySaid !== policy.d ||
      command.policySaid !== policy.d ||
      command.taskId !== policy.taskId ||
      command.taskRevisionSaid !== policy.taskRevisionSaid ||
      command.originRunId !== policy.originRunId ||
      command.expectedActiveRevisionSaid !== policy.expectedActiveRevisionSaid ||
      command.executionProfileSaid !== policy.executionProfileSaid ||
      command.sourceInventorySaid !== policy.sourceInventorySaid ||
      !isDeepStrictEqual(command.allocation, policy.allocation) ||
      binding.taskId !== command.taskId ||
      binding.taskRevisionSaid !== command.taskRevisionSaid ||
      binding.originRunId !== command.originRunId ||
      binding.personalAgentAid !== command.personalAgentAid ||
      binding.taskMandateSaid !== command.taskMandateSaid ||
      binding.harnessRevisionSaid !== command.expectedActiveRevisionSaid
    )
      return { kind: 'Lost' };
    try {
      // Equivalent admission rechecks current mandate and the immutable original command.
      const admitted = await http.admit(command);
      if (admitted.kind !== 'Admitted')
        return { kind: admitted.kind === 'Unavailable' ? 'Unavailable' : 'Lost' };
      const position = await http.readPosition(binding.evaluationId);
      if (position.kind !== 'Read') return { kind: 'Unavailable' };
      let exact = position.position;
      if (
        admitted.evaluationId !== binding.evaluationId ||
        admitted.evidenceStreamId !== binding.evidenceStreamId ||
        admitted.lease.leaseId !== binding.evaluationLeaseId ||
        exact.ownerAid !== ownerAid ||
        exact.commandId !== command.commandId ||
        exact.evaluationId !== binding.evaluationId ||
        exact.originRunId !== binding.originRunId ||
        exact.streamId !== binding.evidenceStreamId ||
        exact.reservationSaid !== admitted.reservationSaid ||
        exact.lease.leaseId !== binding.evaluationLeaseId
      )
        return { kind: 'Lost' };
      const reading = this.#reading;
      const accepted: Current['accepted'][number][] = [];
      if (exact.acceptedThroughSequence >= 0 && exact.chainHeadSaid !== null) {
        const last = await http.readEvidencePage({
          evaluationId: binding.evaluationId,
          afterSequence: exact.acceptedThroughSequence - 1,
          throughSequence: exact.acceptedThroughSequence,
          throughHeadSaid: exact.chainHeadSaid,
        });
        if (last.kind !== 'Read' || last.page.events.length !== 1) return { kind: 'Unavailable' };
        const head = last.page.events[0];
        if (head === undefined || head.d !== exact.chainHeadSaid || head.phase.kind !== 'Research')
          return { kind: 'Lost' };
        const prefix = await reading.openPrefix({
          binding: { ...binding, phase: head.phase },
          throughSequence: exact.acceptedThroughSequence,
          headSaid: exact.chainHeadSaid,
        });
        if (prefix.kind !== 'Acknowledged') return { kind: 'Unavailable' };
        for (const event of prefix.events) {
          if (
            event.phase.kind !== 'Research' ||
            event.phase.policySaid !== policy.d ||
            event.harnessRevisionSaid !== policy.expectedActiveRevisionSaid
          )
            return { kind: 'Lost' };
          if (event.detail.kind !== 'ProviderUsageVerified') continue;
          const verifier = new AcceptedConcentrateProviderUsage({
            binding: { ...binding, phase: event.phase },
            accepted: { open: () => Promise.resolve(prefix) },
            openPublic: (input) => reading.openPublic(input),
          });
          const verified = await verifier.verifyProviderUsage({ usageEventSaid: event.d });
          if (verified.kind !== 'Verified') return { kind: 'Unavailable' };
          accepted.push({
            eventSaid: event.d,
            phase: event.phase,
            requestOrdinal: event.detail.requestOrdinal,
            responseId: verified.responseId,
            providerReportArtifactSaid: event.detail.providerReportArtifactSaid,
            inputTokens: verified.inputTokens,
            outputTokens: verified.outputTokens,
            spendMicroUsd: verified.spendMicroUsd,
          });
        }
      } else if (exact.acceptedThroughSequence !== -1 || exact.chainHeadSaid !== null)
        return { kind: 'Unavailable' };
      const repeated = await http.readPosition(binding.evaluationId);
      if (repeated.kind !== 'Read') return { kind: 'Unavailable' };
      if (!preservesEvaluationPosition(exact, repeated.position)) return { kind: 'Lost' };
      exact = repeated.position;
      return {
        kind: 'ResearchCurrent',
        ownerAid,
        policy,
        admission: {
          commandId: exact.commandId,
          evaluationId: exact.evaluationId,
          evidenceStreamId: exact.streamId,
          originRunId: exact.originRunId,
          reservationSaid: exact.reservationSaid,
          leaseId: exact.lease.leaseId,
        },
        lease: exact.lease,
        accepted,
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
