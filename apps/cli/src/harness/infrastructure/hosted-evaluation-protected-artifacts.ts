import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import {
  bindEvaluationVerifierBundle,
  decodeEvaluationManifest,
  decodeEvaluationVerifierBundleBytes,
  decodeProtectedEvaluationArtifact,
  prepareEvaluationEvidenceEvent,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';
import type { EvaluationCaseInventory, EvaluationProtectedArtifacts } from '@devrandom/runtime';

import type { ServerEvaluationHttp } from './server-evaluation-http.js';
import type { SqliteEvaluationEvidenceOutbox } from './sqlite-evaluation-evidence-outbox.js';

type Input = Parameters<EvaluationProtectedArtifacts['retain']>[0];
type Retention = Awaited<ReturnType<EvaluationProtectedArtifacts['retain']>>;
type Outbox = Pick<
  SqliteEvaluationEvidenceOutbox,
  'position' | 'following' | 'stage' | 'pending' | 'acknowledge'
>;
type Hosted = Pick<ServerEvaluationHttp, 'inspectManifestLock' | 'appendEvidence'>;

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const maximumPendingBatches = 1024;

function slotBound(input: Input): boolean {
  const { manifest, binding, lease } = input;
  const phase = binding.phase;
  if (phase.kind !== 'Trial') return false;
  const revision =
    phase.arm === 'H1TaskSearch' ? manifest.revisions.H1 : manifest.revisions[phase.arm];
  return (
    decodeEvaluationManifest(manifest).kind === 'Accepted' &&
    binding.evaluationId === manifest.evaluationId &&
    binding.taskId === manifest.taskId &&
    binding.taskRevisionSaid === manifest.taskRevisionSaid &&
    binding.originRunId === manifest.originRunId &&
    binding.personalAgentAid === manifest.personalAgentAid &&
    binding.taskMandateSaid === manifest.taskMandateSaid &&
    binding.harnessRevisionSaid === revision &&
    binding.evaluationLeaseId === lease.leaseId &&
    lease.evaluationId === manifest.evaluationId &&
    phase.manifestSaid === manifest.d &&
    manifest.slots.some(
      (slot) =>
        slot.arm === phase.arm &&
        slot.repetition === phase.repetition &&
        slot.attempt === phase.attempt,
    ) &&
    said.test(input.expectedHeadSaid)
  );
}

function capturedEvent(event: EvaluationEvidenceEvent, input: Input): boolean {
  const { binding } = input;
  return (
    event.evaluationId === binding.evaluationId &&
    event.streamId === binding.evidenceStreamId &&
    event.originRunId === binding.originRunId &&
    event.taskId === binding.taskId &&
    event.taskRevisionSaid === binding.taskRevisionSaid &&
    event.personalAgentAid === binding.personalAgentAid &&
    event.taskMandateSaid === binding.taskMandateSaid &&
    event.harnessRevisionSaid === binding.harnessRevisionSaid &&
    isDeepStrictEqual(event.phase, binding.phase) &&
    event.previous.kind === 'Previous' &&
    event.previous.eventSaid === input.expectedHeadSaid &&
    event.detail.kind === 'ArtifactCaptured' &&
    event.detail.custody === 'ProtectedCiphertext' &&
    event.detail.artifactSaid === input.artifacts[2].d
  );
}

/** CLI-owned hosted ciphertext custody and durable single-event evidence delivery. */
export class HostedEvaluationProtectedArtifacts implements EvaluationProtectedArtifacts {
  readonly #hosted: Hosted;
  readonly #inventory: EvaluationCaseInventory;
  readonly #outbox: Outbox;
  readonly #now: () => string;

  constructor(
    hosted: Hosted,
    inventory: EvaluationCaseInventory,
    outbox: Outbox,
    now = () => new Date().toISOString(),
  ) {
    this.#hosted = hosted;
    this.#inventory = inventory;
    this.#outbox = outbox;
    this.#now = now;
  }

  async retain(input: Input): Promise<Retention> {
    if (!slotBound(input)) return { kind: 'Conflict' };
    try {
      const lock = await this.#inspectLock(input);
      if (lock.kind !== 'Held') return lock;

      const inventory = await this.#inventory.open(input.manifest);
      if (inventory.kind !== 'Opened') return { kind: 'Unavailable' };
      const decoded = decodeEvaluationVerifierBundleBytes(inventory.bytes);
      if (
        decoded.kind !== 'Accepted' ||
        bindEvaluationVerifierBundle(decoded.bundle, input.manifest).kind !== 'Bound' ||
        !isDeepStrictEqual(input.artifacts[0], decoded.bundle.protectedCase.stimulus) ||
        !isDeepStrictEqual(input.artifacts[1], decoded.bundle.protectedCase.expected) ||
        decodeProtectedEvaluationArtifact(input.artifacts[2]).kind !== 'Accepted' ||
        input.artifacts[2].evaluationId !== input.manifest.evaluationId ||
        input.artifacts[2].objectSaid !== decoded.bundle.protectedCase.objectSaid ||
        input.artifacts[2].purpose !== 'OracleObservation' ||
        input.artifacts[2].segment !== 0 ||
        new Set(input.artifacts.map((artifact) => artifact.d)).size !== 3
      )
        return { kind: 'Conflict' };

      const prior = this.#outbox.following(input.expectedHeadSaid);
      if (prior.kind === 'Corrupt') return { kind: 'Unavailable' };
      if (prior.kind === 'Found') {
        if (!this.#exactCapture(prior.upload, input)) return { kind: 'Conflict' };
        if (prior.acknowledgement !== null)
          return await this.#retainedIfLockHeld(
            input,
            prior.upload.events[0],
            prior.acknowledgement,
          );
        const delivered = await this.#deliver(prior.upload.batch.d);
        if (delivered.kind !== 'Delivered') return delivered;
        const reconciled = this.#outbox.following(input.expectedHeadSaid);
        if (
          reconciled.kind !== 'Found' ||
          reconciled.acknowledgement === null ||
          !this.#exactCapture(reconciled.upload, input)
        )
          return { kind: 'Unavailable' };
        return await this.#retainedIfLockHeld(
          input,
          reconciled.upload.events[0],
          reconciled.acknowledgement,
        );
      }

      const position = this.#outbox.position();
      if (position.kind !== 'Position') return { kind: 'Unavailable' };
      if (position.chainHeadSaid !== input.expectedHeadSaid || position.nextSequence === 0)
        return { kind: 'Conflict' };
      const prepared = prepareEvaluationEvidenceEvent({
        evaluationId: input.binding.evaluationId,
        streamId: input.binding.evidenceStreamId,
        originRunId: input.binding.originRunId,
        taskId: input.binding.taskId,
        taskRevisionSaid: input.binding.taskRevisionSaid,
        personalAgentAid: input.binding.personalAgentAid,
        taskMandateSaid: input.binding.taskMandateSaid,
        harnessRevisionSaid: input.binding.harnessRevisionSaid,
        phase: input.binding.phase,
        sequence: position.nextSequence,
        previous: { kind: 'Previous', eventSaid: input.expectedHeadSaid },
        occurredAt: this.#now(),
        detail: {
          kind: 'ArtifactCaptured',
          artifactSaid: input.artifacts[2].d,
          custody: 'ProtectedCiphertext',
        },
      });
      if (prepared.kind !== 'Prepared') return { kind: 'Conflict' };
      const commandId = randomUUID();
      const fingerprint = `sha256:${createHash('sha256')
        .update(JSON.stringify({ commandId, event: prepared.event, artifact: input.artifacts[2] }))
        .digest('hex')}`;
      const staged = this.#outbox.stage({
        commandId,
        fingerprint,
        events: [prepared.event],
        publicArtifacts: [],
        protectedArtifacts: [input.artifacts[2]],
      });
      if (staged.kind !== 'Staged')
        return staged.kind === 'Corrupt' ? { kind: 'Unavailable' } : { kind: 'Conflict' };
      const delivered = await this.#deliver(staged.batchSaid);
      if (delivered.kind !== 'Delivered') return delivered;
      const reconciled = this.#outbox.following(input.expectedHeadSaid);
      if (
        reconciled.kind !== 'Found' ||
        reconciled.acknowledgement === null ||
        !this.#exactCapture(reconciled.upload, input)
      )
        return { kind: 'Unavailable' };
      return await this.#retainedIfLockHeld(
        input,
        reconciled.upload.events[0],
        reconciled.acknowledgement,
      );
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async #inspectLock(
    input: Input,
  ): Promise<
    | { readonly kind: 'Held' }
    | Extract<Retention, { kind: 'Conflict' | 'LeaseLost' | 'Unavailable' }>
  > {
    try {
      const lock = await this.#hosted.inspectManifestLock(
        input.manifest.evaluationId,
        input.manifest.d,
        input.lease.leaseId,
      );
      if (lock.kind === 'Unavailable' || lock.kind === 'ResponseInvalid')
        return { kind: 'Unavailable' };
      if (lock.kind !== 'Locked' && lock.kind !== 'AlreadyLocked')
        return lock.kind === 'Denied' ? { kind: 'LeaseLost' } : { kind: 'Conflict' };
      // Acknowledging ciphertext can overlap a heartbeat, but cannot change the
      // authenticated owner, manifest/allocation, policy, or immutable lease identity.
      const receipt = lock.receipt;
      return receipt.evaluationId === input.manifest.evaluationId &&
        receipt.manifestSaid === input.manifest.d &&
        receipt.ownerAid === input.manifest.ownerAid &&
        receipt.policySaid === input.manifest.policySaid &&
        receipt.leaseId === input.lease.leaseId &&
        receipt.currentLeaseVersion >= input.lease.version &&
        receipt.currentLeaseVersion >= receipt.lockedAtLeaseVersion &&
        receipt.currentEvaluationVersion >= receipt.lockedAtEvaluationVersion
        ? { kind: 'Held' }
        : { kind: 'LeaseLost' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  #exactCapture(
    upload: Extract<ReturnType<Outbox['pending']>, { kind: 'Pending' }>['upload'],
    input: Input,
  ): boolean {
    const event = upload.events[0];
    return (
      upload.events.length === 1 &&
      event !== undefined &&
      capturedEvent(event, input) &&
      upload.publicArtifacts.length === 0 &&
      upload.protectedArtifacts.length === 1 &&
      isDeepStrictEqual(upload.protectedArtifacts[0], input.artifacts[2])
    );
  }

  async #retainedIfLockHeld(
    input: Input,
    event: EvaluationEvidenceEvent | undefined,
    acknowledgement: Extract<ReturnType<Outbox['following']>, { kind: 'Found' }>['acknowledgement'],
  ): Promise<Retention> {
    if (
      event === undefined ||
      acknowledgement === null ||
      !capturedEvent(event, input) ||
      acknowledgement.chainHeadSaid !== event.d ||
      acknowledgement.acceptedThroughSequence !== event.sequence
    )
      return { kind: 'Unavailable' };
    const held = await this.#inspectLock(input);
    if (held.kind !== 'Held') return held;
    return {
      kind: 'Acknowledged',
      artifactSaids: input.artifacts.map((artifact) => artifact.d),
      event,
      throughSequence: acknowledgement.acceptedThroughSequence,
      headSaid: acknowledgement.chainHeadSaid,
    };
  }

  async #deliver(
    targetBatchSaid: string,
  ): Promise<
    { kind: 'Delivered' } | Extract<Retention, { kind: 'Conflict' | 'LeaseLost' | 'Unavailable' }>
  > {
    for (let attempt = 0; attempt < maximumPendingBatches; attempt++) {
      const pending = this.#outbox.pending();
      if (pending.kind !== 'Pending') return { kind: 'Unavailable' };
      const response = await this.#hosted.appendEvidence(pending.upload);
      if (response.kind !== 'Acknowledged') {
        if (response.kind === 'Denied') return { kind: 'LeaseLost' };
        if (response.kind === 'Unavailable' || response.kind === 'ResponseInvalid')
          return { kind: 'Unavailable' };
        return { kind: 'Conflict' };
      }
      const recorded = this.#outbox.acknowledge(response.acknowledgement);
      if (recorded.kind !== 'Recorded' && recorded.kind !== 'AlreadyRecorded')
        return { kind: 'Unavailable' };
      if (pending.upload.batch.d === targetBatchSaid) return { kind: 'Delivered' };
    }
    return { kind: 'Unavailable' };
  }
}
