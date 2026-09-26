import { startRunExecution, type Run } from '@devrandom/domain';
import type {
  EvidenceRecorder,
  EvidenceRecorders,
  EvidenceRecording,
  PiExecution,
  PiExecutionDisposition,
  PreparedRunExecution,
  RunEvidenceDelivery,
  RunExecutionPreparation,
  RunExecutionPreparationOutcome,
  RunResourceBudget,
  RunSupervisionSettlement,
  RunWallClock,
} from '@devrandom/runtime';

import type { PreparedCompatibilityEvidence } from './prepared-compatibility-calibration-settlement.js';
import type { PreparedRunWorktree, RunWorktreePreparation, RunWorktrees } from './run-worktree.js';

export type BaselineRunExecutionProvisioning =
  | {
      readonly kind: 'Provisioned';
      readonly pi: PiExecution;
      readonly evidenceDelivery: RunEvidenceDelivery;
      readonly settlement: RunSupervisionSettlement;
      readonly budget: RunResourceBudget;
      readonly wallClock: RunWallClock;
    }
  | { readonly kind: 'DependencyUnavailable' }
  | { readonly kind: 'ModelCredentialUnavailable' }
  | { readonly kind: 'SecretDetected' };

export interface BaselineRunExecutionProvision {
  provision(
    input: {
      readonly run: Run;
      readonly worktree: PreparedRunWorktree;
      readonly evidence: PreparedCompatibilityEvidence;
    },
    signal: AbortSignal,
  ): Promise<BaselineRunExecutionProvisioning>;
}

export interface BaselineRunExecutionPreparationDependencies {
  readonly stateRoot: string;
  readonly repositoryDirectory: string;
  readonly worktrees: RunWorktrees;
  readonly recorders: EvidenceRecorders<PreparedCompatibilityEvidence>;
  readonly provision: BaselineRunExecutionProvision;
  now(): string;
}

function evidenceDisposition(recording: EvidenceRecording): PiExecutionDisposition | undefined {
  switch (recording.kind) {
    case 'SecretDetected':
      return { kind: 'SecretDetected' };
    case 'Recorded':
      return undefined;
    case 'OutboxBackpressure':
    case 'OutboxBoundReached':
      return { kind: 'OutboxBackpressure' };
    case 'Unavailable':
      return { kind: 'EvidenceUnavailable' };
    case 'ObservationRejected':
    case 'LocalStateCorruption':
      return { kind: 'EvidenceIntegrityFailure' };
  }
}

function samePreparedRun(expected: Run, received: Run): boolean {
  return (
    received.version === expected.version &&
    received.binding.runId === expected.binding.runId &&
    received.binding.taskRevisionSaid === expected.binding.taskRevisionSaid &&
    received.binding.initialHarnessRevisionSaid === expected.binding.initialHarnessRevisionSaid &&
    received.lease.kind === 'Held' &&
    expected.lease.kind === 'Held' &&
    received.lease.incarnationId === expected.lease.incarnationId &&
    received.lifecycle.kind === 'Active' &&
    received.lifecycle.phase.kind === 'Running'
  );
}

class StartedRunEvidencePi implements PiExecution {
  readonly #run: Run;
  readonly #fromRunVersion: number;
  readonly #delegate: PiExecution;
  readonly #evidence: EvidenceRecorder;
  readonly #now: () => string;

  constructor(
    run: Run,
    fromRunVersion: number,
    delegate: PiExecution,
    evidence: EvidenceRecorder,
    now: () => string,
  ) {
    this.#run = run;
    this.#fromRunVersion = fromRunVersion;
    this.#delegate = delegate;
    this.#evidence = evidence;
    this.#now = now;
  }

  async invoke(run: Run, signal: AbortSignal): Promise<PiExecutionDisposition> {
    if (!samePreparedRun(this.#run, run)) {
      return { kind: 'DependencyUnavailable' };
    }
    const started = evidenceDisposition(
      this.#evidence.record({
        occurredAt: this.#now(),
        producer: { kind: 'RunSupervisor' },
        event: { kind: 'RunStarted', fromRunVersion: this.#fromRunVersion },
      }),
    );
    if (started !== undefined) {
      return started;
    }
    const incarnation = evidenceDisposition(
      this.#evidence.record({
        occurredAt: this.#now(),
        producer: { kind: 'RunSupervisor' },
        event: { kind: 'IncarnationStarted' },
      }),
    );
    return incarnation ?? this.#delegate.invoke(run, signal);
  }
}

