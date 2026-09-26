import type {
  CredentialRegistryId,
  GovernorAid,
  IssuerAid,
  PersonalAgentAid,
  UserAid,
} from '@devrandom/identity';

export interface TaskAuthorizationBinding {
  readonly ownerAid: UserAid;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly personalAgentAid: PersonalAgentAid;
  readonly governorAid: GovernorAid;
  readonly issuerAid: IssuerAid;
  readonly mandateRegistryId: CredentialRegistryId;
}

export type ProtocolSubmission =
  | { readonly kind: 'OperationRecorded'; readonly operationName: string }
  | { readonly kind: 'RecoveredWithoutOperation' };

export interface MaterializedMandateCredential {
  readonly issuedAt: number;
  readonly credentialSaid: string;
  readonly issuance: ProtocolSubmission;
}

export interface MaterializedMandateGrant {
  readonly preparedAt: number;
  readonly grantSaid: string;
  readonly submission: ProtocolSubmission;
}

export interface VerifiedHolderAdmission {
  readonly preparedAt: number;
  readonly admitSaid: string;
  readonly submission: ProtocolSubmission;
}

interface IssuancePrepared {
  readonly kind: 'IssuancePrepared';
  readonly issuedAt: number;
}

interface IssuanceSubmitted {
  readonly kind: 'IssuanceSubmitted';
  readonly issuedAt: number;
  readonly credentialSaid: string;
  readonly operationName: string;
}

interface CredentialMaterialized {
  readonly kind: 'CredentialMaterialized';
  readonly credential: MaterializedMandateCredential;
}

interface HolderGrantPreparing {
  readonly kind: 'HolderGrantPreparing';
  readonly credential: MaterializedMandateCredential;
  readonly preparedAt: number;
}

interface HolderGrantPrepared {
  readonly kind: 'HolderGrantPrepared';
  readonly credential: MaterializedMandateCredential;
  readonly preparedAt: number;
  readonly grantSaid: string;
}

interface HolderGrantSubmitted {
  readonly kind: 'HolderGrantSubmitted';
  readonly credential: MaterializedMandateCredential;
  readonly preparedAt: number;
  readonly grantSaid: string;
  readonly operationName: string;
}

interface HolderGrantMaterialized {
  readonly kind: 'HolderGrantMaterialized';
  readonly credential: MaterializedMandateCredential;
  readonly holderGrant: MaterializedMandateGrant;
}

interface HolderAdmissionPreparing {
  readonly kind: 'HolderAdmissionPreparing';
  readonly credential: MaterializedMandateCredential;
  readonly holderGrant: MaterializedMandateGrant;
  readonly preparedAt: number;
}

interface HolderAdmissionAwaitingMaterialization {
  readonly kind: 'HolderAdmissionAwaitingMaterialization';
  readonly credential: MaterializedMandateCredential;
  readonly holderGrant: MaterializedMandateGrant;
  readonly holderAdmission: VerifiedHolderAdmission;
}

interface HolderVerified {
  readonly kind: 'HolderVerified';
  readonly credential: MaterializedMandateCredential;
  readonly holderGrant: MaterializedMandateGrant;
  readonly holderAdmission: VerifiedHolderAdmission;
}

interface ServerGrantPreparing {
  readonly kind: 'ServerGrantPreparing';
  readonly credential: MaterializedMandateCredential;
  readonly holderGrant: MaterializedMandateGrant;
  readonly holderAdmission: VerifiedHolderAdmission;
  readonly preparedAt: number;
}

interface ServerGrantPrepared {
  readonly kind: 'ServerGrantPrepared';
  readonly credential: MaterializedMandateCredential;
  readonly holderGrant: MaterializedMandateGrant;
  readonly holderAdmission: VerifiedHolderAdmission;
  readonly preparedAt: number;
  readonly grantSaid: string;
}

interface ServerGrantSubmitted {
  readonly kind: 'ServerGrantSubmitted';
  readonly credential: MaterializedMandateCredential;
  readonly holderGrant: MaterializedMandateGrant;
  readonly holderAdmission: VerifiedHolderAdmission;
  readonly preparedAt: number;
  readonly grantSaid: string;
  readonly operationName: string;
}

