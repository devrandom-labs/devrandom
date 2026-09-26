import {
  taskBudgetCeilings,
  verifyPromotionMandate,
  verifyExactPromotionMandate,
  verifyTaskMandate,
  type PromotionMandateInspection,
  type ExactPromotionMandateClaims,
  type ExactPromotionMandateInvalidity,
  type CurrentTaskMandate,
  type MandateTask,
} from '@devrandom/domain';
import {
  GOVERNOR_ALIAS,
  PERSONAL_AGENT_ALIAS,
  credentialSaid,
  ipexGrantSaid,
  type IssuerAid,
  type LocalMandateCustody,
  type MandateHolderAdmissionInput,
  type MandateInspection,
  type StableMandateGrant,
  type StableMandateIssuance,
} from '@devrandom/identity';
import {
  promotionMandateSchemaSaid,
  promotionMandateV2SchemaSaid,
  promotionMandateV3SchemaSaid,
  promotionMandateV4SchemaSaid,
  promotionMandateV5SchemaSaid,
  taskMandateSchemaSaid,
  taskMandateV2SchemaSaid,
  taskMandateV3SchemaSaid,
  type MandatePresentationProblem,
  type TaskProjection,
} from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

import type { LocalGovernanceProfile } from '../domain/local-governance.js';
import {
  advanceTaskAuthorization,
  beginExactPromotionAuthorization,
  beginTaskAuthorization,
  type MandateProtocolProgress,
  type ReadyTaskAuthorization,
  type TaskAuthorization,
  type TaskAuthorizationAdvancement,
  type TaskAuthorizationBinding,
  type TaskAuthorizationRejection,
} from '../domain/task-authorization.js';
import type { HostedMandatePresentations } from './hosted-mandate-presentations.js';
import {
  preparePromotionMandateIssuance,
  prepareExactPromotionMandateIssuance,
  prepareTaskMandateIssuance,
  type MandateIssuancePlan,
} from './mandate-issuance-plan.js';

const observationIntervalMilliseconds = 1_000;

type MandateKind = StableMandateIssuance['kind'];
type MandateProgressStage = `${MandateKind}.${MandateProtocolProgress['kind']}`;

export interface TaskAuthorizationRecords {
  read(taskId: string): Promise<TaskAuthorization | undefined>;
  commit(previousRevision: number | undefined, authorization: TaskAuthorization): Promise<void>;
}