function readyExecution(
  run: Run,
  fromRunVersion: number,
  evidence: EvidenceRecorder,
  provisioned: Extract<BaselineRunExecutionProvisioning, { readonly kind: 'Provisioned' }>,
  now: () => string,
): PreparedRunExecution {
  return {
    run,
    releasePreparation: () => {
      evidence.close();
    },
    pi: new StartedRunEvidencePi(run, fromRunVersion, provisioned.pi, evidence, now),
    evidenceDelivery: provisioned.evidenceDelivery,
    settlement: provisioned.settlement,
    budget: provisioned.budget,
    wallClock: provisioned.wallClock,
  };
}

export class BaselineRunExecutionPreparation implements RunExecutionPreparation {
  readonly #dependencies: BaselineRunExecutionPreparationDependencies;

  constructor(dependencies: BaselineRunExecutionPreparationDependencies) {
    this.#dependencies = dependencies;
  }

  async prepare(run: Run, signal: AbortSignal): Promise<RunExecutionPreparationOutcome> {
    let worktree: RunWorktreePreparation;
    try {
      signal.throwIfAborted();
      worktree = await this.#dependencies.worktrees.prepare(
        {
          stateRoot: this.#dependencies.stateRoot,
          repositoryDirectory: this.#dependencies.repositoryDirectory,
          runId: run.binding.runId,
          repository: run.binding.repository,
        },
        signal,
      );
      signal.throwIfAborted();
    } catch {
      return signal.aborted
        ? { kind: 'Interrupted' }
        : { kind: 'Rejected', failure: { kind: 'DependencyUnavailable' } };
    }
    switch (worktree.kind) {
      case 'Interrupted':
        return { kind: 'Interrupted' };
      case 'RepositoryBindingRejected':
      case 'ManagedWorktreeConflict':
      case 'GitUnavailable':
        return { kind: 'Rejected', failure: { kind: worktree.kind } };
      case 'Prepared':
      case 'Reconciled':
        break;
    }
    const incarnationId = run.lease.kind === 'Held' ? run.lease.incarnationId : '';
    const expectedEvidence = {
      kind: 'Genesis' as const,
      streamId: run.binding.evidenceStreamId,
    };
    const started = startRunExecution(run, {
      incarnationId,
      leaseObservedAt: this.#dependencies.now(),
      worktree: { repository: worktree.worktree.repository },
      evidence: expectedEvidence,
    });
    if (started.kind !== 'Started') {
      return {
        kind: 'Rejected',
        failure: { kind: 'DomainTransitionRejected', outcome: started },
      };
    }
    const opened = this.#dependencies.recorders.open({
      run: started.run,
      stateRoot: this.#dependencies.stateRoot,
    });
    switch (opened.kind) {
      case 'ExistingOutboxRequiresLaterResume':
        return { kind: 'Rejected', failure: { kind: 'LaterRuntimeRecoveryRequired' } };
      case 'LocalStateCorruption':
        return { kind: 'Rejected', failure: { kind: 'LocalStateCorruption' } };
      case 'Unavailable':
        return { kind: 'Rejected', failure: { kind: 'EvidenceUnavailable' } };
      case 'Opened':
        break;
    }
    const readiness = opened.recorder.readiness();
    if (
      readiness.kind !== 'Ready' ||
      readiness.readiness.kind !== 'Genesis' ||
      readiness.readiness.streamId !== expectedEvidence.streamId
    ) {
      opened.recorder.close();
      return {
        kind: 'Rejected',
        failure: {
          kind: readiness.kind === 'Unavailable' ? 'EvidenceUnavailable' : 'LocalStateCorruption',
        },
      };
    }
    let provisioned: BaselineRunExecutionProvisioning;
    try {
      provisioned = await this.#dependencies.provision.provision(
        {
          run: started.run,
          worktree: worktree.worktree,
          evidence: opened.recorder,
        },
        signal,
      );
      signal.throwIfAborted();
    } catch {
      opened.recorder.close();
      return signal.aborted
        ? { kind: 'Interrupted' }
        : { kind: 'Rejected', failure: { kind: 'DependencyUnavailable' } };
    }
    if (provisioned.kind !== 'Provisioned') {
      opened.recorder.close();
      return { kind: 'Rejected', failure: provisioned };
    }
    return {
      kind: 'Ready',
      execution: readyExecution(started.run, run.version, opened.recorder, provisioned, () =>
        this.#dependencies.now(),
      ),
    };
  }
}
