import {
  taskBudgetNames,
  type TaskBudgetName,
  type TaskBudgets,
  type TaskEvolutionClass,
  type TaskToolCapability,
} from '../task/authority.js';

export const promotionEvidenceClasses: readonly [
  'Diagnosis',
  'FalsifiableHypothesis',
  'ImmutableCandidate',
  'RepeatedPairedEvaluation',
  'LockedHoldout',
  'SafetyAndAuthorityFloors',
  'TamperAudit',
  'WinnerSelection',
] = Object.freeze([
  'Diagnosis',
  'FalsifiableHypothesis',
  'ImmutableCandidate',
  'RepeatedPairedEvaluation',
  'LockedHoldout',
  'SafetyAndAuthorityFloors',
  'TamperAudit',
  'WinnerSelection',
]);

export type PromotionEvidenceClass = (typeof promotionEvidenceClasses)[number];

export type MandateAuthority = 'ExecutePrivateTask' | 'ActivateEvaluatedSuccessor';

export type MandateSaidBinding = { readonly kind: 'Verified' } | { readonly kind: 'Mismatch' };

export type MandateTelState =
  | { readonly kind: 'Issued' }
  | { readonly kind: 'Revoked'; readonly revokedAt: string }
  | { readonly kind: 'NotIssued' }
  | { readonly kind: 'IncompatibleCredentialState' };

export type MandateIssuerAnchor =
  | { readonly kind: 'Anchored'; readonly eventSaid: string }
  | { readonly kind: 'Missing' }
  | { readonly kind: 'Mismatch'; readonly eventSaid: string };

export interface ResolvedMandateSchema {
  readonly kind: 'Resolved';
  readonly schemaSaid: string;
}

export interface MandateCredentialEvidence {
  readonly credentialSaid: string;
  readonly attributeSaid: string;
  readonly issuerAid: string;
  readonly issueeAid: string;
  readonly registryId: string;
  readonly schemaSaid: string;
  readonly issuedAt: string;
  readonly credentialSaidBinding: MandateSaidBinding;
  readonly attributeSaidBinding: MandateSaidBinding;
  readonly schemaDocument: ResolvedMandateSchema;
  readonly telState: MandateTelState;
  readonly issuerAnchor: MandateIssuerAnchor;
}

export interface MandateCredentialExpectation {
  readonly issuerAid: string;
  readonly issueeAid: string;
  readonly registryId: string;
  readonly schemaSaid: string;
  readonly credentialSaid: string;
}

export type MandateRepository =
  | {
      readonly objectFormat: 'sha1';
      readonly commit: string;
      readonly tree: string;
    }
  | {
      readonly objectFormat: 'sha256';
      readonly commit: string;
      readonly tree: string;
    };

export interface MandateTask {
  readonly taskId: string;
  readonly ownerAid: string;
  readonly revisionSaid: string;
  readonly harnessLineageId: string;
  readonly repository: MandateRepository;
  readonly requestedCapabilities: readonly TaskToolCapability[];
  readonly unavailableCapabilities: readonly TaskToolCapability[];
  readonly budgets: TaskBudgets;
  readonly evolutionClasses: readonly TaskEvolutionClass[];
  readonly expiresAt: string;
}

export interface TaskMandateInspection {
  readonly credential: MandateCredentialEvidence;
  readonly authority: MandateAuthority;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly repository: MandateRepository;
  readonly allowedCapabilities: readonly TaskToolCapability[];
  readonly budgets: TaskBudgets;
  readonly allowedEvolutionClasses: readonly TaskEvolutionClass[];
  readonly notBefore: string;
  readonly expiresAt: string;
}

export interface PromotionMandateInspection {
  readonly credential: MandateCredentialEvidence;
  readonly authority: MandateAuthority;
  readonly taskId: string;
  readonly taskRevisionSaid: string;
  readonly harnessLineageId: string;
  readonly capabilityCeiling: readonly TaskToolCapability[];
  readonly budgetCeiling: TaskBudgets;
  readonly evolutionClassCeiling: readonly TaskEvolutionClass[];
  readonly requiredEvidenceClasses: readonly PromotionEvidenceClass[];
  readonly notBefore: string;
  readonly expiresAt: string;
}

