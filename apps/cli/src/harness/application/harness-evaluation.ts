import {
  evaluationAdmissionCommandSchema,
  taskLabelSchema,
  type EvaluationExecutionProfile,
  type EvaluationPolicy,
  type EvaluationSourceInventory,
  type TaskProjection,
  type EvidenceArtifact,
  type PublicVerifierReceipt,
} from '@devrandom/protocol';
import type Type from 'typebox';
import Value from 'typebox/value';

import type { HostedTaskInspection } from '../../task/application/user-tasks.js';
import type {
  HostedRunInspection,
  HostedRunTimelineInspection,
} from '../../run/application/task-run-observation.js';
import type { EvidenceTimelineQuery } from '@devrandom/protocol';

/** Public disposition of one exact, retained-failure evaluation command. */
export type HarnessEvaluationOutcome =
  | {
      readonly kind: 'Blocked';
      readonly gate:
        'Qualification' | 'Profile' | 'Source' | 'Authority' | 'Budget' | 'Evidence' | 'Manifest';
    }
  | { readonly kind: 'Blocked'; readonly gate: 'ProtectedCases'; readonly evaluationId: string }
  | {
      readonly kind: 'InvalidInput';
      readonly reason: 'Label' | 'RunId' | 'Policy' | 'PolicyBinding' | 'CommandConflict';
    }
  | {
      readonly kind: 'Unavailable';
      readonly reason: 'Custody' | 'HostedWork' | 'EvaluationService';
    }
  | { readonly kind: 'Interrupted' };

type AdmissionCommand = Type.Static<typeof evaluationAdmissionCommandSchema>;
type PreparationCommand = {
  readonly version: 1;
  readonly commandId: string;
  readonly fingerprint: string;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly sourceInventory: EvaluationSourceInventory;
  readonly executionProfile: EvaluationExecutionProfile;
};

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export interface HostedQualificationEvidence {
  inspect(runId: string, query: EvidenceTimelineQuery): Promise<HostedRunTimelineInspection>;
  readArtifact?(
    runId: string,
    artifactSaid: string,
    signal?: AbortSignal,
  ): Promise<
    | { readonly kind: 'Read'; readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array }
    | { readonly kind: 'NotFound' | 'ResponseInvalid' | 'ServerUnavailable' }
  >;
  readVerifierReceipt?(
    runId: string,
    receiptSaid: string,
    signal?: AbortSignal,
  ): Promise<
    | {
        readonly kind: 'Read';
        readonly checkpointSaid: string;
        readonly receipt: PublicVerifierReceipt;
      }
    | { readonly kind: 'NotFound' | 'ResponseInvalid' | 'ServerUnavailable' }
  >;
}

export interface RunQualification {
  inspect(input: {
    readonly task: TaskProjection;
    readonly originRunId: string;
    readonly executionProfileSaid: string;
    readonly expectedActiveRevisionSaid: string;
    readonly runs: { inspect(runId: string): Promise<HostedRunInspection> };
    readonly evidence: HostedQualificationEvidence;
    readonly signal: AbortSignal;
  }): Promise<
    | {
        readonly kind: 'Qualified';
        readonly taskId: string;
        readonly taskRevisionSaid: string;
        readonly originRunId: string;
        readonly retainedCheckpointSaid: string;
        readonly retainedSealSaid: string;
        readonly expectedActiveRevisionSaid: string;
        readonly personalAgentAid: string;
        readonly taskMandateSaid: string;
        readonly executionProfileSaid: string;
      }
    | { readonly kind: 'Blocked' | 'Unavailable' }
  >;
}

