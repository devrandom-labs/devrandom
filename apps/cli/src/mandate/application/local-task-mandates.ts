import type { AdmittedUser, TaskToolCapability } from '@devrandom/domain';
import type {
  EstablishedLocalPrincipals,
  IssuerAid,
  LocalEvidenceSealExchange,
  LocalMandateCustody,
  LocalRunAdmissionExchange,
} from '@devrandom/identity';

import type {
  LocalTaskMandateInput,
  LocalTaskMandatePreparation,
  LocalTaskMandates,
  MandateAdmissionSummary,
} from '../../task/application/task-run-preparation.js';
import type { LocalGovernanceProfile } from '../domain/local-governance.js';
import type { AdmittedMandate, ReadyTaskAuthorization } from '../domain/task-authorization.js';
import {
  preparePromotionMandateIssuance,
  prepareTaskMandateIssuance,
} from './mandate-issuance-plan.js';
import type {
  TaskAuthorizationRecords,
  TaskMandateAuthorizationOutcome,
} from './task-mandate-authorization.js';
import { TaskMandateAuthorization } from './task-mandate-authorization.js';

export type CurrentLocalMandateAuthority =
  | {
      readonly kind: 'Ready';
      readonly governance: LocalGovernanceProfile;
      readonly principals: EstablishedLocalPrincipals;
      readonly custody: LocalMandateCustody;
      readonly runAdmissionExchange: LocalRunAdmissionExchange;
      readonly evidenceSealExchange: LocalEvidenceSealExchange;
    }
  | { readonly kind: 'CustodyUnavailable' }
  | {
      readonly kind: 'GovernanceRejected';
      readonly reason: 'UserCustodyChanged' | 'ManagedPrincipalChanged' | 'MandateRegistryChanged';
    };

export interface CurrentLocalMandates {
  establish(user: AdmittedUser): Promise<CurrentLocalMandateAuthority>;
}

export interface LocalTaskMandatesDependencies {
  readonly local: CurrentLocalMandates;
  readonly records: TaskAuthorizationRecords;
  readonly issuerAid: IssuerAid;
  readonly userAlias: string;
  now(): number;
  wait(milliseconds: number): Promise<void>;
  readonly maximumObservations: number;
}

export class AuthorizedLocalTaskMandates implements LocalTaskMandates {
  readonly #dependencies: LocalTaskMandatesDependencies;

  constructor(dependencies: LocalTaskMandatesDependencies) {
    this.#dependencies = dependencies;
  }

  async prepare(input: LocalTaskMandateInput): Promise<LocalTaskMandatePreparation> {
    const local = await this.#dependencies.local.establish(input.user);
    if (local.kind !== 'Ready') {
      return local;
    }
    const authorization = await new TaskMandateAuthorization({
      records: this.#dependencies.records,
      custody: local.custody,
      presentations: input.presentations,
      now: () => this.#dependencies.now(),
      wait: (milliseconds) => this.#dependencies.wait(milliseconds),
      maximumObservations: this.#dependencies.maximumObservations,
    }).authorize({
      userAlias: this.#dependencies.userAlias,
      task: input.task,
      governance: local.governance,
      issuerAid: this.#dependencies.issuerAid,
      workAccessExpiresAt: input.grantExpiresAt,
    });
    if (authorization.kind !== 'Ready') {
      return { kind: 'AuthorizationRejected', outcome: authorization };
    }
    const summary = mandateSummary(
      this.#dependencies.userAlias,
      input,
      local.governance,
      local.principals,
      local.custody,
      local.runAdmissionExchange,
      local.evidenceSealExchange,
      authorization.authorization,
    );
    return summary.kind === 'Prepared'
      ? summary
      : { kind: 'AuthorizationRejected', outcome: summary.outcome };
  }
}

type MandateSummaryPreparation =
  | Extract<LocalTaskMandatePreparation, { readonly kind: 'Prepared' }>
  | {
      readonly kind: 'Rejected';
      readonly outcome: Extract<
        TaskMandateAuthorizationOutcome,
        { readonly kind: 'IssuanceRejected' }
      >;
    };