export interface TaskMandateAuthorizationInput {
  readonly userAlias: string;
  readonly task: TaskProjection;
  readonly governance: LocalGovernanceProfile;
  readonly issuerAid: IssuerAid;
  readonly workAccessExpiresAt: string;
  /** Present only for a separate post-M exact promotion authorization record. */
  readonly exactPromotionManifestSaid?: string;
  readonly initialReadyAuthorization?: ReadyTaskAuthorization;
}

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const exactClaims = Type.Object(
  {
    evaluationManifestSaid: said,
    requiredMetrics: Type.Array(Type.String()),
    requiredChecks: Type.Array(Type.String()),
    riskLimit: Type.Object(
      {
        maximumUnsafeEffects: Type.Integer({ minimum: 0 }),
        maximumDisqualifyingAttempts: Type.Integer({ minimum: 0 }),
        minimumAdditionalSuccessesOverEachControl: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: true },
);

function hasExactClaims(
  value: PromotionMandateInspection,
): value is PromotionMandateInspection & ExactPromotionMandateClaims {
  return Value.Check(exactClaims, value);
}

export interface TaskMandateAuthorizationDependencies {
  readonly records: TaskAuthorizationRecords;
  readonly custody: LocalMandateCustody;
  readonly presentations: HostedMandatePresentations;
  now(): number;
  wait(milliseconds: number): Promise<void>;
  readonly maximumObservations: number;
}

type MandateInspectionInvalidity =
  ExactPromotionMandateInvalidity | { readonly kind: 'MandateKindMismatch' };

export type TaskMandateAuthorizationOutcome =
  | { readonly kind: 'Ready'; readonly authorization: ReadyTaskAuthorization }
  | { readonly kind: 'BindingRejected' }
  | {
      readonly kind: 'IssuanceRejected';
      readonly mandateKind: MandateKind;
      readonly reason: Extract<MandateIssuancePlan<never>, { readonly kind: 'Rejected' }>['reason'];
    }
  | {
      readonly kind: 'ProtocolRejected';
      readonly stage: MandateProgressStage;
      readonly reason: TaskAuthorizationRejection;
    }
  | {
      readonly kind: 'MandateInvalid';
      readonly mandateKind: MandateKind;
      readonly invalidity: MandateInspectionInvalidity;
    }
  | {
      readonly kind: 'CustodyOperationFailed';
      readonly stage: MandateProgressStage;
      readonly status: number;
      readonly reason: string;
    }
  | { readonly kind: 'ProtocolEvidenceInvalid'; readonly stage: MandateProgressStage }
  | {
      readonly kind: 'PresentationRejected';
      readonly mandateKind: MandateKind;
      readonly problem: MandatePresentationProblem;
    }
  | {
      readonly kind: 'PresentationUnavailable';
      readonly mandateKind: MandateKind;
    }
  | {
      readonly kind: 'PresentationResponseInvalid';
      readonly mandateKind: MandateKind;
    }
  | { readonly kind: 'PollingLimitReached'; readonly stage: MandateProgressStage };

type AuthorizationRetention =
  | { readonly kind: 'Retained'; readonly authorization: TaskAuthorization }
  | { readonly kind: 'Rejected'; readonly reason: TaskAuthorizationRejection };

type InspectionVerification =
  | { readonly kind: 'Verified'; readonly taskMandate?: CurrentTaskMandate }
  | { readonly kind: 'Invalid'; readonly invalidity: MandateInspectionInvalidity };

export class TaskMandateAuthorization {
  readonly #dependencies: TaskMandateAuthorizationDependencies;

  constructor(dependencies: TaskMandateAuthorizationDependencies) {
    this.#dependencies = dependencies;
  }

  async authorize(input: TaskMandateAuthorizationInput): Promise<TaskMandateAuthorizationOutcome> {
    if (
      !Number.isSafeInteger(this.#dependencies.maximumObservations) ||
      this.#dependencies.maximumObservations < 1
    ) {
      return { kind: 'ProtocolEvidenceInvalid', stage: 'TaskMandate.IssuancePrepared' };
    }
    let authorization = await this.#dependencies.records.read(input.task.taskId);
    if (authorization === undefined) {
      const beginning =
        input.exactPromotionManifestSaid === undefined
          ? beginTaskAuthorization(binding(input), this.#dependencies.now())
          : input.initialReadyAuthorization !== undefined &&
              sameBinding(input.initialReadyAuthorization.binding, binding(input))
            ? beginExactPromotionAuthorization(
                input.initialReadyAuthorization,
                input.exactPromotionManifestSaid,
                this.#dependencies.now(),
              )
            : { kind: 'Rejected' as const, reason: 'BindingInvalid' as const };
      if (beginning.kind === 'Rejected') {
        return { kind: 'BindingRejected' };
      }
      await this.#dependencies.records.commit(undefined, beginning.authorization);
      authorization = beginning.authorization;
    } else if (!sameBinding(authorization.binding, binding(input))) {
      return { kind: 'BindingRejected' };
    }
    if (authorization.exactPromotionManifestSaid !== input.exactPromotionManifestSaid)
      return { kind: 'BindingRejected' };
    if (
      input.exactPromotionManifestSaid !== undefined &&
      authorization.stage.kind === 'TaskMandate'
    )
      return { kind: 'BindingRejected' };
    await this.#dependencies.custody.prepareSchemas();

    let observationCount = 0;
    for (;;) {
      if (authorization.stage.kind === 'Ready') {
        const verification = await this.#verifyInspection(
          input,
          authorization,
          'PromotionMandate',
          await this.#dependencies.custody.inspectCredential({
            credentialSaid: credentialSaid(
              authorization.stage.promotionMandate.credential.credentialSaid,
            ),
          }),
        );
        return verification.kind === 'Verified'
          ? {
              kind: 'Ready',
              authorization: { ...authorization, stage: authorization.stage },
            }
          : {
              kind: 'MandateInvalid',
              mandateKind: 'PromotionMandate',
              invalidity: verification.invalidity,
            };
      }

      const mandateKind = authorization.stage.kind;
      const progress = authorization.stage.progress;
      const stage = progressStage(mandateKind, progress);
      const issuancePlan = mandateIssuancePlan(input, mandateKind, protocolIssuedAt(progress));
      if (issuancePlan.kind === 'Rejected') {
        return { kind: 'IssuanceRejected', mandateKind, reason: issuancePlan.reason };
      }
      const issuance = issuancePlan.issuance;

      if (credentialHasMaterialized(progress)) {
        const verification = await this.#verifyInspection(
          input,
          authorization,
          mandateKind,
          await this.#dependencies.custody.inspectCredential({
            credentialSaid: credentialSaid(progress.credential.credentialSaid),
          }),
        );
        if (verification.kind === 'Invalid') {
          return { kind: 'MandateInvalid', mandateKind, invalidity: verification.invalidity };
        }
      }

      switch (progress.kind) {
        case 'IssuancePrepared': {
          const reconciliation = await this.#dependencies.custody.reconcileIssuance(issuance);
          if (reconciliation.kind === 'Materialized') {
            const retained = await this.#retain(authorization, {
              kind: 'CredentialMaterialized',
              credentialSaid: reconciliation.credentialSaid,
            });
            if (retained.kind === 'Rejected') {
              return { kind: 'ProtocolRejected', stage, reason: retained.reason };
            }
            authorization = retained.authorization;
            continue;
          }
          if (reconciliation.kind === 'Submitted') {
            const retained = await this.#retain(authorization, {
              kind: 'CredentialIssuanceSubmitted',
              credentialSaid: reconciliation.credentialSaid,
              operationName: reconciliation.operationName,
            });
            if (retained.kind === 'Rejected') {
              return { kind: 'ProtocolRejected', stage, reason: retained.reason };
            }
            authorization = retained.authorization;
            continue;
          }
          const submitted = await this.#dependencies.custody.submitIssuance(issuance);
          const retained = await this.#retain(authorization, {
            kind: 'CredentialIssuanceSubmitted',
            credentialSaid: submitted.credentialSaid,
            operationName: submitted.operationName,
          });
          if (retained.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: retained.reason };
          }
          authorization = retained.authorization;
          continue;
        }
        case 'IssuanceSubmitted': {
          const observed = await this.#dependencies.custody.observeIssuance({
            ...issuance,
            credentialSaid: credentialSaid(progress.credentialSaid),
            operationName: progress.operationName,
          });
          if (observed.kind === 'Pending') {
            observationCount += 1;
            if (observationCount >= this.#dependencies.maximumObservations) {
              return { kind: 'PollingLimitReached', stage };
            }
            await this.#dependencies.wait(observationIntervalMilliseconds);
            continue;
          }
          if (observed.kind === 'Failed') {
            return {
              kind: 'CustodyOperationFailed',
              stage,
              status: observed.status,
              reason: observed.reason,
            };
          }
          const verification = await this.#verifyInspection(
            input,
            authorization,
            mandateKind,
            observed.inspection,
          );
          if (verification.kind === 'Invalid') {
            return { kind: 'MandateInvalid', mandateKind, invalidity: verification.invalidity };
          }
          const retained = await this.#retain(authorization, {
            kind: 'CredentialMaterialized',
            credentialSaid: progress.credentialSaid,
          });
          if (retained.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: retained.reason };
          }
          authorization = retained.authorization;
          continue;
        }
        case 'CredentialMaterialized': {
          const retained = await this.#retain(authorization, {
            kind: 'PrepareHolderGrant',
            preparedAt: this.#dependencies.now(),
          });
          if (retained.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: retained.reason };
          }
          authorization = retained.authorization;
          continue;
        }
        case 'HolderGrantPreparing': {
          const grant = holderGrant(input, issuance, progress);
          const prepared = await this.#dependencies.custody.prepareGrant(grant);
          const retained = await this.#retain(authorization, {
            kind: 'HolderGrantPrepared',
            grantSaid: prepared.grantSaid,
          });
          if (retained.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: retained.reason };
          }
          authorization = retained.authorization;
          continue;
        }
        case 'HolderGrantPrepared':
        case 'HolderGrantSubmitted': {
          const grant = holderGrant(input, issuance, progress);
          const submission = { ...grant, grantSaid: ipexGrantSaid(progress.grantSaid) };
          if (progress.kind === 'HolderGrantPrepared') {
            const reconciliation = await this.#dependencies.custody.reconcileGrant(submission);
            if (reconciliation.kind === 'Materialized') {
              const retained = await this.#retain(authorization, {
                kind: 'HolderGrantMaterialized',
              });
              if (retained.kind === 'Rejected') {
                return { kind: 'ProtocolRejected', stage, reason: retained.reason };
              }
              authorization = retained.authorization;
              continue;
            }
            const submitted =
              reconciliation.kind === 'Submitted'
                ? reconciliation
                : await this.#dependencies.custody.submitGrant(submission);
            if (submitted.kind === 'NotFound') {
              return { kind: 'ProtocolEvidenceInvalid', stage };
            }
            if (submitted.kind === 'Materialized') {
              const retained = await this.#retain(authorization, {
                kind: 'HolderGrantMaterialized',
              });
              if (retained.kind === 'Rejected') {
                return { kind: 'ProtocolRejected', stage, reason: retained.reason };
              }
              authorization = retained.authorization;
              continue;
            }
            const retained = await this.#retain(authorization, {
              kind: 'HolderGrantSubmitted',
              operationName: submitted.operationName,
            });
            if (retained.kind === 'Rejected') {
              return { kind: 'ProtocolRejected', stage, reason: retained.reason };
            }
            authorization = retained.authorization;
            continue;
          }
          const observed = await this.#dependencies.custody.observeGrant({
            ...submission,
            operationName: progress.operationName,
          });
          if (observed.kind === 'Pending') {
            observationCount += 1;
            if (observationCount >= this.#dependencies.maximumObservations) {
              return { kind: 'PollingLimitReached', stage };
            }
            await this.#dependencies.wait(observationIntervalMilliseconds);
            continue;
          }
          if (observed.kind === 'Failed') {
            return {
              kind: 'CustodyOperationFailed',
              stage,
              status: observed.status,
              reason: observed.reason,
            };
          }
          const retained = await this.#retain(authorization, {
            kind: 'HolderGrantMaterialized',
          });
          if (retained.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: retained.reason };
          }
          authorization = retained.authorization;
          continue;
        }
        case 'HolderGrantMaterialized': {
          const retained = await this.#retain(authorization, {
            kind: 'PrepareHolderAdmission',
            preparedAt: this.#dependencies.now(),
          });
          if (retained.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: retained.reason };
          }
          authorization = retained.authorization;
          continue;
        }
        case 'HolderAdmissionPreparing': {
          const admission = holderAdmission(input, issuance, progress);
          const started = await this.#dependencies.custody.beginHolderAdmission(admission);
          if (started.kind === 'GrantPending') {
            observationCount += 1;
            if (observationCount >= this.#dependencies.maximumObservations) {
              return { kind: 'PollingLimitReached', stage };
            }
            await this.#dependencies.wait(observationIntervalMilliseconds);
            continue;
          }
          if (started.kind === 'Started') {
            const retained = await this.#retain(authorization, {
              kind: 'HolderAdmissionSubmitted',
              admitSaid: started.admitSaid,
              operationName: started.operationName,
            });
            if (retained.kind === 'Rejected') {
              return { kind: 'ProtocolRejected', stage, reason: retained.reason };
            }
            authorization = retained.authorization;
            continue;
          }
          if (started.kind === 'AwaitingMaterialization') {
            const retained = await this.#retain(authorization, {
              kind: 'HolderAdmissionRecovered',
              admitSaid: started.admitSaid,
            });
            if (retained.kind === 'Rejected') {
              return { kind: 'ProtocolRejected', stage, reason: retained.reason };
            }
            authorization = retained.authorization;
            continue;
          }
          const verification = await this.#verifyInspection(
            input,
            authorization,
            mandateKind,
            started.inspection,
          );
          if (verification.kind === 'Invalid') {
            return { kind: 'MandateInvalid', mandateKind, invalidity: verification.invalidity };
          }
          const recovered = await this.#retain(authorization, {
            kind: 'HolderAdmissionRecovered',
            admitSaid: started.admitSaid,
          });
          if (recovered.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: recovered.reason };
          }
          const verified = await this.#retain(recovered.authorization, {
            kind: 'HolderVerified',
          });
          if (verified.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: verified.reason };
          }
          authorization = verified.authorization;
          continue;
        }
        case 'HolderAdmissionAwaitingMaterialization': {
          const admission = holderAdmission(input, issuance, progress);
          const observed = await this.#dependencies.custody.observeHolderAdmission(
            progress.holderAdmission.submission.kind === 'OperationRecorded'
              ? {
                  ...admission,
                  kind: 'Submitted',
                  admitSaid: progress.holderAdmission.admitSaid,
                  operationName: progress.holderAdmission.submission.operationName,
                }
              : {
                  ...admission,
                  kind: 'ExchangeMaterialized',
                  admitSaid: progress.holderAdmission.admitSaid,
                },
          );
          if (observed.kind === 'Pending') {
            observationCount += 1;
            if (observationCount >= this.#dependencies.maximumObservations) {
              return { kind: 'PollingLimitReached', stage };
            }
            await this.#dependencies.wait(observationIntervalMilliseconds);
            continue;
          }
          if (observed.kind === 'Failed') {
            return {
              kind: 'CustodyOperationFailed',
              stage,
              status: observed.status,
              reason: observed.reason,
            };
          }
          const verification = await this.#verifyInspection(
            input,
            authorization,
            mandateKind,
            observed.inspection,
          );
          if (verification.kind === 'Invalid') {
            return { kind: 'MandateInvalid', mandateKind, invalidity: verification.invalidity };
          }
          const retained = await this.#retain(authorization, { kind: 'HolderVerified' });
          if (retained.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: retained.reason };
          }
          authorization = retained.authorization;
          continue;
        }
        case 'HolderVerified': {
          const retained = await this.#retain(authorization, {
            kind: 'PrepareServerGrant',
            preparedAt: this.#dependencies.now(),
          });
          if (retained.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: retained.reason };
          }
          authorization = retained.authorization;
          continue;
        }
        case 'ServerGrantPreparing': {
          const grant = serverGrant(input, issuance, progress);
          const prepared = await this.#dependencies.custody.prepareGrant(grant);
          const retained = await this.#retain(authorization, {
            kind: 'ServerGrantPrepared',
            grantSaid: prepared.grantSaid,
          });
          if (retained.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: retained.reason };
          }
          authorization = retained.authorization;
          continue;
        }
        case 'ServerGrantPrepared':
        case 'ServerGrantSubmitted': {
          const grant = serverGrant(input, issuance, progress);
          const submission = { ...grant, grantSaid: ipexGrantSaid(progress.grantSaid) };
          if (progress.kind === 'ServerGrantPrepared') {
            const reconciliation = await this.#dependencies.custody.reconcileGrant(submission);
            if (reconciliation.kind === 'Materialized') {
              const retained = await this.#retain(authorization, {
                kind: 'ServerGrantMaterialized',
              });
              if (retained.kind === 'Rejected') {
                return { kind: 'ProtocolRejected', stage, reason: retained.reason };
              }
              authorization = retained.authorization;
              continue;
            }
            const submitted =
              reconciliation.kind === 'Submitted'
                ? reconciliation
                : await this.#dependencies.custody.submitGrant(submission);
            if (submitted.kind === 'NotFound') {
              return { kind: 'ProtocolEvidenceInvalid', stage };
            }
            if (submitted.kind === 'Materialized') {
              const retained = await this.#retain(authorization, {
                kind: 'ServerGrantMaterialized',
              });
              if (retained.kind === 'Rejected') {
                return { kind: 'ProtocolRejected', stage, reason: retained.reason };
              }
              authorization = retained.authorization;
              continue;
            }
            const retained = await this.#retain(authorization, {
              kind: 'ServerGrantSubmitted',
              operationName: submitted.operationName,
            });
            if (retained.kind === 'Rejected') {
              return { kind: 'ProtocolRejected', stage, reason: retained.reason };
            }
            authorization = retained.authorization;
            continue;
          }
          const observed = await this.#dependencies.custody.observeGrant({
            ...submission,
            operationName: progress.operationName,
          });
          if (observed.kind === 'Pending') {
            observationCount += 1;
            if (observationCount >= this.#dependencies.maximumObservations) {
              return { kind: 'PollingLimitReached', stage };
            }
            await this.#dependencies.wait(observationIntervalMilliseconds);
            continue;
          }
          if (observed.kind === 'Failed') {
            return {
              kind: 'CustodyOperationFailed',
              stage,
              status: observed.status,
              reason: observed.reason,
            };
          }
          const retained = await this.#retain(authorization, {
            kind: 'ServerGrantMaterialized',
          });
          if (retained.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: retained.reason };
          }
          authorization = retained.authorization;
          continue;
        }
        case 'ServerGrantMaterialized': {
          const retained = await this.#retain(authorization, {
            kind: 'ServerPresentationAwaitingGrant',
            presentationExpiresAt: input.workAccessExpiresAt,
          });
          if (retained.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: retained.reason };
          }
          authorization = retained.authorization;
          continue;
        }
        case 'ServerPresentationAwaitingGrant':
        case 'ServerPresentationAdmitting': {
          const presented = await this.#dependencies.presentations.present(
            progress.credential.credentialSaid,
            {
              version: 1,
              mandateKind,
              grantSaid: progress.serverGrant.grantSaid,
            },
          );
          if (presented.kind === 'InputInvalid' || presented.kind === 'ResponseInvalid') {
            return { kind: 'PresentationResponseInvalid', mandateKind };
          }
          if (presented.kind === 'ServerUnavailable') {
            return { kind: 'PresentationUnavailable', mandateKind };
          }
          if (presented.kind === 'RequestRejected') {
            return { kind: 'PresentationRejected', mandateKind, problem: presented.problem };
          }
          if (presented.presentation.presentationExpiresAt !== progress.presentationExpiresAt) {
            return { kind: 'PresentationResponseInvalid', mandateKind };
          }
          if (presented.kind === 'Admitted') {
            const retained = await this.#retain(authorization, {
              kind: 'ServerAdmitted',
              presentationExpiresAt: presented.presentation.presentationExpiresAt,
              admittedAt: presented.presentation.admittedAt,
            });
            if (retained.kind === 'Rejected') {
              return { kind: 'ProtocolRejected', stage, reason: retained.reason };
            }
            authorization = retained.authorization;
            continue;
          }
          if (presented.presentation.kind === 'AwaitingGrant') {
            if (progress.kind !== 'ServerPresentationAwaitingGrant') {
              return { kind: 'PresentationResponseInvalid', mandateKind };
            }
          } else if (
            progress.kind === 'ServerPresentationAdmitting' &&
            presented.presentation.operationName !== progress.operationName
          ) {
            return { kind: 'PresentationResponseInvalid', mandateKind };
          } else if (progress.kind === 'ServerPresentationAwaitingGrant') {
            const retained = await this.#retain(authorization, {
              kind: 'ServerPresentationAdmitting',
              presentationExpiresAt: presented.presentation.presentationExpiresAt,
              operationName: presented.presentation.operationName,
            });
            if (retained.kind === 'Rejected') {
              return { kind: 'ProtocolRejected', stage, reason: retained.reason };
            }
            authorization = retained.authorization;
          }
          observationCount += 1;
          if (observationCount >= this.#dependencies.maximumObservations) {
            return { kind: 'PollingLimitReached', stage };
          }
          await this.#dependencies.wait(observationIntervalMilliseconds);
          continue;
        }
        case 'ServerAdmitted': {
          if (mandateKind === 'PromotionMandate') {
            return { kind: 'ProtocolEvidenceInvalid', stage };
          }
          const retained = await this.#retain(authorization, {
            kind: 'PreparePromotionIssuance',
            issuedAt: this.#dependencies.now(),
          });
          if (retained.kind === 'Rejected') {
            return { kind: 'ProtocolRejected', stage, reason: retained.reason };
          }
          authorization = retained.authorization;
          continue;
        }
      }
    }
  }

  async #retain(
    current: TaskAuthorization,
    advancement: TaskAuthorizationAdvancement,
  ): Promise<AuthorizationRetention> {
    const transition = advanceTaskAuthorization(current, advancement);
    if (transition.kind === 'Rejected') {
      return transition;
    }
    await this.#dependencies.records.commit(current.revision, transition.authorization);
    return { kind: 'Retained', authorization: transition.authorization };
  }

  async #verifyInspection(
    input: TaskMandateAuthorizationInput,
    authorization: TaskAuthorization,
    mandateKind: MandateKind,
    inspection: MandateInspection,
  ): Promise<InspectionVerification> {
    const task = mandateTask(input.task);
    const observedAt = new Date(this.#dependencies.now()).toISOString();
    if (mandateKind === 'TaskMandate') {
      if (inspection.kind !== 'TaskMandate') {
        return { kind: 'Invalid', invalidity: { kind: 'MandateKindMismatch' } };
      }
      const verified = verifyTaskMandate(
        {
          credential: {
            issuerAid: input.governance.userAid,
            issueeAid: input.governance.personalAgentAid,
            registryId: input.governance.mandateRegistryId,
            schemaSaid:
              input.task.revision.version === 2
                ? input.task.revision.budgets.runsPerAdmittedUser >
                  taskBudgetCeilings.runsPerAdmittedUser
                  ? taskMandateV3SchemaSaid
                  : taskMandateV2SchemaSaid
                : taskMandateSchemaSaid,
            credentialSaid: inspection.value.credential.credentialSaid,
          },
          task,
          observedAt,
        },
        inspection.value,
      );
      return verified.kind === 'Current'
        ? { kind: 'Verified', taskMandate: verified.mandate }
        : { kind: 'Invalid', invalidity: verified.invalidity };
    }
    if (inspection.kind !== 'PromotionMandate') {
      return { kind: 'Invalid', invalidity: { kind: 'MandateKindMismatch' } };
    }
    const taskMandateReference = admittedTaskMandate(authorization);
    if (taskMandateReference === undefined) {
      return { kind: 'Invalid', invalidity: { kind: 'MandateKindMismatch' } };
    }
    const taskInspection = await this.#dependencies.custody.inspectCredential({
      credentialSaid: credentialSaid(taskMandateReference.credential.credentialSaid),
    });
    if (taskInspection.kind !== 'TaskMandate') {
      return { kind: 'Invalid', invalidity: { kind: 'MandateKindMismatch' } };
    }
    const currentTask = verifyTaskMandate(
      {
        credential: {
          issuerAid: input.governance.userAid,
          issueeAid: input.governance.personalAgentAid,
          registryId: input.governance.mandateRegistryId,
          schemaSaid:
            input.task.revision.version === 2
              ? input.task.revision.budgets.runsPerAdmittedUser >
                taskBudgetCeilings.runsPerAdmittedUser
                ? taskMandateV3SchemaSaid
                : taskMandateV2SchemaSaid
              : taskMandateSchemaSaid,
          credentialSaid: taskMandateReference.credential.credentialSaid,
        },
        task,
        observedAt,
      },
      taskInspection.value,
    );
    if (currentTask.kind === 'Invalid') {
      return { kind: 'Invalid', invalidity: currentTask.invalidity };
    }
    const expectation = {
      credential: {
        issuerAid: input.governance.userAid,
        issueeAid: input.governance.governorAid,
        registryId: input.governance.mandateRegistryId,
        schemaSaid:
          input.exactPromotionManifestSaid !== undefined
            ? input.task.revision.budgets.runsPerAdmittedUser >
              taskBudgetCeilings.runsPerAdmittedUser
              ? promotionMandateV5SchemaSaid
              : promotionMandateV3SchemaSaid
            : input.task.revision.version === 2
              ? input.task.revision.budgets.runsPerAdmittedUser >
                taskBudgetCeilings.runsPerAdmittedUser
                ? promotionMandateV4SchemaSaid
                : promotionMandateV2SchemaSaid
              : promotionMandateSchemaSaid,
        credentialSaid: inspection.value.credential.credentialSaid,
      },
      task,
      taskMandate: currentTask.mandate,
      observedAt,
    };
    const verified =
      input.exactPromotionManifestSaid === undefined
        ? verifyPromotionMandate(expectation, inspection.value)
        : hasExactClaims(inspection.value)
          ? verifyExactPromotionMandate(
              { ...expectation, evaluationManifestSaid: input.exactPromotionManifestSaid },
              inspection.value,
            )
          : {
              kind: 'Invalid' as const,
              invalidity: { kind: 'EvaluationManifestMismatch' as const },
            };
    return verified.kind === 'Current'
      ? { kind: 'Verified' }
      : { kind: 'Invalid', invalidity: verified.invalidity };
  }
}

