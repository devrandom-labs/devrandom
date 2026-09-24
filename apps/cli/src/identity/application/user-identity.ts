import {
  confirmCurrentUserCustody,
  decideUserAdmission,
  verifyDevrandomUserCredential,
  type AdmittedUser,
  type IdentityInfrastructureDependency,
  type UserCredentialInvalidity,
} from '@devrandom/domain';
import {
  challengeResponseSaid,
  connectLocalUserInfrastructure,
  agentAid,
  controllerAid,
  credentialSaid,
  generateSignifyBran,
  ipexGrantSaid,
  issuerAid,
  issuerOobi,
  userAid,
  IdentityFailure,
  type LocalUserInfrastructure,
  type ProvisionLocalUser,
  type VerifiedCredentialEvidence,
} from '@devrandom/identity';
import { credentialSchema, type CliRegistrationProjection } from '@devrandom/protocol';

import {
  devrandomUserAlias,
  type UserIdentityConfiguration,
} from '../domain/user-configuration.js';
import type {
  ActiveRegistrationSecrets,
  SignifyCustody,
  UserCredentialReference,
  UserProfile,
} from '../domain/user-profile.js';
import { IdentityFileFailure, type IdentityFiles } from '../infrastructure/identity-files.js';
import {
  IssuerRegistrationHttpFailure,
  type IssuerRegistrationHttp,
} from '../infrastructure/issuer-registration-http.js';
import { planLocalIdentityRecovery } from './local-identity-recovery.js';

export type UserIdentityOutcome =
  | {
      readonly kind: 'Ready';
      readonly user: AdmittedUser;
      readonly profile: UserProfile;
      readonly recovery: 'NewIdentity' | 'ExistingIdentity';
    }
  | {
      readonly kind: 'RegistrationRequired';
      readonly profile: UserProfile;
      readonly browserUrl?: string;
    }
  | {
      readonly kind: 'RegistrationRejected';
      readonly disposition: 'Rejected' | 'Expired' | 'ProofRejected' | 'ProofReplayed';
      readonly detail?: string;
    }
  | {
      readonly kind: 'InvalidCredential';
      readonly evidence:
        | { readonly kind: 'PolicyInvalidity'; readonly invalidity: UserCredentialInvalidity }
        | { readonly kind: 'CryptographicInvalidity'; readonly reason: string };
    }
  | {
      readonly kind: 'RecoveryRequired';
      readonly reason:
        'CustodyUnavailable' | 'ProfileUnavailable' | 'IdentityConflict' | 'ReplacementRequired';
      readonly detail?: string;
    }
  | {
      readonly kind: 'InfrastructureUnavailable';
      readonly dependency: IdentityInfrastructureDependency;
    };

type RegistrationRejectedOutcome = Extract<
  UserIdentityOutcome,
  { readonly kind: 'RegistrationRejected' }
>;

export interface UserIdentityDependencies {
  readonly generateBran: () => Promise<string>;
  readonly createRegistrationKey: () => string;
  readonly connectInfrastructure: typeof connectLocalUserInfrastructure;
  readonly presentBrowserUrl: (url: string) => Promise<void>;
  readonly now: () => number;
  readonly wait: (milliseconds: number) => Promise<void>;
}