function mandateSummary(
  userAlias: string,
  input: LocalTaskMandateInput,
  governance: LocalGovernanceProfile,
  principals: EstablishedLocalPrincipals,
  custody: LocalMandateCustody,
  runAdmissionExchange: LocalRunAdmissionExchange,
  evidenceSealExchange: LocalEvidenceSealExchange,
  authorization: ReadyTaskAuthorization,
): MandateSummaryPreparation {
  const planInput = {
    userAlias,
    governance,
    task: input.task,
    issuedAt: authorization.stage.taskMandate.credential.issuedAt,
  };
  const taskPlan = prepareTaskMandateIssuance(planInput);
  if (taskPlan.kind === 'Rejected') {
    return {
      kind: 'Rejected',
      outcome: { kind: 'IssuanceRejected', mandateKind: 'TaskMandate', reason: taskPlan.reason },
    };
  }
  const promotionPlan = preparePromotionMandateIssuance({
    ...planInput,
    issuedAt: authorization.stage.promotionMandate.credential.issuedAt,
  });
  if (promotionPlan.kind === 'Rejected') {
    return {
      kind: 'Rejected',
      outcome: {
        kind: 'IssuanceRejected',
        mandateKind: 'PromotionMandate',
        reason: promotionPlan.reason,
      },
    };
  }
  return {
    kind: 'Prepared',
    summary: {
      personalAgent: {
        aid: governance.personalAgentAid,
        origin: principals.personalAgent.origin,
      },
      governor: {
        aid: governance.governorAid,
        origin: principals.governor.origin,
      },
      mandateRegistryId: governance.mandateRegistryId,
      taskMandate: {
        ...admittedSummary(authorization.stage.taskMandate, taskPlan.issuance.claims.expiresAt),
        allowedCapabilities: taskPlan.issuance.claims.allowedCapabilities,
        budgets: taskPlan.issuance.claims.budgets,
        allowedEvolutionClasses: taskPlan.issuance.claims.allowedEvolutionClasses,
      },
      promotionMandate: {
        ...admittedSummary(
          authorization.stage.promotionMandate,
          promotionPlan.issuance.claims.expiresAt,
        ),
        capabilityCeiling: promotionPlan.issuance.claims.capabilityCeiling,
        budgetCeiling: promotionPlan.issuance.claims.budgetCeiling,
        evolutionClassCeiling: promotionPlan.issuance.claims.evolutionClassCeiling,
        requiredEvidenceClasses: promotionPlan.issuance.claims.requiredEvidenceClasses,
      },
    },
    harnessAuthority: {
      personalAgentAid: governance.personalAgentAid,
      taskMandateSaid: authorization.stage.taskMandate.credential.credentialSaid,
      allowedCapabilities: taskPlan.issuance.claims.allowedCapabilities.flatMap(
        (capability): TaskToolCapability[] => (capability === 'ReadTaskMemory' ? [] : [capability]),
      ),
      mandateBudgets: taskPlan.issuance.claims.budgets,
    },
    runAuthority: {
      personalAgentAid: governance.personalAgentAid,
      governorAid: governance.governorAid,
      exchange: runAdmissionExchange,
    },
    executionAuthority: {
      personalAgentAid: governance.personalAgentAid,
      taskMandateCustody: custody,
      evidenceSealExchange,
    },
  };
}

function admittedSummary(mandate: AdmittedMandate, expiresAt: string): MandateAdmissionSummary {
  return {
    credentialSaid: mandate.credential.credentialSaid,
    holderGrantSaid: mandate.holderGrant.grantSaid,
    holderAdmissionSaid: mandate.holderAdmission.admitSaid,
    serverGrantSaid: mandate.serverGrant.grantSaid,
    expiresAt,
    admittedAt: mandate.admittedAt,
  };
}