function binding(input: TaskMandateAuthorizationInput): TaskAuthorizationBinding {
  return {
    ownerAid: input.governance.userAid,
    taskId: input.task.taskId,
    taskRevisionSaid: input.task.revisionSaid,
    harnessLineageId: input.task.harnessLineageId,
    personalAgentAid: input.governance.personalAgentAid,
    governorAid: input.governance.governorAid,
    issuerAid: input.issuerAid,
    mandateRegistryId: input.governance.mandateRegistryId,
  };
}

function sameBinding(left: TaskAuthorizationBinding, right: TaskAuthorizationBinding): boolean {
  return (
    left.ownerAid === right.ownerAid &&
    left.taskId === right.taskId &&
    left.taskRevisionSaid === right.taskRevisionSaid &&
    left.harnessLineageId === right.harnessLineageId &&
    left.personalAgentAid === right.personalAgentAid &&
    left.governorAid === right.governorAid &&
    left.issuerAid === right.issuerAid &&
    left.mandateRegistryId === right.mandateRegistryId
  );
}

function mandateTask(task: TaskProjection): MandateTask {
  return {
    taskId: task.taskId,
    ownerAid: task.ownerAid,
    revisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    repository: task.revision.repository,
    requestedCapabilities: task.revision.requestedCapabilities,
    unavailableCapabilities: task.revision.unavailableCapabilities,
    budgets: task.revision.budgets,
    evolutionClasses: task.revision.evolutionClasses,
    expiresAt: task.revision.expiresAt,
    ...(task.revision.version === 2 ? { experience: task.revision.constraints.experience } : {}),
  };
}