const currentTaskMandate = Symbol('CurrentTaskMandate');
const currentPromotionMandate = Symbol('CurrentPromotionMandate');

export interface CurrentTaskMandate extends TaskMandateInspection {
  readonly kind: 'TaskMandate';
  readonly [currentTaskMandate]: typeof currentTaskMandate;
}

export interface CurrentPromotionMandate extends PromotionMandateInspection {
  readonly kind: 'PromotionMandate';
  readonly [currentPromotionMandate]: typeof currentPromotionMandate;
}

export type MandateInvalidity =
  | { readonly kind: 'UnexpectedIssuer'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'UnexpectedIssuee'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'UnexpectedRegistry'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'UnexpectedSchema'; readonly expected: string; readonly actual: string }
  | {
      readonly kind: 'UnexpectedCredentialSaid';
      readonly expected: string;
      readonly actual: string;
    }
  | { readonly kind: 'CredentialSaidMismatch' }
  | { readonly kind: 'AttributeSaidMismatch' }
  | { readonly kind: 'SchemaDocumentMismatch'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'CredentialNotIssued' }
  | { readonly kind: 'CredentialRevoked'; readonly revokedAt: string }
  | { readonly kind: 'IncompatibleCredentialState' }
  | { readonly kind: 'IssuerAnchorMissing' }
  | { readonly kind: 'IssuerAnchorMismatch'; readonly eventSaid: string }
  | { readonly kind: 'IssuanceTimeInvalid' }
  | { readonly kind: 'NotBeforeMismatch' }
  | { readonly kind: 'ExpiryMismatch' }
  | { readonly kind: 'ObservationTimeInvalid' }
  | { readonly kind: 'NotYetValid'; readonly notBefore: string }
  | { readonly kind: 'Expired'; readonly expiresAt: string }
  | { readonly kind: 'UnexpectedTask'; readonly expected: string; readonly actual: string }
  | { readonly kind: 'UnexpectedTaskRevision'; readonly expected: string; readonly actual: string }
  | {
      readonly kind: 'UnexpectedHarnessLineage';
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly kind: 'AuthorityMismatch';
      readonly expected: MandateAuthority;
      readonly actual: MandateAuthority;
    }
  | { readonly kind: 'RepositoryBindingMismatch' }
  | { readonly kind: 'DuplicateCapability'; readonly capability: TaskToolCapability }
  | { readonly kind: 'CapabilityOutsideTask'; readonly capability: TaskToolCapability }
  | { readonly kind: 'BudgetOutsideTask'; readonly budget: TaskBudgetName }
  | { readonly kind: 'BudgetInvalid'; readonly budget: TaskBudgetName }
  | { readonly kind: 'DuplicateEvolutionClass'; readonly evolutionClass: TaskEvolutionClass }
  | { readonly kind: 'EvolutionClassOutsideTask'; readonly evolutionClass: TaskEvolutionClass }
  | {
      readonly kind: 'CapabilityCeilingOutsideTaskMandate';
      readonly capability: TaskToolCapability;
    }
  | { readonly kind: 'BudgetCeilingOutsideTaskMandate'; readonly budget: TaskBudgetName }
  | {
      readonly kind: 'EvolutionClassCeilingOutsideTaskMandate';
      readonly evolutionClass: TaskEvolutionClass;
    }
  | { readonly kind: 'EvidenceRequirementsMismatch' };

export type TaskMandateVerification =
  | { readonly kind: 'Current'; readonly mandate: CurrentTaskMandate }
  | { readonly kind: 'Invalid'; readonly invalidity: MandateInvalidity };

export type PromotionMandateVerification =
  | { readonly kind: 'Current'; readonly mandate: CurrentPromotionMandate }
  | { readonly kind: 'Invalid'; readonly invalidity: MandateInvalidity };

