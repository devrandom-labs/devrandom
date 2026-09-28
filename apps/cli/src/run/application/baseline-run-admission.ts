import { isDeepStrictEqual } from 'node:util';

import type { RunPurpose, TaskBudgets } from '@devrandom/domain';
import {
  PERSONAL_AGENT_ALIAS,
  type GovernorAid,
  type IssuerAid,
  type LocalRunAdmissionExchange,
  type PersonalAgentAid,
} from '@devrandom/identity';
import type {
  BaselineHarnessProjection,
  RunAdmissionCommand,
  RunAdmissionPendingProjection,
  RunLeaseAcquisitionBody,
  RunLeaseProjection,
  RunLeaseRenewalReceipt,
  RunProblem,
  RunProjection,
  TaskProjection,
} from '@devrandom/protocol';

export interface BaselineRunBinding {
  readonly ownerAid: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly harnessRevisionSaid: string;
  readonly personalAgentAid: PersonalAgentAid;
  readonly taskMandateSaid: string;
  readonly governorAid: GovernorAid;
  readonly promotionMandateSaid: string;
  readonly purpose: RunPurpose;
  readonly repository: TaskProjection['revision']['repository'];
}

interface StableRunIdentity {
  readonly version: 1;
  readonly binding: BaselineRunBinding;
  readonly commandId: string;
  readonly incarnationId: string;
  readonly preparedAt: number;
}

export type StableBaselineRunAdmission =
  | (StableRunIdentity & { readonly kind: 'PreparingExchange' })
  | (StableRunIdentity & {
      readonly kind: 'ExchangePrepared';
      readonly exchangeSaid: string;
    })
  | (StableRunIdentity & {
      readonly kind: 'RunAccepted';
      readonly exchangeSaid: string;
      readonly runAdmission: 'Created' | 'Reconciled';
      readonly run: RunProjection;
    })
  | (StableRunIdentity & {
      readonly kind: 'LeaseAccepted';
      readonly exchangeSaid: string;
      readonly runAdmission: 'Created' | 'Reconciled';
      readonly run: RunProjection;
      readonly lease: RunLeaseProjection;
    });

export type BaselineRunAdmissionRecordOutcome =
  | {
      readonly kind: 'Acquired';
      readonly provenance: 'Created' | 'Recovered';
      readonly admission: StableBaselineRunAdmission;
    }
  | { readonly kind: 'BindingConflict' }
  | { readonly kind: 'Unavailable' };

export type BaselineRunAdmissionTransition =
  | { readonly kind: 'Acknowledged'; readonly admission: StableBaselineRunAdmission }
  | { readonly kind: 'Conflict' }
  | { readonly kind: 'Unavailable' };

export interface BaselineRunAdmissionRecords {
  acquire(
    binding: BaselineRunBinding,
    candidate: Pick<StableRunIdentity, 'commandId' | 'incarnationId' | 'preparedAt'>,
  ): Promise<BaselineRunAdmissionRecordOutcome>;
  recordExchange(
    binding: BaselineRunBinding,
    prepared: { readonly exchangeSaid: string },
  ): Promise<BaselineRunAdmissionTransition>;
  recordRun(
    binding: BaselineRunBinding,
    disposition: 'Created' | 'Reconciled',
    projection: RunProjection,
  ): Promise<BaselineRunAdmissionTransition>;
  reincarnateUnleased(
    binding: BaselineRunBinding,
    expectedIncarnationId: string,
    nextIncarnationId: string,
  ): Promise<BaselineRunAdmissionTransition>;
  recordLease(
    binding: BaselineRunBinding,
    projection: RunLeaseProjection,
  ): Promise<BaselineRunAdmissionTransition>;
}

export type HostedRunFailure =
  | { readonly kind: 'InputInvalid' }
  | { readonly kind: 'ServerUnavailable' }
  | { readonly kind: 'ResponseInvalid' }
  | { readonly kind: 'RequestRejected'; readonly problem: RunProblem };

export type HostedRunAdmission =
  | { readonly kind: 'Created'; readonly projection: RunProjection }
  | { readonly kind: 'Reconciled'; readonly projection: RunProjection }
  | { readonly kind: 'Pending'; readonly projection: RunAdmissionPendingProjection }
  | HostedRunFailure;

export type HostedRunLease =
  | { readonly kind: 'Acquired'; readonly projection: RunLeaseProjection }
  | { readonly kind: 'Reconciled'; readonly projection: RunLeaseProjection }
  | HostedRunFailure;

export type HostedRunRenewal =
  { readonly kind: 'Renewed'; readonly receipt: RunLeaseRenewalReceipt } | HostedRunFailure;