interface ServerGrantMaterialized {
  readonly kind: 'ServerGrantMaterialized';
  readonly credential: MaterializedMandateCredential;
  readonly holderGrant: MaterializedMandateGrant;
  readonly holderAdmission: VerifiedHolderAdmission;
  readonly serverGrant: MaterializedMandateGrant;
}

interface ServerPresentationAwaitingGrant {
  readonly kind: 'ServerPresentationAwaitingGrant';
  readonly credential: MaterializedMandateCredential;
  readonly holderGrant: MaterializedMandateGrant;
  readonly holderAdmission: VerifiedHolderAdmission;
  readonly serverGrant: MaterializedMandateGrant;
  readonly presentationExpiresAt: string;
}

interface ServerPresentationAdmitting {
  readonly kind: 'ServerPresentationAdmitting';
  readonly credential: MaterializedMandateCredential;
  readonly holderGrant: MaterializedMandateGrant;
  readonly holderAdmission: VerifiedHolderAdmission;
  readonly serverGrant: MaterializedMandateGrant;
  readonly presentationExpiresAt: string;
  readonly operationName: string;
}

export interface ServerAdmittedMandate {
  readonly kind: 'ServerAdmitted';
  readonly credential: MaterializedMandateCredential;
  readonly holderGrant: MaterializedMandateGrant;
  readonly holderAdmission: VerifiedHolderAdmission;
  readonly serverGrant: MaterializedMandateGrant;
  readonly presentationExpiresAt: string;
  readonly admittedAt: string;
  readonly admission: ProtocolSubmission;
}

export type MandateProtocolProgress =
  | IssuancePrepared
  | IssuanceSubmitted
  | CredentialMaterialized
  | HolderGrantPreparing
  | HolderGrantPrepared
  | HolderGrantSubmitted
  | HolderGrantMaterialized
  | HolderAdmissionPreparing
  | HolderAdmissionAwaitingMaterialization
  | HolderVerified
  | ServerGrantPreparing
  | ServerGrantPrepared
  | ServerGrantSubmitted
  | ServerGrantMaterialized
  | ServerPresentationAwaitingGrant
  | ServerPresentationAdmitting
  | ServerAdmittedMandate;

export interface AdmittedMandate {
  readonly kind: 'TaskMandate' | 'PromotionMandate';
  readonly credential: MaterializedMandateCredential;
  readonly holderGrant: MaterializedMandateGrant;
  readonly holderAdmission: VerifiedHolderAdmission;
  readonly serverGrant: MaterializedMandateGrant;
  readonly presentationExpiresAt: string;
  readonly admittedAt: string;
  readonly admission: ProtocolSubmission;
}

export type TaskAuthorizationStage =
  | { readonly kind: 'TaskMandate'; readonly progress: MandateProtocolProgress }
  | {
      readonly kind: 'PromotionMandate';
      readonly taskMandate: AdmittedMandate & { readonly kind: 'TaskMandate' };
      readonly progress: MandateProtocolProgress;
    }
  | {
      readonly kind: 'Ready';
      readonly taskMandate: AdmittedMandate & { readonly kind: 'TaskMandate' };
      readonly promotionMandate: AdmittedMandate & { readonly kind: 'PromotionMandate' };
    };

export interface TaskAuthorization {
  readonly version: 1;
  readonly revision: number;
  readonly binding: TaskAuthorizationBinding;
  readonly stage: TaskAuthorizationStage;
}

export type ReadyTaskAuthorization = Omit<TaskAuthorization, 'stage'> & {
  readonly stage: Extract<TaskAuthorizationStage, { readonly kind: 'Ready' }>;
};