export interface TaskMandateExpectation {
  readonly credential: MandateCredentialExpectation;
  readonly task: MandateTask;
  readonly observedAt: string;
}

export interface PromotionMandateExpectation {
  readonly credential: MandateCredentialExpectation;
  readonly task: MandateTask;
  readonly taskMandate: CurrentTaskMandate;
  readonly observedAt: string;
}

function invalid(invalidity: MandateInvalidity): {
  readonly kind: 'Invalid';
  readonly invalidity: MandateInvalidity;
} {
  return { kind: 'Invalid', invalidity };
}

function issuerOwnerInvalidity(
  task: MandateTask,
  credential: MandateCredentialExpectation,
): MandateInvalidity | undefined {
  return credential.issuerAid === task.ownerAid
    ? undefined
    : {
        kind: 'UnexpectedIssuer',
        expected: task.ownerAid,
        actual: credential.issuerAid,
      };
}

function credentialInvalidity(
  expected: MandateCredentialExpectation,
  actual: MandateCredentialEvidence,
  observedAt: string,
): MandateInvalidity | undefined {
  if (actual.issuerAid !== expected.issuerAid) {
    return { kind: 'UnexpectedIssuer', expected: expected.issuerAid, actual: actual.issuerAid };
  }
  if (actual.issueeAid !== expected.issueeAid) {
    return { kind: 'UnexpectedIssuee', expected: expected.issueeAid, actual: actual.issueeAid };
  }
  if (actual.registryId !== expected.registryId) {
    return { kind: 'UnexpectedRegistry', expected: expected.registryId, actual: actual.registryId };
  }
  if (actual.schemaSaid !== expected.schemaSaid) {
    return { kind: 'UnexpectedSchema', expected: expected.schemaSaid, actual: actual.schemaSaid };
  }
  if (actual.credentialSaid !== expected.credentialSaid) {
    return {
      kind: 'UnexpectedCredentialSaid',
      expected: expected.credentialSaid,
      actual: actual.credentialSaid,
    };
  }
  if (actual.credentialSaidBinding.kind === 'Mismatch') {
    return { kind: 'CredentialSaidMismatch' };
  }
  if (actual.attributeSaidBinding.kind === 'Mismatch') {
    return { kind: 'AttributeSaidMismatch' };
  }
  if (actual.schemaDocument.schemaSaid !== expected.schemaSaid) {
    return {
      kind: 'SchemaDocumentMismatch',
      expected: expected.schemaSaid,
      actual: actual.schemaDocument.schemaSaid,
    };
  }
  switch (actual.telState.kind) {
    case 'Issued':
      break;
    case 'Revoked': {
      const revokedAt = Date.parse(actual.telState.revokedAt);
      if (!Number.isFinite(revokedAt)) {
        return { kind: 'IncompatibleCredentialState' };
      }
      const observation = Date.parse(observedAt);
      if (Number.isFinite(observation) && observation >= revokedAt) {
        return { kind: 'CredentialRevoked', revokedAt: actual.telState.revokedAt };
      }
      break;
    }
    case 'NotIssued':
      return { kind: 'CredentialNotIssued' };
    case 'IncompatibleCredentialState':
      return { kind: 'IncompatibleCredentialState' };
  }
  switch (actual.issuerAnchor.kind) {
    case 'Anchored':
      return undefined;
    case 'Missing':
      return { kind: 'IssuerAnchorMissing' };
    case 'Mismatch':
      return { kind: 'IssuerAnchorMismatch', eventSaid: actual.issuerAnchor.eventSaid };
  }
}