export const userIdentityDefaults: UserIdentityDependencies = {
  generateBran: generateSignifyBran,
  createRegistrationKey: () => `registration_${randomBytes(32).toString('base64url')}`,
  connectInfrastructure: connectLocalUserInfrastructure,
  presentBrowserUrl: () => Promise.resolve(),
  now: () => Date.now(),
  wait: (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
};

interface EstablishedUser {
  readonly profile: UserProfile;
  readonly infrastructure: LocalUserInfrastructure;
  readonly recovery: 'NewIdentity' | 'ExistingIdentity';
  readonly rotationReconciliation: 'profile-current' | 'completed-rotation-reconciled';
}

type RotationReconciliation =
  | { readonly kind: 'profile-current'; readonly profile: UserProfile }
  | { readonly kind: 'completed-rotation-reconciled'; readonly profile: UserProfile }
  | { readonly kind: 'rotation-conflict' };

type Establishment =
  | { readonly kind: 'user-established'; readonly user: EstablishedUser }
  | Extract<
      UserIdentityOutcome,
      { readonly kind: 'RecoveryRequired' | 'InfrastructureUnavailable' }
    >;

export class UserIdentityApplication {
  readonly #configuration: UserIdentityConfiguration;
  readonly #files: IdentityFiles;
  readonly #issuer: IssuerRegistrationHttp;
  readonly #dependencies: UserIdentityDependencies;

  constructor(
    configuration: UserIdentityConfiguration,
    files: IdentityFiles,
    issuer: IssuerRegistrationHttp,
    dependencies: UserIdentityDependencies = userIdentityDefaults,
  ) {
    this.#configuration = configuration;
    this.#files = files;
    this.#issuer = issuer;
    this.#dependencies = dependencies;
  }

  async initialize(): Promise<UserIdentityOutcome> {
    try {
      const establishment = await this.#establish();
      if (establishment.kind !== 'user-established') {
        return establishment;
      }
      const existing = await this.#admitExisting(establishment.user);
      if (existing.kind === 'Ready') {
        await this.#files.removeRegistrationSecrets();
        return existing;
      }
      if (existing.kind === 'InvalidCredential') {
        return existing;
      }
      return await this.#register(establishment.user);
    } catch (cause) {
      return classifyFailure(cause);
    }
  }

  async whoami(): Promise<UserIdentityOutcome> {
    try {
      const establishment = await this.#recoverExisting();
      if (establishment.kind !== 'user-established') {
        return establishment;
      }
      return await this.#admitExisting(establishment.user);
    } catch (cause) {
      return classifyFailure(cause);
    }
  }

  async rotate(): Promise<UserIdentityOutcome> {
    try {
      const establishment = await this.#recoverExisting();
      if (establishment.kind !== 'user-established') {
        return establishment;
      }
      const before = await this.#admitExisting(establishment.user);
      if (before.kind !== 'Ready') {
        return before;
      }
      if (establishment.user.rotationReconciliation === 'completed-rotation-reconciled') {
        return before;
      }
      let rotationProfile = establishment.user.profile;
      if (rotationProfile.rotation === undefined) {
        rotationProfile = await this.#commitProfile(rotationProfile, {
          ...rotationProfile,
          rotation: {
            kind: 'rotation-pending',
            priorKelSequence: rotationProfile.receiptEvidence.kelSequence,
            priorEventSaid: rotationProfile.receiptEvidence.currentEventSaid,
          },
        });
      }
      const rotated = await establishment.user.infrastructure.rotate();
      const profile = await this.#commitProfile(rotationProfile, {
        ...profileWithoutRotation(rotationProfile),
        receiptEvidence: {
          kelSequence: rotated.kelSequence,
          currentEventSaid: rotated.currentEventSaid,
          receiptIndexes: [...rotated.receiptIndexes],
        },
      });
      return await this.#admitExisting({
        ...establishment.user,
        profile,
        recovery: 'ExistingIdentity',
        rotationReconciliation: 'profile-current',
      });
    } catch (cause) {
      return classifyFailure(cause);
    }
  }

  async #establish(): Promise<Establishment> {
    let custody: SignifyCustody | undefined;
    let profile: UserProfile | undefined;
    try {
      [custody, profile] = await Promise.all([
        this.#files.readCustody(),
        this.#files.readProfile(),
      ]);
    } catch (cause) {
      return fileRecovery(cause);
    }
    const plan = planLocalIdentityRecovery(custody, profile);
    if (plan.kind === 'recovery-required') {
      return { kind: 'RecoveryRequired', reason: plan.reason };
    }

    let activeCustody: SignifyCustody;
    let recovery: 'NewIdentity' | 'ExistingIdentity';
    if (plan.kind === 'create-local-identity') {
      activeCustody = { version: 1, bran: await this.#dependencies.generateBran() };
      await this.#files.createCustody(activeCustody);
      recovery = 'NewIdentity';
    } else {
      activeCustody = plan.custody;
      recovery = plan.kind === 'recover-local-identity' ? 'ExistingIdentity' : 'NewIdentity';
    }

    const existingProfile = plan.kind === 'recover-local-identity' ? plan.profile : undefined;
    if (existingProfile !== undefined && !this.#profileMatchesConfiguration(existingProfile)) {
      return { kind: 'RecoveryRequired', reason: 'IdentityConflict' };
    }
    const connectionPolicy = {
      adminUrl: this.#configuration.keriaAdminUrl,
      bootUrl: this.#configuration.keriaBootUrl,
      bran: activeCustody.bran,
      securityTier: 'low',
      alias: devrandomUserAlias,
      witnessPolicy: {
        kind: 'witnessed',
        witnessAids: [this.#configuration.witnessAid],
        threshold: 1,
      },
      witnessOobis: [
        { aid: this.#configuration.witnessAid, oobi: this.#configuration.witnessOobi },
      ],
      operationTimeoutMs: this.#configuration.operationTimeoutMs,
      oobiAvailabilityTimeoutMs: this.#configuration.operationTimeoutMs,
    } satisfies Omit<ProvisionLocalUser, 'kind'>;
    const infrastructure =
      existingProfile === undefined
        ? await this.#dependencies.connectInfrastructure({
            ...connectionPolicy,
            kind: 'provision-local-user',
          })
        : await this.#dependencies.connectInfrastructure({
            ...connectionPolicy,
            kind: 'recover-local-user',
            expectedControllerAid: controllerAid(existingProfile.controllerAid),
            expectedAgentAid: agentAid(existingProfile.keriaAgentAid),
            expectedUserAid: userAid(existingProfile.userAid),
          });

    if (existingProfile !== undefined) {
      const reconciled = await this.#reconcileRotation(existingProfile, infrastructure);
      if (reconciled.kind === 'rotation-conflict') {
        return { kind: 'RecoveryRequired', reason: 'IdentityConflict' };
      }
      return {
        kind: 'user-established',
        user: {
          profile: reconciled.profile,
          infrastructure,
          recovery,
          rotationReconciliation: reconciled.kind,
        },
      };
    }

    const created = await this.#commitProfile(undefined, {
      version: 1,
      revision: 0,
      alias: devrandomUserAlias,
      controllerAid: infrastructure.identity.controllerAid,
      keriaAgentAid: infrastructure.identity.agentAid,
      userAid: infrastructure.identity.user.aid,
      userAgentOobi: infrastructure.identity.userAgentOobi,
      witnessPolicy: {
        witnessAids: [...infrastructure.identity.user.witnessPolicy.witnessAids],
        threshold: infrastructure.identity.user.witnessPolicy.threshold,
      },
      receiptEvidence: {
        kelSequence: infrastructure.identity.user.kelSequence,
        currentEventSaid: infrastructure.identity.user.currentEventSaid,
        receiptIndexes: [...infrastructure.identity.user.receiptIndexes],
      },
      issuer: {
        aid: this.#configuration.issuerAid,
        oobi: this.#configuration.issuerOobi,
        registryId: this.#configuration.registryId,
        schemaSaid: this.#configuration.schemaId,
      },
      provenance: { kind: 'live' },
      custodyReference: 'signify-bran-v1',
    });
    return {
      kind: 'user-established',
      user: {
        profile: created,
        infrastructure,
        recovery,
        rotationReconciliation: 'profile-current',
      },
    };
  }

  async #recoverExisting(): Promise<Establishment> {
    let custody: SignifyCustody | undefined;
    let profile: UserProfile | undefined;
    try {
      [custody, profile] = await Promise.all([
        this.#files.readCustody(),
        this.#files.readProfile(),
      ]);
    } catch (cause) {
      return fileRecovery(cause);
    }
    if (profile === undefined) {
      return { kind: 'RecoveryRequired', reason: 'ProfileUnavailable' };
    }
    if (custody === undefined) {
      return { kind: 'RecoveryRequired', reason: 'CustodyUnavailable' };
    }
    if (!this.#profileMatchesConfiguration(profile)) {
      return { kind: 'RecoveryRequired', reason: 'IdentityConflict' };
    }

    const infrastructure = await this.#dependencies.connectInfrastructure({
      kind: 'recover-local-user',
      adminUrl: this.#configuration.keriaAdminUrl,
      bootUrl: this.#configuration.keriaBootUrl,
      bran: custody.bran,
      securityTier: 'low',
      alias: devrandomUserAlias,
      witnessPolicy: {
        kind: 'witnessed',
        witnessAids: [this.#configuration.witnessAid],
        threshold: 1,
      },
      witnessOobis: [
        { aid: this.#configuration.witnessAid, oobi: this.#configuration.witnessOobi },
      ],
      operationTimeoutMs: this.#configuration.operationTimeoutMs,
      oobiAvailabilityTimeoutMs: this.#configuration.operationTimeoutMs,
      expectedControllerAid: controllerAid(profile.controllerAid),
      expectedAgentAid: agentAid(profile.keriaAgentAid),
      expectedUserAid: userAid(profile.userAid),
    });
    const reconciled = await this.#reconcileRotation(profile, infrastructure);
    if (reconciled.kind === 'rotation-conflict') {
      return { kind: 'RecoveryRequired', reason: 'IdentityConflict' };
    }
    return {
      kind: 'user-established',
      user: {
        profile: reconciled.profile,
        infrastructure,
        recovery: 'ExistingIdentity',
        rotationReconciliation: reconciled.kind,
      },
    };
  }

  async #reconcileRotation(
    profile: UserProfile,
    infrastructure: LocalUserInfrastructure,
  ): Promise<RotationReconciliation> {
    if (profileMatchesLiveIdentity(profile, infrastructure)) {
      return profile.rotation === undefined
        ? { kind: 'profile-current', profile }
        : { kind: 'rotation-conflict' };
    }
    const rotation = profile.rotation;
    if (
      rotation === undefined ||
      rotation.priorKelSequence !== profile.receiptEvidence.kelSequence ||
      rotation.priorEventSaid !== profile.receiptEvidence.currentEventSaid ||
      !profileMatchesStableIdentity(profile, infrastructure) ||
      infrastructure.identity.user.kelSequence !== rotation.priorKelSequence + 1
    ) {
      return { kind: 'rotation-conflict' };
    }
    const reconciled = await this.#commitProfile(profile, {
      ...profileWithoutRotation(profile),
      receiptEvidence: {
        kelSequence: infrastructure.identity.user.kelSequence,
        currentEventSaid: infrastructure.identity.user.currentEventSaid,
        receiptIndexes: [...infrastructure.identity.user.receiptIndexes],
      },
    });
    return { kind: 'completed-rotation-reconciled', profile: reconciled };
  }

  async #admitExisting(user: EstablishedUser): Promise<UserIdentityOutcome> {
    const reference = user.profile.credential;
    if (reference === undefined) {
      return { kind: 'RegistrationRequired', profile: user.profile };
    }
    const verified = await user.infrastructure.credentialReception.verify({
      issuerAid: this.#configuration.issuerAid,
      issueeAid: userAid(user.profile.userAid),
      registryId: this.#configuration.registryId,
      schemaId: this.#configuration.schemaId,
      credentialSaid: credentialSaid(reference.credentialSaid),
      payloadSchema: credentialSchema,
    });
    return admitVerifiedCredential(user, verified, this.#configuration, this.#dependencies.now());
  }

  async #register(user: EstablishedUser): Promise<UserIdentityOutcome> {
    let profile = user.profile;
    let secrets = await this.#files.readRegistrationSecrets();
    if (profile.registration === undefined && secrets === undefined) {
      secrets = await this.#files.claimRegistrationCreation({
        version: 1,
        kind: 'registration-create-pending',
        creationKey: this.#dependencies.createRegistrationKey(),
      });
    }
    if (profile.registration === undefined && secrets?.kind === 'registration-create-pending') {
      const created = await this.#issuer.create(
        {
          protocolVersion: 1,
          userAid: profile.userAid,
          userAgentOobi: profile.userAgentOobi,
        },
        secrets.creationKey,
      );
      if (
        created.issuerAid !== this.#configuration.issuerAid ||
        created.issuerOobi !== this.#configuration.issuerOobi ||
        !trustedRegistrationBrowserUrl(created.browserUrl, this.#configuration.registrationSiteUrl)
      ) {
        return { kind: 'RecoveryRequired', reason: 'IdentityConflict' };
      }
      secrets = {
        version: 1,
        kind: 'registration-active',
        registrationId: created.registrationId,
        cliCapability: created.cliCapability,
        browserUrl: created.browserUrl,
        challengeWords: [...created.challengeWords],
        issuerAid: created.issuerAid,
        issuerOobi: created.issuerOobi,
        expiresAt: created.expiresAt,
        pollIntervalMs: created.pollIntervalMs,
      };
      await this.#files.writeRegistrationSecrets(secrets);
    }
    if (profile.registration === undefined && secrets?.kind === 'registration-active') {
      if (!this.#secretsMatchIssuer(secrets)) {
        return { kind: 'RecoveryRequired', reason: 'IdentityConflict' };
      }
      profile = await this.#commitProfile(profile, {
        ...profile,
        registration: {
          kind: 'registration-pending',
          registrationId: secrets.registrationId,
          expiresAt: secrets.expiresAt,
        },
      });
    }

    if (
      secrets === undefined ||
      secrets.kind !== 'registration-active' ||
      profile.registration === undefined
    ) {
      return { kind: 'RecoveryRequired', reason: 'ProfileUnavailable' };
    }
    if (
      secrets.registrationId !== profile.registration.registrationId ||
      !this.#secretsMatchIssuer(secrets)
    ) {
      return { kind: 'RecoveryRequired', reason: 'IdentityConflict' };
    }

    await user.infrastructure.resolveIssuer(
      issuerOobi(secrets.issuerOobi),
      issuerAid(secrets.issuerAid),
    );
    await user.infrastructure.resolveCredentialSchema(
      this.#configuration.schemaOobi,
      credentialSchema,
    );
    if (secrets.proof === undefined) {
      const preparedAt = this.#dependencies.now();
      const proof = await user.infrastructure.challengeProof.prepare({
        alias: profile.alias,
        sourceAid: userAid(profile.userAid),
        recipientAid: this.#configuration.issuerAid,
        challengeWords: secrets.challengeWords,
        preparedAt,
      });
      secrets = {
        ...secrets,
        proof: {
          kind: 'challenge-response-prepared',
          responseSaid: proof.responseSaid,
          preparedAt,
        },
      };
      await this.#files.writeRegistrationSecrets(secrets);
    }
    const preparedProof = secrets.proof;
    if (preparedProof === undefined) {
      return { kind: 'RecoveryRequired', reason: 'IdentityConflict' };
    }
    let projection: CliRegistrationProjection;
    try {
      const delivered = await user.infrastructure.challengeProof.deliver({
        alias: profile.alias,
        sourceAid: userAid(profile.userAid),
        recipientAid: this.#configuration.issuerAid,
        challengeWords: secrets.challengeWords,
        preparedAt: preparedProof.preparedAt,
        responseSaid: challengeResponseSaid(preparedProof.responseSaid),
      });

      projection = await this.#issuer.submitAidProof(
        secrets.registrationId,
        secrets.cliCapability,
        delivered.responseSaid,
      );
      await this.#dependencies.presentBrowserUrl(secrets.browserUrl);
      const deadline = this.#dependencies.now() + this.#configuration.registrationTimeoutMs;
      while (!terminalRegistration(projection) && this.#dependencies.now() < deadline) {
        await this.#dependencies.wait(secrets.pollIntervalMs);
        projection = await this.#issuer.retrieve(secrets.registrationId, secrets.cliCapability);
      }
    } catch (cause) {
      const rejected = registrationRejection(cause);
      if (rejected === undefined) {
        throw cause;
      }
      return this.#retireRegistration(profile, rejected);
    }
    if (projection.kind === 'rejected') {
      return this.#retireRegistration(profile, {
        kind: 'RegistrationRejected',
        disposition: projection.reason === 'aid-proof-rejected' ? 'ProofRejected' : 'Rejected',
      });
    }
    if (projection.kind === 'expired') {
      return this.#retireRegistration(profile, {
        kind: 'RegistrationRejected',
        disposition: 'Expired',
      });
    }
    if (projection.kind !== 'issued') {
      return { kind: 'RegistrationRequired', profile, browserUrl: secrets.browserUrl };
    }

    let registration = profile.registration;
    if (registration.kind !== 'registration-issued') {
      registration = {
        kind: 'registration-issued',
        registrationId: projection.registrationId,
        expiresAt: projection.expiresAt,
        grantSaid: projection.grantSaid,
        credentialSaid: projection.credentialSaid,
        admitPreparedAt: this.#dependencies.now(),
      };
      profile = await this.#commitProfile(profile, {
        ...profile,
        registration,
      });
    }

    const verified = await user.infrastructure.credentialReception.admitAndVerify({
      userAlias: profile.alias,
      issuerAid: this.#configuration.issuerAid,
      issueeAid: userAid(profile.userAid),
      registryId: this.#configuration.registryId,
      schemaId: this.#configuration.schemaId,
      credentialSaid: credentialSaid(registration.credentialSaid),
      grantSaid: ipexGrantSaid(registration.grantSaid),
      admitPreparedAt: registration.admitPreparedAt,
      operationTimeoutMs: this.#configuration.operationTimeoutMs,
      materializationTimeoutMs: this.#configuration.operationTimeoutMs,
      payloadSchema: credentialSchema,
    });
    const reference: UserCredentialReference = {
      credentialSaid: verified.credentialSaid,
      attributeSaid: verified.attributeSaid,
      issuerAnchorEventSaid: verified.issuerAnchorEventSaid,
      issuedAt: verified.issuedAt,
    };
    profile = await this.#commitProfile(profile, profileWithCredential(profile, reference));
    await this.#files.removeRegistrationSecrets();
    return admitVerifiedCredential(
      { ...user, profile },
      verified,
      this.#configuration,
      this.#dependencies.now(),
    );
  }

  #profileMatchesConfiguration(profile: UserProfile): boolean {
    return (
      profile.alias === devrandomUserAlias &&
      profile.issuer.aid === this.#configuration.issuerAid &&
      profile.issuer.oobi === this.#configuration.issuerOobi &&
      profile.issuer.registryId === this.#configuration.registryId &&
      profile.issuer.schemaSaid === this.#configuration.schemaId &&
      profile.witnessPolicy.threshold === 1 &&
      profile.witnessPolicy.witnessAids.length === 1 &&
      profile.witnessPolicy.witnessAids[0] === this.#configuration.witnessAid
    );
  }

  #secretsMatchIssuer(secrets: ActiveRegistrationSecrets): boolean {
    return (
      secrets.issuerAid === this.#configuration.issuerAid &&
      secrets.issuerOobi === this.#configuration.issuerOobi
    );
  }

  async #retireRegistration(
    profile: UserProfile,
    outcome: RegistrationRejectedOutcome,
  ): Promise<RegistrationRejectedOutcome> {
    await this.#files.removeRegistrationSecrets();
    await this.#commitProfile(profile, profileWithoutRegistration(profile));
    return outcome;
  }

  async #commitProfile(
    current: UserProfile | undefined,
    candidate: UserProfile,
  ): Promise<UserProfile> {
    const next = {
      ...candidate,
      revision: current === undefined ? 0 : current.revision + 1,
    } satisfies UserProfile;
    await this.#files.commitProfile(current?.revision, next);
    return next;
  }
}