export type TaskAuthorizationAdvancement =
  | {
      readonly kind: 'CredentialIssuanceSubmitted';
      readonly credentialSaid: string;
      readonly operationName: string;
    }
  | { readonly kind: 'CredentialMaterialized'; readonly credentialSaid: string }
  | { readonly kind: 'PrepareHolderGrant'; readonly preparedAt: number }
  | { readonly kind: 'HolderGrantPrepared'; readonly grantSaid: string }
  | { readonly kind: 'HolderGrantSubmitted'; readonly operationName: string }
  | { readonly kind: 'HolderGrantMaterialized' }
  | { readonly kind: 'PrepareHolderAdmission'; readonly preparedAt: number }
  | {
      readonly kind: 'HolderAdmissionSubmitted';
      readonly admitSaid: string;
      readonly operationName: string;
    }
  | { readonly kind: 'HolderAdmissionRecovered'; readonly admitSaid: string }
  | { readonly kind: 'HolderVerified' }
  | { readonly kind: 'PrepareServerGrant'; readonly preparedAt: number }
  | { readonly kind: 'ServerGrantPrepared'; readonly grantSaid: string }
  | { readonly kind: 'ServerGrantSubmitted'; readonly operationName: string }
  | { readonly kind: 'ServerGrantMaterialized' }
  | {
      readonly kind: 'ServerPresentationAwaitingGrant';
      readonly presentationExpiresAt: string;
    }
  | {
      readonly kind: 'ServerPresentationAdmitting';
      readonly presentationExpiresAt: string;
      readonly operationName: string;
    }
  | {
      readonly kind: 'ServerAdmitted';
      readonly presentationExpiresAt: string;
      readonly admittedAt: string;
    }
  | { readonly kind: 'PreparePromotionIssuance'; readonly issuedAt: number };

export type TaskAuthorizationRejection =
  'BindingInvalid' | 'TimestampInvalid' | 'ProtocolIdentityChanged' | 'UnexpectedStage';

export type TaskAuthorizationBeginning =
  | { readonly kind: 'Begun'; readonly authorization: TaskAuthorization }
  | { readonly kind: 'Rejected'; readonly reason: 'BindingInvalid' | 'TimestampInvalid' };

export type TaskAuthorizationTransition =
  | { readonly kind: 'Advanced'; readonly authorization: TaskAuthorization }
  | { readonly kind: 'Rejected'; readonly reason: TaskAuthorizationRejection };

type ProtocolTransition =
  | { readonly kind: 'Advanced'; readonly progress: MandateProtocolProgress }
  | { readonly kind: 'Rejected'; readonly reason: TaskAuthorizationRejection };

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const keriIdentifier = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function beginTaskAuthorization(
  binding: TaskAuthorizationBinding,
  taskMandateIssuedAt: number,
): TaskAuthorizationBeginning {
  if (!validBinding(binding)) {
    return { kind: 'Rejected', reason: 'BindingInvalid' };
  }
  if (!validEpochMilliseconds(taskMandateIssuedAt)) {
    return { kind: 'Rejected', reason: 'TimestampInvalid' };
  }
  return {
    kind: 'Begun',
    authorization: {
      version: 1,
      revision: 0,
      binding,
      stage: {
        kind: 'TaskMandate',
        progress: { kind: 'IssuancePrepared', issuedAt: taskMandateIssuedAt },
      },
    },
  };
}

export function advanceTaskAuthorization(
  current: TaskAuthorization,
  advancement: TaskAuthorizationAdvancement,
): TaskAuthorizationTransition {
  if (!validBinding(current.binding)) {
    return { kind: 'Rejected', reason: 'BindingInvalid' };
  }
  if (current.stage.kind === 'Ready') {
    return { kind: 'Rejected', reason: 'UnexpectedStage' };
  }
  if (advancement.kind === 'PreparePromotionIssuance') {
    if (current.stage.kind !== 'TaskMandate' || current.stage.progress.kind !== 'ServerAdmitted') {
      return { kind: 'Rejected', reason: 'UnexpectedStage' };
    }
    if (
      !validEpochMilliseconds(advancement.issuedAt) ||
      advancement.issuedAt < current.stage.progress.credential.issuedAt
    ) {
      return { kind: 'Rejected', reason: 'TimestampInvalid' };
    }
    return advanced(current, {
      kind: 'PromotionMandate',
      taskMandate: admittedMandate('TaskMandate', current.stage.progress),
      progress: { kind: 'IssuancePrepared', issuedAt: advancement.issuedAt },
    });
  }

  const transition = advanceProtocol(current.stage.progress, advancement);
  if (transition.kind === 'Rejected') {
    return transition;
  }
  if (current.stage.kind === 'PromotionMandate' && transition.progress.kind === 'ServerAdmitted') {
    return advanced(current, {
      kind: 'Ready',
      taskMandate: current.stage.taskMandate,
      promotionMandate: admittedMandate('PromotionMandate', transition.progress),
    });
  }
  return advanced(
    current,
    current.stage.kind === 'TaskMandate'
      ? { kind: 'TaskMandate', progress: transition.progress }
      : {
          kind: 'PromotionMandate',
          taskMandate: current.stage.taskMandate,
          progress: transition.progress,
        },
  );
}