function temporalInvalidity(
  credential: MandateCredentialEvidence,
  notBefore: string,
  expiresAt: string,
  taskDeadline: string,
  observedAt: string,
): MandateInvalidity | undefined {
  const issuedAtMilliseconds = Date.parse(credential.issuedAt);
  const notBeforeMilliseconds = Date.parse(notBefore);
  const expiresAtMilliseconds = Date.parse(expiresAt);
  const taskDeadlineMilliseconds = Date.parse(taskDeadline);
  const observedAtMilliseconds = Date.parse(observedAt);
  if (!Number.isFinite(issuedAtMilliseconds)) {
    return { kind: 'IssuanceTimeInvalid' };
  }
  if (!Number.isFinite(notBeforeMilliseconds) || notBeforeMilliseconds !== issuedAtMilliseconds) {
    return { kind: 'NotBeforeMismatch' };
  }
  const expectedExpiration = Math.min(
    issuedAtMilliseconds + 4 * 60 * 60 * 1_000,
    taskDeadlineMilliseconds,
  );
  if (
    !Number.isFinite(expiresAtMilliseconds) ||
    !Number.isFinite(taskDeadlineMilliseconds) ||
    expiresAtMilliseconds !== expectedExpiration ||
    expiresAtMilliseconds <= notBeforeMilliseconds
  ) {
    return { kind: 'ExpiryMismatch' };
  }
  if (!Number.isFinite(observedAtMilliseconds)) {
    return { kind: 'ObservationTimeInvalid' };
  }
  if (observedAtMilliseconds < notBeforeMilliseconds) {
    return { kind: 'NotYetValid', notBefore };
  }
  if (observedAtMilliseconds >= expiresAtMilliseconds) {
    return { kind: 'Expired', expiresAt };
  }
  return undefined;
}

function resourceInvalidity(
  task: MandateTask,
  actual: {
    readonly taskId: string;
    readonly taskRevisionSaid: string;
    readonly harnessLineageId: string;
  },
): MandateInvalidity | undefined {
  if (actual.taskId !== task.taskId) {
    return { kind: 'UnexpectedTask', expected: task.taskId, actual: actual.taskId };
  }
  if (actual.taskRevisionSaid !== task.revisionSaid) {
    return {
      kind: 'UnexpectedTaskRevision',
      expected: task.revisionSaid,
      actual: actual.taskRevisionSaid,
    };
  }
  if (actual.harnessLineageId !== task.harnessLineageId) {
    return {
      kind: 'UnexpectedHarnessLineage',
      expected: task.harnessLineageId,
      actual: actual.harnessLineageId,
    };
  }
  return undefined;
}

function sameRepository(left: MandateRepository, right: MandateRepository): boolean {
  return (
    left.objectFormat === right.objectFormat &&
    left.commit === right.commit &&
    left.tree === right.tree
  );
}

function firstDuplicate<Value>(values: readonly Value[]): Value | undefined {
  const seen = new Set<Value>();
  for (const value of values) {
    if (seen.has(value)) {
      return value;
    }
    seen.add(value);
  }
  return undefined;
}

function invalidBudget(budgets: TaskBudgets): TaskBudgetName | undefined {
  return taskBudgetNames.find((name) => !Number.isSafeInteger(budgets[name]) || budgets[name] < 0);
}

function budgetAbove(actual: TaskBudgets, ceiling: TaskBudgets): TaskBudgetName | undefined {
  return taskBudgetNames.find((name) => actual[name] > ceiling[name]);
}

function freezeCredential(evidence: MandateCredentialEvidence): MandateCredentialEvidence {
  return Object.freeze({
    ...evidence,
    credentialSaidBinding: Object.freeze({ ...evidence.credentialSaidBinding }),
    attributeSaidBinding: Object.freeze({ ...evidence.attributeSaidBinding }),
    schemaDocument: Object.freeze({ ...evidence.schemaDocument }),
    telState: Object.freeze({ ...evidence.telState }),
    issuerAnchor: Object.freeze({ ...evidence.issuerAnchor }),
  });
}

function freezeBudgets(budgets: TaskBudgets): TaskBudgets {
  return Object.freeze({ ...budgets });
}