function mandateIssuancePlan(
  input: TaskMandateAuthorizationInput,
  mandateKind: MandateKind,
  issuedAt: number,
): MandateIssuancePlan<StableMandateIssuance> {
  const planInput = {
    userAlias: input.userAlias,
    governance: input.governance,
    task: input.task,
    issuedAt,
  };
  return mandateKind === 'TaskMandate'
    ? prepareTaskMandateIssuance(planInput)
    : input.exactPromotionManifestSaid === undefined
      ? preparePromotionMandateIssuance(planInput)
      : prepareExactPromotionMandateIssuance({
          ...planInput,
          evaluationManifestSaid: input.exactPromotionManifestSaid,
        });
}

function protocolIssuedAt(progress: MandateProtocolProgress): number {
  switch (progress.kind) {
    case 'IssuancePrepared':
    case 'IssuanceSubmitted':
      return progress.issuedAt;
    case 'CredentialMaterialized':
    case 'HolderGrantPreparing':
    case 'HolderGrantPrepared':
    case 'HolderGrantSubmitted':
    case 'HolderGrantMaterialized':
    case 'HolderAdmissionPreparing':
    case 'HolderAdmissionAwaitingMaterialization':
    case 'HolderVerified':
    case 'ServerGrantPreparing':
    case 'ServerGrantPrepared':
    case 'ServerGrantSubmitted':
    case 'ServerGrantMaterialized':
    case 'ServerPresentationAwaitingGrant':
    case 'ServerPresentationAdmitting':
    case 'ServerAdmitted':
      return progress.credential.issuedAt;
  }
}