export interface HarnessEvaluationDependencies {
  readonly policy: {
    read(path: string): Promise<
      | {
          readonly kind: 'Read';
          readonly policy: EvaluationPolicy;
          readonly profile: EvaluationExecutionProfile;
          readonly inventory: EvaluationSourceInventory;
        }
      | { readonly kind: 'Rejected' }
    >;
  };
  readonly authority: {
    acquire(): Promise<
      | {
          readonly kind: 'Authorized';
          readonly ownerAid: string;
          readonly tasks: { inspect(label: string): Promise<HostedTaskInspection> };
          readonly runs: { inspect(runId: string): Promise<HostedRunInspection> };
          readonly evidence: HostedQualificationEvidence;
          readonly evaluations: {
            prepare(
              command: PreparationCommand,
              signal?: AbortSignal,
            ): Promise<
              | { readonly kind: 'Prepared' | 'AlreadyPrepared' }
              | { readonly kind: 'Rejected' | 'Conflict' | 'Unavailable' | 'ResponseInvalid' }
            >;
            admit(
              command: AdmissionCommand,
              signal?: AbortSignal,
            ): Promise<
              | {
                  readonly kind: 'Admitted';
                  readonly evaluationId: string;
                  readonly version: number;
                  readonly lease: { readonly evaluationId: string };
                  readonly evidenceStreamId: string;
                  readonly reservationSaid: string;
                }
              | {
                  readonly kind: 'Blocked';
                  readonly gate:
                    'Profile' | 'Source' | 'Authority' | 'Budget' | 'Qualification' | 'Evidence';
                }
              | { readonly kind: 'Rejected' | 'Conflict' | 'Unavailable' | 'ResponseInvalid' }
            >;
          };
        }
      | { readonly kind: 'Unavailable' }
    >;
  };
  readonly qualification: RunQualification;
  readonly commands: {
    acquire(input: {
      readonly taskId: string;
      readonly originRunId: string;
      readonly policySaid: string;
    }): Promise<
      | {
          readonly kind: 'Recorded';
          readonly commandId: string;
          readonly fingerprint: string;
          readonly admittedEvaluationId?: string;
        }
      | { readonly kind: 'Conflict' | 'Unavailable' }
    >;
    recordAdmission(
      input: { readonly taskId: string; readonly originRunId: string; readonly policySaid: string },
      commandId: string,
      evaluationId: string,
    ): Promise<{ readonly kind: 'Recorded' | 'Conflict' | 'Unavailable' }>;
  };
}

/** The command's qualification, authority and custody gates precede any hosted reservation. */
export class HarnessEvaluation {
  readonly #dependencies: HarnessEvaluationDependencies;

  constructor(dependencies: HarnessEvaluationDependencies) {
    this.#dependencies = dependencies;
  }