export interface HostedRuns {
  admit(command: RunAdmissionCommand): Promise<HostedRunAdmission>;
  inspect(
    runId: string,
  ): Promise<{ readonly kind: 'Found'; readonly run: RunProjection } | HostedRunFailure>;
  acquireLease(
    runId: string,
    incarnationId: string,
    command: RunLeaseAcquisitionBody,
  ): Promise<HostedRunLease>;
  renewLease(
    runId: string,
    incarnationId: string,
    command: RunLeaseAcquisitionBody,
  ): Promise<HostedRunRenewal>;
}

export interface BaselineRunAdmissionInput {
  readonly task: TaskProjection;
  readonly harness: BaselineHarnessProjection;
  readonly personalAgentAid: PersonalAgentAid;
  readonly governorAid: GovernorAid;
  readonly promotionMandateSaid: string;
  readonly requestedBudget: TaskBudgets;
  readonly purpose: RunPurpose;
  readonly exchange: LocalRunAdmissionExchange;
  readonly hosted: HostedRuns;
}

export interface PersonalAgentRunAuthority {
  readonly personalAgentAid: PersonalAgentAid;
  readonly governorAid: GovernorAid;
  readonly exchange: LocalRunAdmissionExchange;
}

export type BaselineRunAdmissionOutcome =
  | {
      readonly kind: 'RunLeaseAcquired';
      readonly leaseRequestStartedAt: number;
      readonly admission: 'Created' | 'Reconciled';
      readonly run: RunProjection;
      readonly lease: RunLeaseProjection;
    }
  | { readonly kind: 'RunResumeRequired' }
  | { readonly kind: 'RunAdmissionBindingConflict' }
  | { readonly kind: 'RunAdmissionStateUnavailable' }
  | { readonly kind: 'RunExchangeUnavailable' }
  | { readonly kind: 'RunAdmissionPendingLimitReached' }
  | { readonly kind: 'RunAdmissionRejected'; readonly outcome: HostedRunFailure }
  | { readonly kind: 'RunLeaseRejected'; readonly outcome: HostedRunFailure };

export interface BaselineRunAdmissionDependencies {
  readonly records: BaselineRunAdmissionRecords;
  readonly issuerAid: IssuerAid;
  newCommandId(): string;
  newIncarnationId(): string;
  now(): number;
  monotonicNow(): number;
  wait(milliseconds: number): Promise<void>;
  readonly maximumObservations: number;
}

const pendingObservationIntervalMilliseconds = 1_000;

function binding(input: BaselineRunAdmissionInput): BaselineRunBinding {
  const revision = input.harness.revision;
  return {
    ownerAid: input.task.ownerAid,
    taskId: input.task.taskId,
    taskRevisionSaid: input.task.revisionSaid,
    harnessLineageId: input.task.harnessLineageId,
    harnessRevisionSaid: revision.d,
    personalAgentAid: input.personalAgentAid,
    taskMandateSaid: revision.authority.taskMandateSaid,
    governorAid: input.governorAid,
    promotionMandateSaid: input.promotionMandateSaid,
    purpose: input.purpose,
    repository: input.task.revision.repository,
  };
}

function payload(admission: StableRunIdentity, input: BaselineRunAdmissionInput) {
  const bound = admission.binding;
  return {
    version: 1 as const,
    kind: 'RunAdmission' as const,
    commandId: admission.commandId,
    taskId: bound.taskId,
    taskRevisionSaid: bound.taskRevisionSaid,
    harnessLineageId: bound.harnessLineageId,
    harnessRevisionSaid: bound.harnessRevisionSaid,
    taskMandateSaid: bound.taskMandateSaid,
    governorAid: bound.governorAid,
    promotionMandateSaid: bound.promotionMandateSaid,
    purpose: bound.purpose,
    repository: bound.repository,
    requestedBudget: input.requestedBudget,
  };
}

function runMatches(
  run: RunProjection,
  admission: Extract<StableBaselineRunAdmission, { readonly kind: 'ExchangePrepared' }>,
): boolean {
  const bound = admission.binding;
  return (
    run.ownerAid === bound.ownerAid &&
    run.commandId === admission.commandId &&
    run.admissionExchangeSaid === admission.exchangeSaid &&
    run.taskId === bound.taskId &&
    run.taskRevisionSaid === bound.taskRevisionSaid &&
    run.harnessLineageId === bound.harnessLineageId &&
    run.harnessRevisionSaid === bound.harnessRevisionSaid &&
    run.personalAgentAid === bound.personalAgentAid &&
    run.taskMandateSaid === bound.taskMandateSaid &&
    run.governorAid === bound.governorAid &&
    run.promotionMandateSaid === bound.promotionMandateSaid &&
    isDeepStrictEqual(run.purpose, bound.purpose) &&
    isDeepStrictEqual(run.repository, bound.repository) &&
    run.lifecycle.kind === 'Active' &&
    run.lifecycle.phase.kind === 'Preparing' &&
    run.submissionVerification.kind === 'NotSubmitted' &&
    run.lease.kind === 'Unassigned'
  );
}

