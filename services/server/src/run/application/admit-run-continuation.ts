import type { Run } from '@devrandom/domain';
import {
  projectRun,
  type ActiveHarnessPointer,
  type RunContinuationReceipt,
  type RunContinuationRequest,
  type RunSuccessorSegment,
} from '@devrandom/protocol';

import type { CurrentMandateUserCredential } from '../../mandate/application/user-credential.js';
import type { AuthenticatedTaskOwner } from '../../task/application/tasks.js';
import type { CurrentRunMandates } from './run-authority.js';
import type { Runs } from './runs.js';

export interface RunContinuationCommitments {
  admit(input: {
    readonly ownerAid: string;
    readonly run: Run;
    readonly command: RunContinuationRequest;
    readonly activation: ActiveHarnessPointer;
    readonly observedAt: string;
  }): Promise<
    | {
        readonly kind: 'Admitted' | 'Equivalent';
        readonly run: Run;
        readonly segment: RunSuccessorSegment;
      }
    | { readonly kind: 'Rejected' | 'Unavailable' }
  >;
}

/** An exact committed activation and current mandate precede a same-Run replacement lease. */
export async function admitRunContinuation(
  input: {
    readonly owner: AuthenticatedTaskOwner;
    readonly runId: string;
    readonly command: RunContinuationRequest;
  },
  dependencies: {
    readonly credentials: CurrentMandateUserCredential;
    readonly runs: Pick<Runs, 'findById'>;
    readonly mandates: CurrentRunMandates;
    readonly activation: {
      read(input: {
        readonly ownerAid: string;
        readonly taskId: string;
      }): Promise<
        | { readonly kind: 'Read'; readonly pointer: ActiveHarnessPointer }
        | { readonly kind: 'Absent' | 'Conflict' | 'Unavailable' }
      >;
    };
    readonly commitments: RunContinuationCommitments;
    now(): string;
  },
): Promise<
  | { readonly kind: 'Admitted' | 'Equivalent'; readonly receipt: RunContinuationReceipt }
  | { readonly kind: 'RunNotFound' | 'Rejected' | 'Unavailable' }
> {
  const credential = await dependencies.credentials.verify(input.owner);
  if (credential.kind !== 'UserCredentialCurrent')
    return { kind: credential.kind === 'DependencyUnavailable' ? 'Unavailable' : 'Rejected' };
  const inspected = await dependencies.runs.findById(input.owner.ownerAid, input.runId);
  if (inspected.kind === 'RunNotFound') return { kind: 'RunNotFound' };
  if (inspected.kind !== 'RunFound') return { kind: 'Unavailable' };
  const run = inspected.run;
  const observedAt = dependencies.now();
  const authority = await dependencies.mandates.authorize({
    ownerAid: input.owner.ownerAid,
    taskId: run.binding.taskId,
    taskRevisionSaid: run.binding.taskRevisionSaid,
    harnessLineageId: run.binding.harnessLineageId,
    personalAgentAid: run.binding.personalAgentAid,
    taskMandateSaid: run.binding.taskMandateSaid,
    governorAid: run.binding.governorAid,
    promotionMandateSaid: run.binding.promotionMandateSaid,
    observedAt,
  });
  if (authority.kind !== 'CurrentRunMandatesAuthorized')
    return { kind: authority.kind === 'DependencyUnavailable' ? 'Unavailable' : 'Rejected' };
  if (
    authority.task.taskId !== run.binding.taskId ||
    authority.task.revisionSaid !== run.binding.taskRevisionSaid ||
    authority.personalAgentAid !== run.binding.personalAgentAid ||
    authority.taskMandateSaid !== run.binding.taskMandateSaid
  )
    return { kind: 'Rejected' };
  const active = await dependencies.activation.read({
    ownerAid: input.owner.ownerAid,
    taskId: run.binding.taskId,
  });
  if (active.kind === 'Unavailable') return { kind: 'Unavailable' };
  if (
    active.kind !== 'Read' ||
    active.pointer.taskId !== run.binding.taskId ||
    active.pointer.taskRevisionSaid !== run.binding.taskRevisionSaid ||
    active.pointer.harnessLineageId !== run.binding.harnessLineageId
  )
    return { kind: 'Rejected' };
  if (input.command.version === 2) {
    if (
      run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
      active.pointer.kind !== 'Initial' ||
      active.pointer.activeRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
      input.command.expectedHarnessRevisionSaid !== run.binding.initialHarnessRevisionSaid
    )
      return { kind: 'Rejected' };
  } else if (
    active.pointer.kind !== 'Committed' ||
    active.pointer.disposition !== 'Activated' ||
    active.pointer.pointerVersion !== input.command.expectedActivePointerVersion ||
    active.pointer.decisionReceiptSaid !== input.command.expectedActivationReceiptSaid
  )
    return { kind: 'Rejected' };
  const committed = await dependencies.commitments.admit({
    ownerAid: input.owner.ownerAid,
    run,
    command: input.command,
    activation: active.pointer,
    observedAt,
  });
  if (committed.kind !== 'Admitted' && committed.kind !== 'Equivalent')
    return { kind: committed.kind };
  return {
    kind: committed.kind,
    receipt: {
      version: 1,
      disposition: committed.kind,
      run: projectRun(committed.run),
      segment: committed.segment,
    },
  };
}