function advanceProtocol(
  progress: MandateProtocolProgress,
  advancement: Exclude<TaskAuthorizationAdvancement, { readonly kind: 'PreparePromotionIssuance' }>,
): ProtocolTransition {
  switch (advancement.kind) {
    case 'CredentialIssuanceSubmitted':
      if (progress.kind !== 'IssuancePrepared') {
        return unexpectedStage();
      }
      if (!validSaid(advancement.credentialSaid) || !validOperation(advancement.operationName)) {
        return protocolIdentityChanged();
      }
      return progressed({
        kind: 'IssuanceSubmitted',
        issuedAt: progress.issuedAt,
        credentialSaid: advancement.credentialSaid,
        operationName: advancement.operationName,
      });
    case 'CredentialMaterialized': {
      if (!validSaid(advancement.credentialSaid)) {
        return protocolIdentityChanged();
      }
      if (progress.kind === 'IssuancePrepared') {
        return progressed({
          kind: 'CredentialMaterialized',
          credential: {
            issuedAt: progress.issuedAt,
            credentialSaid: advancement.credentialSaid,
            issuance: { kind: 'RecoveredWithoutOperation' },
          },
        });
      }
      if (progress.kind !== 'IssuanceSubmitted') {
        return unexpectedStage();
      }
      if (advancement.credentialSaid !== progress.credentialSaid) {
        return protocolIdentityChanged();
      }
      return progressed({
        kind: 'CredentialMaterialized',
        credential: {
          issuedAt: progress.issuedAt,
          credentialSaid: progress.credentialSaid,
          issuance: { kind: 'OperationRecorded', operationName: progress.operationName },
        },
      });
    }
    case 'PrepareHolderGrant':
      if (progress.kind !== 'CredentialMaterialized') {
        return unexpectedStage();
      }
      if (!validPreparedAt(advancement.preparedAt, progress.credential.issuedAt)) {
        return timestampInvalid();
      }
      return progressed({
        kind: 'HolderGrantPreparing',
        credential: progress.credential,
        preparedAt: advancement.preparedAt,
      });
    case 'HolderGrantPrepared':
      if (progress.kind !== 'HolderGrantPreparing') {
        return unexpectedStage();
      }
      if (!validSaid(advancement.grantSaid)) {
        return protocolIdentityChanged();
      }
      return progressed({
        kind: 'HolderGrantPrepared',
        credential: progress.credential,
        preparedAt: progress.preparedAt,
        grantSaid: advancement.grantSaid,
      });
    case 'HolderGrantSubmitted':
      if (progress.kind !== 'HolderGrantPrepared') {
        return unexpectedStage();
      }
      if (!validOperation(advancement.operationName)) {
        return protocolIdentityChanged();
      }
      return progressed({
        ...progress,
        kind: 'HolderGrantSubmitted',
        operationName: advancement.operationName,
      });
    case 'HolderGrantMaterialized':
      if (progress.kind === 'HolderGrantPrepared') {
        return progressed({
          kind: 'HolderGrantMaterialized',
          credential: progress.credential,
          holderGrant: {
            preparedAt: progress.preparedAt,
            grantSaid: progress.grantSaid,
            submission: { kind: 'RecoveredWithoutOperation' },
          },
        });
      }
      if (progress.kind !== 'HolderGrantSubmitted') {
        return unexpectedStage();
      }
      return progressed({
        kind: 'HolderGrantMaterialized',
        credential: progress.credential,
        holderGrant: {
          preparedAt: progress.preparedAt,
          grantSaid: progress.grantSaid,
          submission: { kind: 'OperationRecorded', operationName: progress.operationName },
        },
      });
    case 'PrepareHolderAdmission':
      if (progress.kind !== 'HolderGrantMaterialized') {
        return unexpectedStage();
      }
      if (!validPreparedAt(advancement.preparedAt, progress.holderGrant.preparedAt)) {
        return timestampInvalid();
      }
      return progressed({
        kind: 'HolderAdmissionPreparing',
        credential: progress.credential,
        holderGrant: progress.holderGrant,
        preparedAt: advancement.preparedAt,
      });
    case 'HolderAdmissionSubmitted':
      if (progress.kind !== 'HolderAdmissionPreparing') {
        return unexpectedStage();
      }
      if (!validSaid(advancement.admitSaid) || !validOperation(advancement.operationName)) {
        return protocolIdentityChanged();
      }
      return progressed({
        kind: 'HolderAdmissionAwaitingMaterialization',
        credential: progress.credential,
        holderGrant: progress.holderGrant,
        holderAdmission: {
          preparedAt: progress.preparedAt,
          admitSaid: advancement.admitSaid,
          submission: { kind: 'OperationRecorded', operationName: advancement.operationName },
        },
      });
    case 'HolderAdmissionRecovered':
      if (progress.kind !== 'HolderAdmissionPreparing') {
        return unexpectedStage();
      }
      if (!validSaid(advancement.admitSaid)) {
        return protocolIdentityChanged();
      }
      return progressed({
        kind: 'HolderAdmissionAwaitingMaterialization',
        credential: progress.credential,
        holderGrant: progress.holderGrant,
        holderAdmission: {
          preparedAt: progress.preparedAt,
          admitSaid: advancement.admitSaid,
          submission: { kind: 'RecoveredWithoutOperation' },
        },
      });
    case 'HolderVerified':
      if (progress.kind !== 'HolderAdmissionAwaitingMaterialization') {
        return unexpectedStage();
      }
      return progressed({ ...progress, kind: 'HolderVerified' });
    case 'PrepareServerGrant':
      if (progress.kind !== 'HolderVerified') {
        return unexpectedStage();
      }
      if (!validPreparedAt(advancement.preparedAt, progress.holderAdmission.preparedAt)) {
        return timestampInvalid();
      }
      return progressed({
        kind: 'ServerGrantPreparing',
        credential: progress.credential,
        holderGrant: progress.holderGrant,
        holderAdmission: progress.holderAdmission,
        preparedAt: advancement.preparedAt,
      });
    case 'ServerGrantPrepared':
      if (progress.kind !== 'ServerGrantPreparing') {
        return unexpectedStage();
      }
      if (!validSaid(advancement.grantSaid)) {
        return protocolIdentityChanged();
      }
      return progressed({
        kind: 'ServerGrantPrepared',
        credential: progress.credential,
        holderGrant: progress.holderGrant,
        holderAdmission: progress.holderAdmission,
        preparedAt: progress.preparedAt,
        grantSaid: advancement.grantSaid,
      });
    case 'ServerGrantSubmitted':
      if (progress.kind !== 'ServerGrantPrepared') {
        return unexpectedStage();
      }
      if (!validOperation(advancement.operationName)) {
        return protocolIdentityChanged();
      }
      return progressed({
        ...progress,
        kind: 'ServerGrantSubmitted',
        operationName: advancement.operationName,
      });
    case 'ServerGrantMaterialized':
      if (progress.kind === 'ServerGrantPrepared') {
        return progressed({
          kind: 'ServerGrantMaterialized',
          credential: progress.credential,
          holderGrant: progress.holderGrant,
          holderAdmission: progress.holderAdmission,
          serverGrant: {
            preparedAt: progress.preparedAt,
            grantSaid: progress.grantSaid,
            submission: { kind: 'RecoveredWithoutOperation' },
          },
        });
      }
      if (progress.kind !== 'ServerGrantSubmitted') {
        return unexpectedStage();
      }
      return progressed({
        kind: 'ServerGrantMaterialized',
        credential: progress.credential,
        holderGrant: progress.holderGrant,
        holderAdmission: progress.holderAdmission,
        serverGrant: {
          preparedAt: progress.preparedAt,
          grantSaid: progress.grantSaid,
          submission: { kind: 'OperationRecorded', operationName: progress.operationName },
        },
      });
    case 'ServerPresentationAwaitingGrant':
      if (progress.kind !== 'ServerGrantMaterialized') {
        return unexpectedStage();
      }
      if (!validTimestamp(advancement.presentationExpiresAt)) {
        return timestampInvalid();
      }
      return progressed({
        ...progress,
        kind: 'ServerPresentationAwaitingGrant',
        presentationExpiresAt: advancement.presentationExpiresAt,
      });
    case 'ServerPresentationAdmitting':
      if (
        progress.kind !== 'ServerGrantMaterialized' &&
        progress.kind !== 'ServerPresentationAwaitingGrant'
      ) {
        return unexpectedStage();
      }
      if (
        !validTimestamp(advancement.presentationExpiresAt) ||
        !validOperation(advancement.operationName)
      ) {
        return timestampInvalid();
      }
      if (
        progress.kind === 'ServerPresentationAwaitingGrant' &&
        advancement.presentationExpiresAt !== progress.presentationExpiresAt
      ) {
        return protocolIdentityChanged();
      }
      return progressed({
        ...progress,
        kind: 'ServerPresentationAdmitting',
        presentationExpiresAt: advancement.presentationExpiresAt,
        operationName: advancement.operationName,
      });
    case 'ServerAdmitted':
      if (
        progress.kind !== 'ServerGrantMaterialized' &&
        progress.kind !== 'ServerPresentationAwaitingGrant' &&
        progress.kind !== 'ServerPresentationAdmitting'
      ) {
        return unexpectedStage();
      }
      if (
        !validTimestamp(advancement.presentationExpiresAt) ||
        !validTimestamp(advancement.admittedAt) ||
        Date.parse(advancement.admittedAt) >= Date.parse(advancement.presentationExpiresAt)
      ) {
        return timestampInvalid();
      }
      if (
        progress.kind !== 'ServerGrantMaterialized' &&
        advancement.presentationExpiresAt !== progress.presentationExpiresAt
      ) {
        return protocolIdentityChanged();
      }
      return progressed({
        kind: 'ServerAdmitted',
        credential: progress.credential,
        holderGrant: progress.holderGrant,
        holderAdmission: progress.holderAdmission,
        serverGrant: progress.serverGrant,
        presentationExpiresAt: advancement.presentationExpiresAt,
        admittedAt: advancement.admittedAt,
        admission:
          progress.kind === 'ServerPresentationAdmitting'
            ? { kind: 'OperationRecorded', operationName: progress.operationName }
            : { kind: 'RecoveredWithoutOperation' },
      });
  }
}