  async evaluate(
    label: string,
    originRunId: string,
    policyPath: string,
    signal: AbortSignal,
  ): Promise<HarnessEvaluationOutcome> {
    if (interrupted(signal)) return { kind: 'Interrupted' };
    if (!Value.Check(taskLabelSchema, label)) return { kind: 'InvalidInput', reason: 'Label' };
    if (!Value.Check(evaluationAdmissionCommandSchema.properties.originRunId, originRunId)) {
      return { kind: 'InvalidInput', reason: 'RunId' };
    }
    const reading = await this.#dependencies.policy.read(policyPath);
    if (reading.kind !== 'Read') return { kind: 'InvalidInput', reason: 'Policy' };
    const { policy, profile, inventory } = reading;
    if (policy.originRunId !== originRunId) {
      return { kind: 'InvalidInput', reason: 'PolicyBinding' };
    }
    if (interrupted(signal)) return { kind: 'Interrupted' };
    const authority = await this.#dependencies.authority.acquire();
    if (authority.kind !== 'Authorized') {
      return { kind: 'Unavailable', reason: 'HostedWork' };
    }
    const inspected = await authority.tasks.inspect(label);
    if (inspected.kind !== 'Inspected') return { kind: 'Blocked', gate: 'Authority' };
    const task = inspected.task;
    if (
      task.taskId !== policy.taskId ||
      task.revisionSaid !== policy.taskRevisionSaid ||
      task.ownerAid !== authority.ownerAid ||
      inventory.ownerAid !== authority.ownerAid ||
      profile.sourceGitCommit !== task.revision.repository.commit ||
      profile.sourceGitTree !== task.revision.repository.tree
    )
      return { kind: 'InvalidInput', reason: 'PolicyBinding' };
    if (interrupted(signal)) return { kind: 'Interrupted' };
    const qualified = await this.#dependencies.qualification.inspect({
      task,
      originRunId,
      executionProfileSaid: policy.executionProfileSaid,
      expectedActiveRevisionSaid: policy.expectedActiveRevisionSaid,
      runs: authority.runs,
      evidence: authority.evidence,
      signal,
    });
    if (qualified.kind !== 'Qualified') {
      return qualified.kind === 'Blocked'
        ? { kind: 'Blocked', gate: 'Qualification' }
        : { kind: 'Unavailable', reason: 'EvaluationService' };
    }
    if (
      qualified.taskId !== policy.taskId ||
      qualified.taskRevisionSaid !== policy.taskRevisionSaid ||
      qualified.originRunId !== originRunId ||
      qualified.expectedActiveRevisionSaid !== policy.expectedActiveRevisionSaid ||
      qualified.executionProfileSaid !== policy.executionProfileSaid
    )
      return { kind: 'Blocked', gate: 'Qualification' };
    const commandInput = { taskId: task.taskId, originRunId, policySaid: policy.d };
    const command = await this.#dependencies.commands.acquire(commandInput);
    if (command.kind === 'Conflict') return { kind: 'InvalidInput', reason: 'CommandConflict' };
    if (command.kind !== 'Recorded') return { kind: 'Unavailable', reason: 'Custody' };
    if (interrupted(signal)) return { kind: 'Interrupted' };
    if (command.admittedEvaluationId === undefined) {
      const preparation = await authority.evaluations.prepare(
        {
          version: 1,
          commandId: command.commandId,
          fingerprint: command.fingerprint,
          taskId: task.taskId,
          taskRevisionSaid: task.revisionSaid,
          sourceInventory: inventory,
          executionProfile: profile,
        },
        signal,
      );
      if (interrupted(signal)) return { kind: 'Interrupted' };
      if (preparation.kind === 'Conflict') {
        return { kind: 'InvalidInput', reason: 'CommandConflict' };
      }
      if (preparation.kind === 'Rejected') return { kind: 'Blocked', gate: 'Source' };
      if (preparation.kind !== 'Prepared' && preparation.kind !== 'AlreadyPrepared') {
        return { kind: 'Unavailable', reason: 'EvaluationService' };
      }
    }
    if (interrupted(signal)) return { kind: 'Interrupted' };
    const admitted = await authority.evaluations.admit(
      {
        version: 1,
        commandId: command.commandId,
        fingerprint: command.fingerprint,
        taskId: task.taskId,
        taskRevisionSaid: task.revisionSaid,
        originRunId,
        retainedCheckpointSaid: qualified.retainedCheckpointSaid,
        retainedSealSaid: qualified.retainedSealSaid,
        expectedActiveRevisionSaid: qualified.expectedActiveRevisionSaid,
        personalAgentAid: qualified.personalAgentAid,
        taskMandateSaid: qualified.taskMandateSaid,
        policySaid: policy.d,
        executionProfileSaid: policy.executionProfileSaid,
        sourceInventorySaid: policy.sourceInventorySaid,
        allocation: policy.allocation,
      },
      signal,
    );
    if (interrupted(signal) && admitted.kind !== 'Admitted') return { kind: 'Interrupted' };
    if (admitted.kind === 'Blocked') return { kind: 'Blocked', gate: admitted.gate };
    if (admitted.kind === 'Conflict') {
      return { kind: 'InvalidInput', reason: 'CommandConflict' };
    }
    if (admitted.kind !== 'Admitted') {
      return { kind: 'Unavailable', reason: 'EvaluationService' };
    }
    if (command.admittedEvaluationId !== undefined) {
      return command.admittedEvaluationId === admitted.evaluationId
        ? { kind: 'Blocked', gate: 'ProtectedCases', evaluationId: admitted.evaluationId }
        : { kind: 'InvalidInput', reason: 'CommandConflict' };
    }
    const recorded = await this.#dependencies.commands.recordAdmission(
      commandInput,
      command.commandId,
      admitted.evaluationId,
    );
    if (recorded.kind !== 'Recorded') return { kind: 'Unavailable', reason: 'Custody' };
    if (interrupted(signal)) return { kind: 'Interrupted' };
    // A reservation is not a manifest or protected-case custody. Stop before a worker.
    return { kind: 'Blocked', gate: 'ProtectedCases', evaluationId: admitted.evaluationId };
  }
}
