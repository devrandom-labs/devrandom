import type { EvaluationExecutionBinding } from '@devrandom/domain';
import { decodeEvaluationManifest, type EvaluationManifest } from '@devrandom/protocol';
import {
  AcceptedConcentrateProviderUsage,
  type EvaluationProviderCustody,
} from '@devrandom/runtime';

import { HostedEvaluationEvidenceReading } from './hosted-evaluation-evidence-reading.js';
import type { ServerEvaluationHttp } from './server-evaluation-http.js';

type Current = Extract<
  Awaited<ReturnType<EvaluationProviderCustody['inspect']>>,
  { readonly kind: 'Current' }
>;
type Hosted = Pick<
  ServerEvaluationHttp,
  'readPosition' | 'inspectManifestLock' | 'readEvidencePage' | 'readPublicArtifact'
>;

/** Authenticated hosted position + M lock + exact accepted prefix and raw provider reports. */
export class HostedEvaluationProviderCustody implements EvaluationProviderCustody {
  readonly #http: Hosted;
  readonly #ownerAid: string;
  readonly #commandId: string;
  readonly #manifest: EvaluationManifest;
  readonly #reading: HostedEvaluationEvidenceReading;

  constructor(input: {
    readonly http: Hosted;
    readonly reading?: HostedEvaluationEvidenceReading;
    readonly ownerAid: string;
    readonly admittedCommandId: string;
    readonly manifest: EvaluationManifest;
  }) {
    this.#http = input.http;
    this.#ownerAid = input.ownerAid;
    this.#commandId = input.admittedCommandId;
    this.#manifest = input.manifest;
    this.#reading = input.reading ?? new HostedEvaluationEvidenceReading(input.http);
  }

  async inspect(
    binding: EvaluationExecutionBinding,
  ): ReturnType<EvaluationProviderCustody['inspect']> {
    const manifest = this.#manifest;
    if (
      decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
      manifest.evaluationId !== binding.evaluationId ||
      manifest.ownerAid !== this.#ownerAid ||
      manifest.originRunId !== binding.originRunId ||
      manifest.taskId !== binding.taskId ||
      manifest.taskRevisionSaid !== binding.taskRevisionSaid ||
      manifest.personalAgentAid !== binding.personalAgentAid ||
      manifest.taskMandateSaid !== binding.taskMandateSaid ||
      binding.phase.kind !== 'Trial' ||
      binding.phase.manifestSaid !== manifest.d
    )
      return { kind: 'Lost' };
    try {
      const position = await this.#http.readPosition(binding.evaluationId);
      if (position.kind !== 'Read') return { kind: 'Unavailable' };
      const exact = position.position;
      if (
        exact.ownerAid !== this.#ownerAid ||
        exact.commandId !== this.#commandId ||
        exact.evaluationId !== binding.evaluationId ||
        exact.streamId !== binding.evidenceStreamId ||
        exact.originRunId !== binding.originRunId ||
        exact.lease.leaseId !== binding.evaluationLeaseId
      )
        return { kind: 'Lost' };
      const locked = await this.#http.inspectManifestLock(
        binding.evaluationId,
        manifest.d,
        binding.evaluationLeaseId,
      );
      if (locked.kind !== 'Locked' && locked.kind !== 'AlreadyLocked')
        return { kind: 'Unavailable' };
      const lock = locked.receipt;
      if (
        lock.evaluationId !== binding.evaluationId ||
        lock.manifestSaid !== manifest.d ||
        lock.ownerAid !== this.#ownerAid ||
        lock.policySaid !== manifest.policySaid ||
        lock.leaseId !== binding.evaluationLeaseId ||
        lock.currentLeaseVersion !== exact.lease.version
      )
        return { kind: 'Lost' };
      let events: Awaited<ReturnType<HostedEvaluationEvidenceReading['openPrefix']>> | undefined;
      if (exact.acceptedThroughSequence >= 0 && exact.chainHeadSaid !== null) {
        const last = await this.#http.readEvidencePage({
          evaluationId: binding.evaluationId,
          afterSequence: exact.acceptedThroughSequence - 1,
          throughSequence: exact.acceptedThroughSequence,
          throughHeadSaid: exact.chainHeadSaid,
        });
        if (last.kind !== 'Read' || last.page.events.length !== 1) return { kind: 'Unavailable' };
        const head = last.page.events[0];
        if (head === undefined || head.d !== exact.chainHeadSaid) return { kind: 'Unavailable' };
        events = await this.#reading.openPrefix({
          binding: {
            ...binding,
            harnessRevisionSaid: head.harnessRevisionSaid,
            phase: head.phase,
          },
          throughSequence: exact.acceptedThroughSequence,
          headSaid: exact.chainHeadSaid,
        });
        if (events.kind !== 'Acknowledged') return { kind: 'Unavailable' };
      } else if (exact.acceptedThroughSequence !== -1 || exact.chainHeadSaid !== null)
        return { kind: 'Unavailable' };
      const prefix = events?.kind === 'Acknowledged' ? events : undefined;
      const accepted: Current['accepted'][number][] = [];
      if (prefix !== undefined) {
        for (const event of prefix.events) {
          if (event.detail.kind !== 'ProviderUsageVerified' || event.phase.kind !== 'Trial')
            continue;
          const verifier = new AcceptedConcentrateProviderUsage({
            binding: {
              ...binding,
              harnessRevisionSaid: event.harnessRevisionSaid,
              phase: event.phase,
            },
            accepted: { open: () => Promise.resolve(prefix) },
            openPublic: (input) => this.#reading.openPublic(input),
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
      }
      const repeated = await this.#http.readPosition(binding.evaluationId);
      if (
        repeated.kind !== 'Read' ||
        repeated.position.chainHeadSaid !== exact.chainHeadSaid ||
        repeated.position.acceptedThroughSequence !== exact.acceptedThroughSequence ||
        repeated.position.lease.version !== exact.lease.version
      )
        return { kind: 'Unavailable' };
      return {
        kind: 'Current',
        ownerAid: this.#ownerAid,
        admission: {
          commandId: exact.commandId,
          evaluationId: exact.evaluationId,
          evidenceStreamId: exact.streamId,
          originRunId: exact.originRunId,
          reservationSaid: exact.reservationSaid,
          leaseId: exact.lease.leaseId,
        },
        manifest,
        lock,
        lease: exact.lease,
        accepted,
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