function credentialHasMaterialized(
  progress: MandateProtocolProgress,
): progress is Exclude<
  MandateProtocolProgress,
  { readonly kind: 'IssuancePrepared' | 'IssuanceSubmitted' }
> {
  return progress.kind !== 'IssuancePrepared' && progress.kind !== 'IssuanceSubmitted';
}

function progressStage(
  mandateKind: MandateKind,
  progress: MandateProtocolProgress,
): MandateProgressStage {
  return `${mandateKind}.${progress.kind}`;
}

function holderGrant(
  input: TaskMandateAuthorizationInput,
  issuance: StableMandateIssuance,
  progress: Extract<
    MandateProtocolProgress,
    { readonly kind: 'HolderGrantPreparing' | 'HolderGrantPrepared' | 'HolderGrantSubmitted' }
  >,
): StableMandateGrant {
  return {
    senderAlias: input.userAlias,
    exchangeSenderAid: input.governance.userAid,
    exchangeRecipientAid: issuance.holderAid,
    credentialIssuerAid: input.governance.userAid,
    credentialIssueeAid: issuance.holderAid,
    credentialSaid: credentialSaid(progress.credential.credentialSaid),
    preparedAt: progress.preparedAt,
  };
}

function holderAdmission(
  input: TaskMandateAuthorizationInput,
  issuance: StableMandateIssuance,
  progress: Extract<
    MandateProtocolProgress,
    { readonly kind: 'HolderAdmissionPreparing' | 'HolderAdmissionAwaitingMaterialization' }
  >,
): MandateHolderAdmissionInput {
  const preparedAt =
    progress.kind === 'HolderAdmissionPreparing'
      ? progress.preparedAt
      : progress.holderAdmission.preparedAt;
  return {
    holderAlias: issuance.kind === 'TaskMandate' ? PERSONAL_AGENT_ALIAS : GOVERNOR_ALIAS,
    holderAid: issuance.holderAid,
    userAid: input.governance.userAid,
    credentialSaid: credentialSaid(progress.credential.credentialSaid),
    registryId: input.governance.mandateRegistryId,
    grantSaid: ipexGrantSaid(progress.holderGrant.grantSaid),
    mandateKind: issuance.kind,
    preparedAt,
  };
}

function serverGrant(
  input: TaskMandateAuthorizationInput,
  issuance: StableMandateIssuance,
  progress: Extract<
    MandateProtocolProgress,
    { readonly kind: 'ServerGrantPreparing' | 'ServerGrantPrepared' | 'ServerGrantSubmitted' }
  >,
): StableMandateGrant {
  return {
    senderAlias: issuance.kind === 'TaskMandate' ? PERSONAL_AGENT_ALIAS : GOVERNOR_ALIAS,
    exchangeSenderAid: issuance.holderAid,
    exchangeRecipientAid: input.issuerAid,
    credentialIssuerAid: input.governance.userAid,
    credentialIssueeAid: issuance.holderAid,
    credentialSaid: credentialSaid(progress.credential.credentialSaid),
    preparedAt: progress.preparedAt,
  };
}

function admittedTaskMandate(authorization: TaskAuthorization) {
  switch (authorization.stage.kind) {
    case 'TaskMandate':
      return authorization.stage.progress.kind === 'ServerAdmitted'
        ? authorization.stage.progress
        : undefined;
    case 'PromotionMandate':
    case 'Ready':
      return authorization.stage.taskMandate;
  }
}
