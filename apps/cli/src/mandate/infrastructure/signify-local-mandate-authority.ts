import type { AdmittedUser } from '@devrandom/domain';
import {
  agentAid,
  connectLocalEvidenceSealExchange,
  connectLocalRunAdmissionExchange,
  connectLocalMandateCustody,
  connectLocalPrincipalCustody,
  connectLocalPromotionExchanges,
  connectLocalActivationReceiptInspection,
  controllerAid,
  establishLocalPrincipals,
  userAid,
} from '@devrandom/identity';

import { devrandomUserAlias } from '../../identity/domain/user-configuration.js';
import type { UserIdentityConfiguration } from '../../identity/domain/user-configuration.js';
import type { SignifyCustody } from '../../identity/domain/user-profile.js';
import type { LocalGovernanceProfiles } from '../application/local-governance.js';
import { LocalGovernance } from '../application/local-governance.js';
import type {
  CurrentLocalMandateAuthority,
  CurrentLocalMandates,
} from '../application/local-task-mandates.js';
import type { MandateConfiguration } from './mandate-environment.js';

interface SignifyCustodyFiles {
  readCustody(): Promise<SignifyCustody | undefined>;
}

export interface SignifyLocalMandateAuthorityDependencies {
  readonly connectPrincipals: typeof connectLocalPrincipalCustody;
  readonly connectMandates: typeof connectLocalMandateCustody;
  readonly connectRunAdmission: typeof connectLocalRunAdmissionExchange;
  readonly connectEvidenceSeal: typeof connectLocalEvidenceSealExchange;
  readonly connectPromotion: typeof connectLocalPromotionExchanges;
  readonly connectActivationReceipts: typeof connectLocalActivationReceiptInspection;
}

const signifyLocalMandateAuthorityDefaults: SignifyLocalMandateAuthorityDependencies = {
  connectPrincipals: connectLocalPrincipalCustody,
  connectMandates: connectLocalMandateCustody,
  connectRunAdmission: connectLocalRunAdmissionExchange,
  connectEvidenceSeal: connectLocalEvidenceSealExchange,
  connectPromotion: connectLocalPromotionExchanges,
  connectActivationReceipts: connectLocalActivationReceiptInspection,
};

export class SignifyLocalMandateAuthority implements CurrentLocalMandates {
  readonly #identity: UserIdentityConfiguration;
  readonly #mandates: MandateConfiguration;
  readonly #custodyFiles: SignifyCustodyFiles;
  readonly #profiles: LocalGovernanceProfiles;
  readonly #dependencies: SignifyLocalMandateAuthorityDependencies;

  constructor(
    identity: UserIdentityConfiguration,
    mandates: MandateConfiguration,
    custodyFiles: SignifyCustodyFiles,
    profiles: LocalGovernanceProfiles,
    dependencies: SignifyLocalMandateAuthorityDependencies = signifyLocalMandateAuthorityDefaults,
  ) {
    this.#identity = identity;
    this.#mandates = mandates;
    this.#custodyFiles = custodyFiles;
    this.#profiles = profiles;
    this.#dependencies = dependencies;
  }

  async establish(user: AdmittedUser): Promise<CurrentLocalMandateAuthority> {
    const custody = await this.#custodyFiles.readCustody();
    if (custody === undefined) {
      return { kind: 'CustodyUnavailable' };
    }
    if (
      user.custody.witnessThreshold !== 1 ||
      user.custody.witnessAids.length !== 1 ||
      user.custody.witnessAids[0] !== this.#identity.witnessAid
    ) {
      return { kind: 'GovernanceRejected', reason: 'UserCustodyChanged' };
    }

    const expectedControllerAid = controllerAid(user.custody.controllerAid);
    const expectedAgentAid = agentAid(user.custody.keriaAgentAid);
    const expectedUserAid = userAid(user.principal.aid);
    const connection = {
      adminUrl: this.#identity.keriaAdminUrl,
      bootUrl: this.#identity.keriaBootUrl,
      bran: custody.bran,
      securityTier: 'low' as const,
    };
    const principalCustody = await this.#dependencies.connectPrincipals({
      ...connection,
      witnessOobis: [{ aid: this.#identity.witnessAid, oobi: this.#identity.witnessOobi }],
      operationTimeoutMs: this.#identity.operationTimeoutMs,
      oobiAvailabilityTimeoutMs: this.#identity.operationTimeoutMs,
    });
    const mandateCustody = await this.#dependencies.connectMandates({
      ...connection,
      expectedControllerAid,
      expectedAgentAid,
      taskMandateSchemaOobi: this.#mandates.taskMandateSchemaOobi,
      promotionMandateSchemaOobi: this.#mandates.promotionMandateSchemaOobi,
      operationTimeoutMs: this.#identity.operationTimeoutMs,
    });
    const governance = await new LocalGovernance({
      profiles: this.#profiles,
      establishPrincipals: (input) => establishLocalPrincipals(principalCustody, input),
      registry: mandateCustody,
      operationTimeoutMs: this.#identity.operationTimeoutMs,
    }).establish({
      alias: devrandomUserAlias,
      userAid: expectedUserAid,
      controllerAid: expectedControllerAid,
      keriaAgentAid: expectedAgentAid,
      witnessPolicy: {
        kind: 'witnessed',
        witnessAids: [this.#identity.witnessAid],
        threshold: 1,
      },
    });
    if (governance.kind !== 'Ready') {
      return { kind: 'GovernanceRejected', reason: governance.reason };
    }
    const runAdmissionExchange = await this.#dependencies.connectRunAdmission({
      ...connection,
      expectedControllerAid,
      expectedAgentAid,
    });
    const evidenceSealExchange = await this.#dependencies.connectEvidenceSeal({
      ...connection,
      expectedControllerAid,
      expectedAgentAid,
    });
    const promotionExchanges = await this.#dependencies.connectPromotion({
      ...connection,
      expectedControllerAid,
      expectedAgentAid,
    });
    const activationReceipts = await this.#dependencies.connectActivationReceipts({
      ...connection,
      expectedControllerAid,
      expectedAgentAid,
    });
    return {
      kind: 'Ready',
      governance: governance.profile,
      principals: governance.principals,
      custody: mandateCustody,
      runAdmissionExchange,
      evidenceSealExchange,
      promotionExchanges,
      activationReceipts,
    };
  }
}