export function verifyTaskMandate(
  expected: TaskMandateExpectation,
  inspection: TaskMandateInspection,
): TaskMandateVerification {
  const issuerOwnerFailure = issuerOwnerInvalidity(expected.task, expected.credential);
  if (issuerOwnerFailure !== undefined) {
    return invalid(issuerOwnerFailure);
  }
  const credentialFailure = credentialInvalidity(
    expected.credential,
    inspection.credential,
    expected.observedAt,
  );
  if (credentialFailure !== undefined) {
    return invalid(credentialFailure);
  }
  if (inspection.authority !== 'ExecutePrivateTask') {
    return invalid({
      kind: 'AuthorityMismatch',
      expected: 'ExecutePrivateTask',
      actual: inspection.authority,
    });
  }
  const resourceFailure = resourceInvalidity(expected.task, inspection);
  if (resourceFailure !== undefined) {
    return invalid(resourceFailure);
  }
  if (!sameRepository(inspection.repository, expected.task.repository)) {
    return invalid({ kind: 'RepositoryBindingMismatch' });
  }
  const duplicateCapability = firstDuplicate(inspection.allowedCapabilities);
  if (duplicateCapability !== undefined) {
    return invalid({ kind: 'DuplicateCapability', capability: duplicateCapability });
  }
  const requested = new Set(expected.task.requestedCapabilities);
  const unavailable = new Set(expected.task.unavailableCapabilities);
  const capabilityOutsideTask = inspection.allowedCapabilities.find(
    (capability) => !requested.has(capability) || unavailable.has(capability),
  );
  if (capabilityOutsideTask !== undefined) {
    return invalid({ kind: 'CapabilityOutsideTask', capability: capabilityOutsideTask });
  }
  const malformedBudget = invalidBudget(inspection.budgets);
  if (malformedBudget !== undefined) {
    return invalid({ kind: 'BudgetInvalid', budget: malformedBudget });
  }
  const budgetOutsideTask = budgetAbove(inspection.budgets, expected.task.budgets);
  if (budgetOutsideTask !== undefined) {
    return invalid({ kind: 'BudgetOutsideTask', budget: budgetOutsideTask });
  }
  const duplicateEvolutionClass = firstDuplicate(inspection.allowedEvolutionClasses);
  if (duplicateEvolutionClass !== undefined) {
    return invalid({ kind: 'DuplicateEvolutionClass', evolutionClass: duplicateEvolutionClass });
  }
  const taskEvolution = new Set(expected.task.evolutionClasses);
  const evolutionClassOutsideTask = inspection.allowedEvolutionClasses.find(
    (evolutionClass) => !taskEvolution.has(evolutionClass),
  );
  if (evolutionClassOutsideTask !== undefined) {
    return invalid({
      kind: 'EvolutionClassOutsideTask',
      evolutionClass: evolutionClassOutsideTask,
    });
  }
  const temporalFailure = temporalInvalidity(
    inspection.credential,
    inspection.notBefore,
    inspection.expiresAt,
    expected.task.expiresAt,
    expected.observedAt,
  );
  if (temporalFailure !== undefined) {
    return invalid(temporalFailure);
  }
  const mandate: CurrentTaskMandate = {
    ...inspection,
    credential: freezeCredential(inspection.credential),
    repository: Object.freeze({ ...inspection.repository }),
    allowedCapabilities: Object.freeze([...inspection.allowedCapabilities]),
    budgets: freezeBudgets(inspection.budgets),
    allowedEvolutionClasses: Object.freeze([...inspection.allowedEvolutionClasses]),
    kind: 'TaskMandate',
    [currentTaskMandate]: currentTaskMandate,
  };
  return { kind: 'Current', mandate: Object.freeze(mandate) };
}

function exactEvidenceRequirements(actual: readonly PromotionEvidenceClass[]): boolean {
  return (
    actual.length === promotionEvidenceClasses.length &&
    actual.every((value, index) => value === promotionEvidenceClasses[index])
  );
}

