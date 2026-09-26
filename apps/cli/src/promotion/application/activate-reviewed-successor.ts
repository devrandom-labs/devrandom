import {
  activeHarnessPointerSchema,
  decodeTaskProjection,
  type TaskProjection,
} from '@devrandom/protocol';
import {
  authorizePromotion,
  type PromotionAuthorization,
  type PromotionAuthorizationDependencies,
} from '@devrandom/runtime';
import Value from 'typebox/value';

import type { ActivationPointerReading } from './activation-pointer-reading.js';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ReviewedSuccessorActivationInput {
  readonly task: TaskProjection;
  readonly commandId: string;
  readonly closureSaid: string;
  readonly governorAid: string;
}

export interface ReviewedSuccessorActivationDependencies {
  readonly pointer: ActivationPointerReading;
  readonly authorization: PromotionAuthorizationDependencies;
}

export type ReviewedSuccessorActivation =
  | PromotionAuthorization
  | {
      readonly kind: 'Blocked';
      readonly reason: 'TaskInvalid' | 'PointerUnavailable' | 'PointerMismatch' | 'InputInvalid';
    };

/** Derives the incumbent CAS precondition from owner-scoped hosted truth. */
export async function activateReviewedSuccessor(
  input: ReviewedSuccessorActivationInput,
  dependencies: ReviewedSuccessorActivationDependencies,
): Promise<ReviewedSuccessorActivation> {
  if (
    decodeTaskProjection(input.task).kind !== 'Accepted' ||
    input.task.revision.version !== 2 ||
    input.task.lifecycle.kind !== 'Open'
  )
    return { kind: 'Blocked', reason: 'TaskInvalid' };
  if (
    !uuid.test(input.commandId) ||
    !said.test(input.closureSaid) ||
    !said.test(input.governorAid) ||
    input.governorAid === input.task.ownerAid
  )
    return { kind: 'Blocked', reason: 'InputInvalid' };
  let observed: Awaited<ReturnType<ActivationPointerReading['inspect']>>;
  try {
    observed = await dependencies.pointer.inspect(input.task.taskId);
  } catch {
    return { kind: 'Blocked', reason: 'PointerUnavailable' };
  }
  if (observed.kind !== 'Observed') return { kind: 'Blocked', reason: 'PointerUnavailable' };
  const pointer = observed.pointer;
  if (
    !Value.Check(activeHarnessPointerSchema, pointer) ||
    pointer.taskId !== input.task.taskId ||
    pointer.taskRevisionSaid !== input.task.revisionSaid ||
    pointer.harnessLineageId !== input.task.harnessLineageId
  )
    return { kind: 'Blocked', reason: 'PointerMismatch' };
  return authorizePromotion(
    {
      commandId: input.commandId,
      taskId: input.task.taskId,
      taskRevisionSaid: input.task.revisionSaid,
      harnessLineageId: input.task.harnessLineageId,
      expectedIncumbentRevisionSaid: pointer.activeRevisionSaid,
      expectedPointerVersion: pointer.pointerVersion,
      evaluationClosureSaid: input.closureSaid,
      governorAid: input.governorAid,
    },
    dependencies.authorization,
  );
}