function rejectedTransition(
  transition: Exclude<BaselineRunAdmissionTransition, { readonly kind: 'Acknowledged' }>,
): BaselineRunAdmissionOutcome {
  return transition.kind === 'Conflict'
    ? { kind: 'RunAdmissionBindingConflict' }
    : { kind: 'RunAdmissionStateUnavailable' };
}

export class BaselineRunAdmission {
  readonly #dependencies: BaselineRunAdmissionDependencies;
  readonly #leaseObservations = new Map<
    string,
    | { readonly kind: 'Originated' }
    | { readonly kind: 'Requested'; readonly runId: string; readonly requestStartedAt: number }
    | {
        readonly kind: 'Acknowledged';
        readonly runId: string;
        readonly lease: RunLeaseProjection;
        readonly requestStartedAt: number;
      }
  >();

  constructor(dependencies: BaselineRunAdmissionDependencies) {
    this.#dependencies = dependencies;
  }

  async admit(input: BaselineRunAdmissionInput): Promise<BaselineRunAdmissionOutcome> {
    const bound = binding(input);
    const acquired = await this.#dependencies.records.acquire(bound, {
      commandId: this.#dependencies.newCommandId(),
      incarnationId: this.#dependencies.newIncarnationId(),
      preparedAt: this.#dependencies.now(),
    });
    if (acquired.kind === 'BindingConflict') {
      return { kind: 'RunAdmissionBindingConflict' };
    }
    if (acquired.kind === 'Unavailable') {
      return { kind: 'RunAdmissionStateUnavailable' };
    }
    let admission = acquired.admission;
    if (acquired.provenance === 'Created') {
      this.#leaseObservations.set(admission.incarnationId, { kind: 'Originated' });
    }
    if (admission.kind === 'LeaseAccepted') {
      const observed = this.#leaseObservations.get(admission.incarnationId);
      if (observed?.kind !== 'Acknowledged' || observed.runId !== admission.run.runId) {
        return { kind: 'RunResumeRequired' };
      }
      if (
        observed.lease.runId !== admission.lease.runId ||
        observed.lease.incarnationId !== admission.lease.incarnationId ||
        observed.lease.runVersion !== admission.lease.runVersion ||
        observed.lease.expiresAt !== admission.lease.expiresAt ||
        observed.lease.serverTime !== admission.lease.serverTime
      ) {
        return { kind: 'RunAdmissionBindingConflict' };
      }
      return {
        leaseRequestStartedAt: observed.requestStartedAt,
        kind: 'RunLeaseAcquired',
        admission: admission.runAdmission,
        run: admission.run,
        lease: admission.lease,
      };
    }
    if (admission.kind === 'PreparingExchange') {
      let prepared;
      try {
        prepared = await input.exchange.prepare({
          senderAlias: PERSONAL_AGENT_ALIAS,
          sourceAid: bound.personalAgentAid,
          recipientAid: this.#dependencies.issuerAid,
          payload: payload(admission, input),
          preparedAt: admission.preparedAt,
        });
      } catch {
        return { kind: 'RunExchangeUnavailable' };
      }
      const transition = await this.#dependencies.records.recordExchange(bound, prepared);
      if (transition.kind !== 'Acknowledged') {
        return rejectedTransition(transition);
      }
      admission = transition.admission;
    }
    if (admission.kind === 'ExchangePrepared') {
      try {
        await input.exchange.deliver({
          senderAlias: PERSONAL_AGENT_ALIAS,
          sourceAid: bound.personalAgentAid,
          recipientAid: this.#dependencies.issuerAid,
          payload: payload(admission, input),
          preparedAt: admission.preparedAt,
          exchangeSaid: admission.exchangeSaid,
        });
      } catch {
        return { kind: 'RunExchangeUnavailable' };
      }
      let hosted: HostedRunAdmission | undefined;
      for (
        let observation = 0;
        observation < this.#dependencies.maximumObservations;
        observation += 1
      ) {
        hosted = await input.hosted.admit({
          version: 1,
          commandId: admission.commandId,
          admissionExchangeSaid: admission.exchangeSaid,
        });
        if (hosted.kind !== 'Pending') {
          break;
        }
        if (observation + 1 < this.#dependencies.maximumObservations) {
          await this.#dependencies.wait(pendingObservationIntervalMilliseconds);
        }
      }
      if (hosted === undefined || hosted.kind === 'Pending') {
        return { kind: 'RunAdmissionPendingLimitReached' };
      }
      if (hosted.kind !== 'Created' && hosted.kind !== 'Reconciled') {
        return { kind: 'RunAdmissionRejected', outcome: hosted };
      }
      if (!runMatches(hosted.projection, admission)) {
        return { kind: 'RunAdmissionRejected', outcome: { kind: 'ResponseInvalid' } };
      }
      const transition = await this.#dependencies.records.recordRun(
        bound,
        hosted.kind,
        hosted.projection,
      );
      if (transition.kind !== 'Acknowledged') {
        return rejectedTransition(transition);
      }
      admission = transition.admission;
    }
    if (admission.kind !== 'RunAccepted') {
      return { kind: 'RunAdmissionBindingConflict' };
    }
    let priorObservation = this.#leaseObservations.get(admission.incarnationId);
    if (priorObservation === undefined) {
      const inspected = await input.hosted.inspect(admission.run.runId);
      if (
        inspected.kind !== 'Found' ||
        !isDeepStrictEqual(inspected.run, admission.run) ||
        inspected.run.runVersion !== 0 ||
        inspected.run.lease.kind !== 'Unassigned'
      ) {
        return { kind: 'RunResumeRequired' };
      }
      const nextIncarnationId = this.#dependencies.newIncarnationId();
      if (nextIncarnationId === admission.incarnationId) {
        return { kind: 'RunResumeRequired' };
      }
      const rebound = await this.#dependencies.records.reincarnateUnleased(
        bound,
        admission.incarnationId,
        nextIncarnationId,
      );
      if (rebound.kind !== 'Acknowledged') {
        return rejectedTransition(rebound);
      }
      if (rebound.admission.kind !== 'RunAccepted') return { kind: 'RunAdmissionBindingConflict' };
      admission = rebound.admission;
      priorObservation = { kind: 'Originated' };
      this.#leaseObservations.set(admission.incarnationId, priorObservation);
    }
    if (priorObservation.kind !== 'Originated' && priorObservation.runId !== admission.run.runId) {
      return { kind: 'RunAdmissionBindingConflict' };
    }
    const leaseRequestStartedAt =
      priorObservation.kind === 'Requested' || priorObservation.kind === 'Acknowledged'
        ? priorObservation.requestStartedAt
        : this.#dependencies.monotonicNow();
    if (!Number.isFinite(leaseRequestStartedAt)) return { kind: 'RunAdmissionStateUnavailable' };
    if (priorObservation.kind === 'Originated') {
      this.#leaseObservations.set(admission.incarnationId, {
        kind: 'Requested',
        runId: admission.run.runId,
        requestStartedAt: leaseRequestStartedAt,
      });
    }
    const leaseCommand = {
      version: 1,
      expectedRunVersion: admission.run.runVersion,
    } as const;
    let observedBeforeRequest = priorObservation;
    let lease = await input.hosted.acquireLease(
      admission.run.runId,
      admission.incarnationId,
      leaseCommand,
    );
    for (let retry = 1; lease.kind === 'ServerUnavailable' && retry < 3; retry += 1) {
      try {
        await this.#dependencies.wait(pendingObservationIntervalMilliseconds);
      } catch {
        return { kind: 'RunLeaseRejected', outcome: { kind: 'ServerUnavailable' } };
      }
      const laterObservation = this.#leaseObservations.get(admission.incarnationId);
      if (laterObservation === undefined) return { kind: 'RunResumeRequired' };
      observedBeforeRequest = laterObservation;
      lease = await input.hosted.acquireLease(
        admission.run.runId,
        admission.incarnationId,
        leaseCommand,
      );
    }
    if (lease.kind !== 'Acquired' && lease.kind !== 'Reconciled') {
      return { kind: 'RunLeaseRejected', outcome: lease };
    }
    if (
      lease.projection.runId !== admission.run.runId ||
      lease.projection.incarnationId !== admission.incarnationId ||
      lease.projection.runVersion !== admission.run.runVersion + 1
    ) {
      return { kind: 'RunLeaseRejected', outcome: { kind: 'ResponseInvalid' } };
    }
    if (lease.kind === 'Reconciled' && observedBeforeRequest.kind === 'Originated') {
      return { kind: 'RunResumeRequired' };
    }
    this.#leaseObservations.set(admission.incarnationId, {
      kind: 'Acknowledged',
      runId: admission.run.runId,
      lease: lease.projection,
      requestStartedAt: leaseRequestStartedAt,
    });
    const transition = await this.#dependencies.records.recordLease(bound, lease.projection);
    if (transition.kind !== 'Acknowledged') {
      return rejectedTransition(transition);
    }
    if (transition.admission.kind !== 'LeaseAccepted') {
      return { kind: 'RunAdmissionBindingConflict' };
    }
    return {
      kind: 'RunLeaseAcquired',
      leaseRequestStartedAt,
      admission: transition.admission.runAdmission,
      run: transition.admission.run,
      lease: transition.admission.lease,
    };
  }
}