function admittedMandate<Kind extends AdmittedMandate['kind']>(
  kind: Kind,
  progress: ServerAdmittedMandate,
): AdmittedMandate & { readonly kind: Kind } {
  return {
    kind,
    credential: progress.credential,
    holderGrant: progress.holderGrant,
    holderAdmission: progress.holderAdmission,
    serverGrant: progress.serverGrant,
    presentationExpiresAt: progress.presentationExpiresAt,
    admittedAt: progress.admittedAt,
    admission: progress.admission,
  };
}

function advanced(
  current: TaskAuthorization,
  stage: TaskAuthorizationStage,
): TaskAuthorizationTransition {
  return {
    kind: 'Advanced',
    authorization: {
      version: 1,
      revision: current.revision + 1,
      binding: current.binding,
      stage,
    },
  };
}

function progressed(progress: MandateProtocolProgress): ProtocolTransition {
  return { kind: 'Advanced', progress };
}

function unexpectedStage(): ProtocolTransition {
  return { kind: 'Rejected', reason: 'UnexpectedStage' };
}

function timestampInvalid(): ProtocolTransition {
  return { kind: 'Rejected', reason: 'TimestampInvalid' };
}

function protocolIdentityChanged(): ProtocolTransition {
  return { kind: 'Rejected', reason: 'ProtocolIdentityChanged' };
}

function validBinding(binding: TaskAuthorizationBinding): boolean {
  return (
    uuidV4.test(binding.taskId) &&
    uuidV4.test(binding.harnessLineageId) &&
    validSaid(binding.taskRevisionSaid) &&
    validSaid(binding.ownerAid) &&
    validSaid(binding.personalAgentAid) &&
    validSaid(binding.governorAid) &&
    validSaid(binding.issuerAid) &&
    validSaid(binding.mandateRegistryId) &&
    new Set([binding.ownerAid, binding.personalAgentAid, binding.governorAid]).size === 3
  );
}

function validEpochMilliseconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validPreparedAt(value: number, earliest: number): boolean {
  return validEpochMilliseconds(value) && value >= earliest;
}

function validSaid(value: string): boolean {
  return keriIdentifier.test(value);
}

function validOperation(value: string): boolean {
  return value.length > 0 && value.length <= 512;
}

function validTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return (
    timestamp.test(value) && Number.isFinite(parsed) && new Date(parsed).toISOString() === value
  );
}