function terminalRegistration(projection: CliRegistrationProjection): boolean {
  return (
    projection.kind === 'issued' || projection.kind === 'rejected' || projection.kind === 'expired'
  );
}

function profileMatchesLiveIdentity(
  profile: UserProfile,
  infrastructure: LocalUserInfrastructure,
): boolean {
  return (
    profile.controllerAid === infrastructure.identity.controllerAid &&
    profile.keriaAgentAid === infrastructure.identity.agentAid &&
    profile.userAid === infrastructure.identity.user.aid &&
    profile.userAgentOobi === infrastructure.identity.userAgentOobi &&
    profile.receiptEvidence.kelSequence === infrastructure.identity.user.kelSequence &&
    profile.receiptEvidence.currentEventSaid === infrastructure.identity.user.currentEventSaid &&
    sameNumbers(profile.receiptEvidence.receiptIndexes, infrastructure.identity.user.receiptIndexes)
  );
}

function profileMatchesStableIdentity(
  profile: UserProfile,
  infrastructure: LocalUserInfrastructure,
): boolean {
  return (
    profile.controllerAid === infrastructure.identity.controllerAid &&
    profile.keriaAgentAid === infrastructure.identity.agentAid &&
    profile.userAid === infrastructure.identity.user.aid &&
    profile.userAgentOobi === infrastructure.identity.userAgentOobi &&
    profile.witnessPolicy.threshold === infrastructure.identity.user.witnessPolicy.threshold &&
    profile.witnessPolicy.witnessAids.length ===
      infrastructure.identity.user.witnessPolicy.witnessAids.length &&
    profile.witnessPolicy.witnessAids.every(
      (aid, index) => aid === infrastructure.identity.user.witnessPolicy.witnessAids[index],
    )
  );
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function profileWithCredential(
  profile: UserProfile,
  credential: UserCredentialReference,
): UserProfile {
  return {
    version: profile.version,
    revision: profile.revision,
    alias: profile.alias,
    controllerAid: profile.controllerAid,
    keriaAgentAid: profile.keriaAgentAid,
    userAid: profile.userAid,
    userAgentOobi: profile.userAgentOobi,
    witnessPolicy: profile.witnessPolicy,
    receiptEvidence: profile.receiptEvidence,
    issuer: profile.issuer,
    credential,
    provenance: profile.provenance,
    custodyReference: profile.custodyReference,
  };
}

function profileWithoutRegistration(profile: UserProfile): UserProfile {
  const withoutRegistration = { ...profile };
  delete withoutRegistration.registration;
  return withoutRegistration;
}

function profileWithoutRotation(profile: UserProfile): UserProfile {
  const withoutRotation = { ...profile };
  delete withoutRotation.rotation;
  return withoutRotation;
}

function admitVerifiedCredential(
  user: EstablishedUser,
  verified: VerifiedCredentialEvidence<typeof credentialSchema>,
  configuration: UserIdentityConfiguration,
  verifiedAt: number,
): UserIdentityOutcome {
  const verifiedAtIso = new Date(verifiedAt).toISOString();
  const custody = confirmCurrentUserCustody({
    user: { aid: user.profile.userAid },
    controllerAid: user.profile.controllerAid,
    keriaAgentAid: user.profile.keriaAgentAid,
    kelSequence: user.profile.receiptEvidence.kelSequence,
    witnessAids: user.profile.witnessPolicy.witnessAids,
    witnessThreshold: user.profile.witnessPolicy.threshold,
    witnessReceiptIndexes: user.profile.receiptEvidence.receiptIndexes,
    verifiedAt: verifiedAtIso,
  });
  if (custody.kind === 'RecoveryRequired') {
    return { kind: 'RecoveryRequired', reason: 'IdentityConflict' };
  }
  const credential = verifyDevrandomUserCredential(
    {
      issuerAid: configuration.issuerAid,
      issueeAid: user.profile.userAid,
      registryId: configuration.registryId,
      schemaSaid: configuration.schemaId,
    },
    {
      credentialSaid: verified.credentialSaid,
      attributeSaid: verified.attributeSaid,
      issuerAid: verified.payload.i,
      issueeAid: verified.payload.a.i,
      registryId: verified.payload.ri,
      schemaSaid: verified.payload.s,
      issuedAt: verified.issuedAt,
      verifiedAt: verifiedAtIso,
      credentialSaidBinding: { kind: 'Verified' },
      attributeSaidBinding: { kind: 'Verified' },
      schemaDocument: { kind: 'Resolved', schemaSaid: configuration.schemaId },
      telState: { kind: 'Issued' },
      issuerAnchor: { kind: 'Anchored', eventSaid: verified.issuerAnchorEventSaid },
      eligibilityClaims: verified.payload.a.capabilities,
    },
  );
  if (credential.kind === 'InvalidCredential') {
    return {
      kind: 'InvalidCredential',
      evidence: { kind: 'PolicyInvalidity', invalidity: credential.invalidity },
    };
  }
  const admission = decideUserAdmission({
    kind: 'CurrentCustody',
    custody: custody.custody,
    credential: { kind: 'Current', credential: credential.credential },
  });
  if (admission.kind !== 'Ready') {
    return { kind: 'RecoveryRequired', reason: 'IdentityConflict' };
  }
  return {
    kind: 'Ready',
    user: admission.user,
    profile: user.profile,
    recovery: user.recovery,
  };
}

function fileRecovery(cause: unknown): Establishment {
  if (cause instanceof IdentityFileFailure) {
    return {
      kind: 'RecoveryRequired',
      reason: identityFileRecoveryReason(cause),
      detail: cause.message,
    };
  }
  throw cause;
}

function classifyFailure(cause: unknown): UserIdentityOutcome {
  if (cause instanceof IdentityFileFailure) {
    return {
      kind: 'RecoveryRequired',
      reason: identityFileRecoveryReason(cause),
      detail: cause.message,
    };
  }
  const rejected = registrationRejection(cause);
  if (rejected !== undefined) {
    return rejected;
  }
  if (cause instanceof IssuerRegistrationHttpFailure) {
    if (cause.detail.kind === 'issuer-unavailable') {
      return { kind: 'InfrastructureUnavailable', dependency: 'Issuer' };
    }
    return { kind: 'InfrastructureUnavailable', dependency: 'Issuer' };
  }
  if (cause instanceof IdentityFailure) {
    switch (cause.detail.kind) {
      case 'credential-invalid':
      case 'ipex-evidence-invalid':
        return {
          kind: 'InvalidCredential',
          evidence: { kind: 'CryptographicInvalidity', reason: cause.message },
        };
      case 'user-identifier-invalid':
      case 'identifier-conflict':
      case 'controller-state-invalid':
        return {
          kind: 'RecoveryRequired',
          reason: 'IdentityConflict',
          detail: cause.message,
        };
      case 'keria-unavailable':
      case 'keria-operation-failed':
      case 'keria-operation-timeout':
      case 'controller-boot-rejected':
      case 'keria-response-invalid':
      case 'issuer-oobi-unavailable':
      case 'signify-initialization-failed':
        return { kind: 'InfrastructureUnavailable', dependency: 'Keria' };
      case 'challenge-response-invalid':
        return {
          kind: 'RegistrationRejected',
          disposition: 'ProofRejected',
          detail: cause.message,
        };
      case 'credential-delivery-invalid':
      case 'registry-conflict':
      case 'end-role-conflict':
      case 'issuer-oobi-invalid':
      case 'user-oobi-invalid':
        return {
          kind: 'RecoveryRequired',
          reason: 'IdentityConflict',
          detail: cause.message,
        };
    }
  }
  return { kind: 'InfrastructureUnavailable', dependency: 'Keria' };
}

function registrationRejection(cause: unknown): RegistrationRejectedOutcome | undefined {
  if (cause instanceof IssuerRegistrationHttpFailure) {
    if (cause.detail.kind !== 'registration-rejected') {
      return undefined;
    }
    switch (cause.detail.error) {
      case 'registration-expired':
        return { kind: 'RegistrationRejected', disposition: 'Expired' };
      case 'registration-rejected':
        return { kind: 'RegistrationRejected', disposition: 'Rejected' };
      case 'aid-proof-rejected':
        return { kind: 'RegistrationRejected', disposition: 'ProofRejected' };
      case 'aid-proof-replayed':
        return { kind: 'RegistrationRejected', disposition: 'ProofReplayed' };
      case 'registration-unavailable':
      case 'registration-conflict':
      case 'request-invalid':
      case 'rate-limited':
        return undefined;
    }
  }
  if (cause instanceof IdentityFailure && cause.detail.kind === 'challenge-response-invalid') {
    return {
      kind: 'RegistrationRejected',
      disposition: 'ProofRejected',
      detail: cause.message,
    };
  }
  return undefined;
}

function trustedRegistrationBrowserUrl(browserUrl: string, registrationSiteUrl: string): boolean {
  try {
    const parsed = new URL(browserUrl);
    return (
      parsed.origin === registrationSiteUrl &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.pathname === '/' &&
      parsed.search.length === 0
    );
  } catch {
    return false;
  }
}

function identityFileRecoveryReason(
  failure: IdentityFileFailure,
): 'CustodyUnavailable' | 'ProfileUnavailable' | 'IdentityConflict' {
  if (failure.detail.kind === 'identity-file-conflict') {
    return 'IdentityConflict';
  }
  return failure.detail.file === 'custody' ? 'CustodyUnavailable' : 'ProfileUnavailable';
}
import { randomBytes } from 'node:crypto';
