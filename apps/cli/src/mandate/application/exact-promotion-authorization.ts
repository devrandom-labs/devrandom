import type { IssuerAid, LocalMandateCustody } from '@devrandom/identity';
import {
  decodeEvaluationManifest,
  type EvaluationManifest,
  type TaskProjection,
} from '@devrandom/protocol';

import type { LocalGovernanceProfile } from '../domain/local-governance.js';
import type { ReadyTaskAuthorization } from '../domain/task-authorization.js';
import type { HostedMandatePresentations } from './hosted-mandate-presentations.js';
import {
  TaskMandateAuthorization,
  type TaskAuthorizationRecords,
  type TaskMandateAuthorizationOutcome,
} from './task-mandate-authorization.js';

export function bindExactPromotionMandate(input: {
  readonly task: TaskProjection;
  readonly manifest: unknown;
  readonly initialReadyAuthorization: ReadyTaskAuthorization | undefined;
}):
  | { readonly kind: 'Bound'; readonly manifest: EvaluationManifest }
  | { readonly kind: 'BindingRejected' } {
  const decoded = decodeEvaluationManifest(input.manifest);
  const ready = input.initialReadyAuthorization;
  if (decoded.kind !== 'Accepted' || ready === undefined) return { kind: 'BindingRejected' };
  const manifest = decoded.manifest;
  if (
    input.task.revision.version !== 2 ||
    manifest.taskId !== input.task.taskId ||
    manifest.taskRevisionSaid !== input.task.revisionSaid ||
    manifest.ownerAid !== input.task.ownerAid ||
    ready.binding.taskId !== input.task.taskId ||
    ready.binding.taskRevisionSaid !== input.task.revisionSaid ||
    ready.binding.harnessLineageId !== input.task.harnessLineageId ||
    ready.binding.ownerAid !== input.task.ownerAid ||
    ready.binding.personalAgentAid !== manifest.personalAgentAid ||
    ready.stage.taskMandate.credential.credentialSaid !== manifest.taskMandateSaid
  )
    return { kind: 'BindingRejected' };
  return { kind: 'Bound', manifest };
}

/** Exact-M post-H0 grant/admission uses its own M-scoped record and existing KERIA protocol law. */
export async function authorizeExactPromotionMandate(
  input: {
    readonly task: TaskProjection;
    readonly manifest: unknown;
    readonly initialReadyAuthorization: ReadyTaskAuthorization | undefined;
    readonly governance: LocalGovernanceProfile;
    readonly issuerAid: IssuerAid;
    readonly userAlias: string;
    readonly workAccessExpiresAt: string;
  },
  dependencies: {
    readonly recordsForManifest: (
      manifestSaid: string,
      initialReadyAuthorization: ReadyTaskAuthorization,
    ) => TaskAuthorizationRecords;
    readonly custody: LocalMandateCustody;
    readonly presentations: HostedMandatePresentations;
    now(): number;
    wait(milliseconds: number): Promise<void>;
    readonly maximumObservations: number;
  },
): Promise<TaskMandateAuthorizationOutcome> {
  const bound = bindExactPromotionMandate(input);
  if (bound.kind !== 'Bound' || input.initialReadyAuthorization === undefined)
    return { kind: 'BindingRejected' };
  const ready = input.initialReadyAuthorization;
  if (
    ready.binding.personalAgentAid !== input.governance.personalAgentAid ||
    ready.binding.governorAid !== input.governance.governorAid ||
    ready.binding.mandateRegistryId !== input.governance.mandateRegistryId ||
    ready.binding.issuerAid !== input.issuerAid ||
    ready.binding.ownerAid !== input.governance.userAid
  )
    return { kind: 'BindingRejected' };
  return new TaskMandateAuthorization({
    records: dependencies.recordsForManifest(bound.manifest.d, ready),
    custody: dependencies.custody,
    presentations: dependencies.presentations,
    now: () => dependencies.now(),
    wait: (milliseconds) => dependencies.wait(milliseconds),
    maximumObservations: dependencies.maximumObservations,
  }).authorize({
    userAlias: input.userAlias,
    task: input.task,
    governance: input.governance,
    issuerAid: input.issuerAid,
    workAccessExpiresAt: input.workAccessExpiresAt,
    exactPromotionManifestSaid: bound.manifest.d,
    initialReadyAuthorization: ready,
  });
}