export function verifyPromotionMandate(
  expected: PromotionMandateExpectation,
  inspection: PromotionMandateInspection,
): PromotionMandateVerification {
  const issuerOwnerFailure = issuerOwnerInvalidity(expected.task, expected.credential);
  if (issuerOwnerFailure !== undefined) {
    return invalid(issuerOwnerFailure);
  }
  const taskMandateResourceFailure = resourceInvalidity(expected.task, expected.taskMandate);
  if (taskMandateResourceFailure !== undefined) {
    return invalid(taskMandateResourceFailure);
  }
  const credentialFailure = credentialInvalidity(
    expected.credential,
    inspection.credential,
    expected.observedAt,
  );
  if (credentialFailure !== undefined) {
    return invalid(credentialFailure);
  }
  if (inspection.authority !== 'ActivateEvaluatedSuccessor') {
    return invalid({
      kind: 'AuthorityMismatch',
      expected: 'ActivateEvaluatedSuccessor',
      actual: inspection.authority,
    });
  }
  const resourceFailure = resourceInvalidity(expected.task, inspection);
  if (resourceFailure !== undefined) {
    return invalid(resourceFailure);
  }
  const duplicateCapability = firstDuplicate(inspection.capabilityCeiling);
  if (duplicateCapability !== undefined) {
    return invalid({ kind: 'DuplicateCapability', capability: duplicateCapability });
  }
  const taskMandateCapabilities = new Set(expected.taskMandate.allowedCapabilities);
  const capabilityOutsideMandate = inspection.capabilityCeiling.find(
    (capability) => !taskMandateCapabilities.has(capability),
  );
  if (capabilityOutsideMandate !== undefined) {
    return invalid({
      kind: 'CapabilityCeilingOutsideTaskMandate',
      capability: capabilityOutsideMandate,
    });
  }
  const malformedBudget = invalidBudget(inspection.budgetCeiling);
  if (malformedBudget !== undefined) {
    return invalid({ kind: 'BudgetInvalid', budget: malformedBudget });
  }
  const budgetOutsideMandate = budgetAbove(inspection.budgetCeiling, expected.taskMandate.budgets);
  if (budgetOutsideMandate !== undefined) {
    return invalid({
      kind: 'BudgetCeilingOutsideTaskMandate',
      budget: budgetOutsideMandate,
    });
  }
  const duplicateEvolutionClass = firstDuplicate(inspection.evolutionClassCeiling);
  if (duplicateEvolutionClass !== undefined) {
    return invalid({ kind: 'DuplicateEvolutionClass', evolutionClass: duplicateEvolutionClass });
  }
  const taskMandateEvolution = new Set(expected.taskMandate.allowedEvolutionClasses);
  const evolutionOutsideMandate = inspection.evolutionClassCeiling.find(
    (evolutionClass) => !taskMandateEvolution.has(evolutionClass),
  );
  if (evolutionOutsideMandate !== undefined) {
    return invalid({
      kind: 'EvolutionClassCeilingOutsideTaskMandate',
      evolutionClass: evolutionOutsideMandate,
    });
  }
  if (!exactEvidenceRequirements(inspection.requiredEvidenceClasses)) {
    return invalid({ kind: 'EvidenceRequirementsMismatch' });
  }
  const temporalFailure = temporalInvalidity(
    inspection.credential,
    inspection.notBefore,
    inspection.expiresAt,
    expected.task.expiresAt,
    expected.observedAt,
  );
  if (temporalFailure !== undefined) {
    return invalid(temporalFailure);
  }
  const mandate: CurrentPromotionMandate = {
    ...inspection,
    credential: freezeCredential(inspection.credential),
    capabilityCeiling: Object.freeze([...inspection.capabilityCeiling]),
    budgetCeiling: freezeBudgets(inspection.budgetCeiling),
    evolutionClassCeiling: Object.freeze([...inspection.evolutionClassCeiling]),
    requiredEvidenceClasses: promotionEvidenceClasses,
    kind: 'PromotionMandate',
    [currentPromotionMandate]: currentPromotionMandate,
  };
  return { kind: 'Current', mandate: Object.freeze(mandate) };
}
