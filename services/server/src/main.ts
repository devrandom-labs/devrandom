#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

import { MongoClient } from 'mongodb';

import {
  createWorkAccessAttempt,
  type CreateWorkAccessAttemptDependencies,
} from './access/application/create-work-access-attempt.js';
import { observeWorkAccessAttempt } from './access/application/observe-work-access-attempt.js';
import { releaseWorkAccessGrantCapability } from './access/application/release-work-access-grant.js';
import { submitWorkAccessProof } from './access/application/submit-work-access-proof.js';
import { issuerWorkAccessChallengeProof } from './access/infrastructure/issuer-work-access-challenge.js';
import { issuerWorkAccessCredentialVerification } from './access/infrastructure/issuer-work-access-credential.js';
import { MongoWorkAccessAttempts } from './access/infrastructure/mongo-work-access-attempts.js';
import { MongoWorkAccessBootstrap } from './access/infrastructure/mongo-work-access-bootstrap.js';
import { BoundedWorkAccessAttemptQuota } from './access/route/bounded-work-access-attempt-quota.js';
import type { WorkAccessRoutesConfiguration } from './access/route/work-access-routes.js';
import { manifestWorkAccessPolicy, workAccessPolicy } from './access/domain/work-access-policy.js';
import { bootstrapDevrandomIssuer } from './application/issuer-bootstrap.js';
import { IssuerReadiness } from './application/issuer-readiness.js';
import { startDevrandomIssuer } from './application/issuer-startup.js';
import {
  credentialSchema,
  taskMandateV2SchemaSaid,
  promotionMandateV2SchemaSaid,
  promotionMandateV3SchemaSaid,
  verifyMandateSchemaCatalog,
} from '@devrandom/protocol';
import {
  HostedWorkConfigurationFailure,
  loadHostedWorkConfiguration,
  loadTaskCursorKey,
  type HostedWorkEnvironment,
} from './configuration/hosted-work-environment.js';
import {
  loadAtlasExperienceConfiguration,
  type AtlasExperienceEnvironment,
} from './configuration/atlas-experience-environment.js';
import { createHostedWorkMongoClient } from './configuration/hosted-work-mongo.js';
import { composeHostedActivation } from './activation/composition/hosted-activation.js';
import type { DevrandomIssuerProfile } from './domain/devrandom-issuer-profile.js';
import type { IssuerServerAddress } from './domain/issuer-configuration.js';
import { IssuerFailure, issuerErrorExitCode, issuerErrorMessage } from './domain/issuer-error.js';
import {
  issuerEnvironment,
  loadIssuerBootstrapConfiguration,
  loadIssuerRegistrationConfiguration,
  loadIssuerServerAddress,
  type IssuerEnvironment,
} from './infrastructure/environment-issuer-configuration.js';
import { buildDevrandomServer, type HostedWorkCapabilities } from './server.js';
import {
  RegistrationEnrollment,
  registrationEnrollmentDefaults,
} from './registration/application/registration-enrollment.js';
import { registrationCapabilityDerivation } from './registration/application/registration-capability.js';
import { RegistrationIssuance } from './registration/application/registration-issuance.js';
import { UserRegistration } from './registration/application/user-registration.js';
import { MongoRegistrationSessions } from './registration/infrastructure/mongo-registration-sessions.js';
import { RegistrationRequestQuota } from './registration/route/registration-request-quota.js';
import { devrandomIssuerAlias } from './domain/issuer-configuration.js';
import { acceptEvidenceBatch } from './evidence/application/accept-evidence-batch.js';
import { inspectEvidenceTimeline } from './evidence/application/inspect-evidence-timeline.js';
import { reconcileEvidenceSeal } from './evidence/application/reconcile-evidence-seal.js';
import { HmacEvidenceTimelineCursor } from './evidence/infrastructure/hmac-evidence-timeline-cursor.js';
import { issuerEvidenceSealExchanges } from './evidence/infrastructure/issuer-evidence-seal-exchanges.js';
import { MongoEvidenceArtifacts } from './evidence/infrastructure/mongo-evidence-artifacts.js';
import { MongoRunArtifactReading } from './evidence/infrastructure/mongo-run-artifact-reading.js';
import { MongoRunVerifierReceiptReading } from './evidence/infrastructure/mongo-run-verifier-receipt-reading.js';
import { MongoEvidenceBatches } from './evidence/infrastructure/mongo-evidence-batches.js';
import { MongoEvidenceBootstrap } from './evidence/infrastructure/mongo-evidence-bootstrap.js';
import { MongoEvidenceRunContexts } from './evidence/infrastructure/mongo-evidence-run-contexts.js';
import { MongoEvidenceSealContexts } from './evidence/infrastructure/mongo-evidence-seal-contexts.js';
import { MongoEvidenceSeals } from './evidence/infrastructure/mongo-evidence-seals.js';
import { MongoEvidenceTimelines } from './evidence/infrastructure/mongo-evidence-timelines.js';
import { workAccessEvidenceAuthorizer } from './evidence/infrastructure/work-access-evidence-authorizer.js';
import type { EvidenceRoutesConfiguration } from './evidence/route/evidence-routes.js';
import { composeHostedEvaluation } from './evaluation/composition/hosted-evaluation.js';
import {
  openServerAtlasExperience,
  type ServerAtlasExperience,
} from './experience/composition/server-atlas-experience.js';
import { MongoEvaluationBootstrap } from './evaluation/infrastructure/mongo-evaluation-bootstrap.js';
import type { HostedWorkReadinessProbe } from './route/server-readiness-route.js';
import { admitBaselineHarness } from './harness/application/admit-baseline-harness.js';
import { MongoHarnessBootstrap } from './harness/infrastructure/mongo-harness-bootstrap.js';
import { MongoHarnessRevisions } from './harness/infrastructure/mongo-harness-revisions.js';
import { workAccessHarnessAuthorizer } from './harness/infrastructure/work-access-harness-authorizer.js';
import type { HarnessRoutesConfiguration } from './harness/route/harness-routes.js';
import { MongoMandateBootstrap } from './mandate/infrastructure/mongo-mandate-bootstrap.js';
import { authorizeCurrentTaskMandate } from './mandate/application/current-task-mandate.js';
import { authorizeCurrentPromotionMandate } from './mandate/application/current-promotion-mandate.js';
import { presentMandate } from './mandate/application/present-mandate.js';
import { issuerMandateAdmission } from './mandate/infrastructure/issuer-mandate-admission.js';
import { issuerMandateUserCredential } from './mandate/infrastructure/issuer-mandate-user-credential.js';
import { MongoMandatePresentations } from './mandate/infrastructure/mongo-mandate-presentations.js';
import { workAccessMandateAuthorizer } from './mandate/infrastructure/work-access-mandate-authorizer.js';
import type { MandateRoutesConfiguration } from './mandate/route/mandate-routes.js';
import { acquireRunLease } from './run/application/acquire-run-lease.js';
import { admitRun } from './run/application/admit-run.js';
import { inspectRun } from './run/application/inspect-run.js';
import { renewHeldRunLease } from './run/application/renew-run-lease.js';
import type { CurrentRunMandates } from './run/application/run-authority.js';
import { MongoRunBootstrap } from './run/infrastructure/mongo-run-bootstrap.js';
import { MongoRuns } from './run/infrastructure/mongo-runs.js';
import { workAccessRunAuthorizer } from './run/infrastructure/work-access-run-authorizer.js';
import type { RunRoutesConfiguration } from './run/route/run-routes.js';
import { createTask, type CreateTaskDependencies } from './task/application/create-task.js';
import { inspectTaskByLabel, listTasks } from './task/application/inspect-tasks.js';
import { HmacTaskPageCursor } from './task/infrastructure/hmac-task-page-cursor.js';
import { issuerTaskCreationEligibility } from './task/infrastructure/issuer-task-creation-eligibility.js';
import { MongoTaskBootstrap } from './task/infrastructure/mongo-task-bootstrap.js';
import { MongoTasks } from './task/infrastructure/mongo-tasks.js';
import { workAccessTaskAuthorizer } from './task/infrastructure/work-access-task-authorizer.js';
import type { TaskRoutesConfiguration } from './task/route/task-routes.js';

type DevrandomServerEnvironment = IssuerEnvironment &
  HostedWorkEnvironment &
  AtlasExperienceEnvironment;

function devrandomServerEnvironment(environment: NodeJS.ProcessEnv): DevrandomServerEnvironment {
  return {
    ...issuerEnvironment(environment),
    DEVRANDOM_HOSTED_WORK_MONGODB_URI: environment.DEVRANDOM_HOSTED_WORK_MONGODB_URI,
    DEVRANDOM_WORK_ACCESS_GRANT_LIFETIME_SECONDS:
      environment.DEVRANDOM_WORK_ACCESS_GRANT_LIFETIME_SECONDS,
    DEVRANDOM_TASK_CURSOR_KEY: environment.DEVRANDOM_TASK_CURSOR_KEY,
    DEVRANDOM_ATLAS_URI: environment.DEVRANDOM_ATLAS_URI,
    DEVRANDOM_ATLAS_DATABASE: environment.DEVRANDOM_ATLAS_DATABASE,
    DEVRANDOM_ATLAS_MODEL_CACHE_DIRECTORY: environment.DEVRANDOM_ATLAS_MODEL_CACHE_DIRECTORY,
  };
}

function bootstrapSummary(kind: string, profile: DevrandomIssuerProfile): string {
  const outcome = kind === 'issuer-provisioned' ? 'provisioned' : 'verified';
  return [
    `Devrandom issuer ${outcome}.`,
    `Controller AID: ${profile.controllerAid}`,
    `Agent AID: ${profile.agentAid}`,
    `Issuer AID: ${profile.issuerAid}`,
    `Registry ID: ${profile.registryId}`,
    `Issuer OOBI: ${profile.issuerOobi}`,
    `Witness policy: ${profile.witnessPolicy.kind}`,
    `Registry policy: ${profile.registryPolicy.kind}`,
  ].join('\n');
}

async function runBootstrap(environment: DevrandomServerEnvironment): Promise<number> {
  let configuration;
  let registrationConfiguration;
  let hostedWorkConfiguration;
  try {
    configuration = loadIssuerBootstrapConfiguration(environment);
    registrationConfiguration = loadIssuerRegistrationConfiguration(environment);
    hostedWorkConfiguration = loadHostedWorkConfiguration(environment);
  } catch (cause) {
    if (cause instanceof IssuerFailure) {
      process.stderr.write(`${issuerErrorMessage(cause.detail)}\n`);
      return issuerErrorExitCode(cause.detail);
    }
    if (cause instanceof HostedWorkConfigurationFailure) {
      process.stderr.write(`${cause.message}\n`);
      return 2;
    }
    process.stderr.write('issuer bootstrap failed during configuration decoding\n');
    return 2;
  }

  const result = await bootstrapDevrandomIssuer(configuration);
  switch (result.kind) {
    case 'issuer-provisioned':
    case 'existing-issuer-verified': {
      const registrationMongo = new MongoClient(registrationConfiguration.mongodbUri);
      const hostedWorkMongo = createHostedWorkMongoClient(hostedWorkConfiguration.mongodbUri);
      let storageStage = 'registration';
      try {
        await registrationMongo.connect();
        await new MongoRegistrationSessions(
          registrationMongo.db(),
          registrationConfiguration.replayRetentionMs,
        ).bootstrap();
        storageStage = 'hosted-work connection';
        await hostedWorkMongo.connect();
        storageStage = 'work access';
        await new MongoWorkAccessBootstrap(
          hostedWorkMongo.db(),
          hostedWorkConfiguration.workAccessPolicy,
        ).bootstrap();
        storageStage = 'task';
        await new MongoTaskBootstrap(hostedWorkMongo.db()).bootstrap();
        storageStage = 'mandate';
        await new MongoMandateBootstrap(hostedWorkMongo.db()).bootstrap();
        storageStage = 'harness';
        await new MongoHarnessBootstrap(hostedWorkMongo.db()).bootstrap();
        storageStage = 'run';
        await new MongoRunBootstrap(hostedWorkMongo.db()).bootstrap();
        storageStage = 'evidence';
        await new MongoEvidenceBootstrap(hostedWorkMongo.db()).bootstrap();
        storageStage = 'evaluation';
        await new MongoEvaluationBootstrap(hostedWorkMongo.db()).bootstrap();
      } catch (cause) {
        const failure = cause instanceof Error ? cause.name : typeof cause;
        process.stderr.write(
          `Devrandom Server storage bootstrap failed at ${storageStage}: ${failure}\n`,
        );
        return 4;
      } finally {
        await Promise.all([registrationMongo.close(), hostedWorkMongo.close()]);
      }
      process.stdout.write(`${bootstrapSummary(result.kind, result.profile)}\n`);
      return 0;
    }
    case 'issuer-bootstrap-rejected':
      process.stderr.write(`${issuerErrorMessage(result.error)}\n`);
      return issuerErrorExitCode(result.error);
  }
}

async function runServe(environment: DevrandomServerEnvironment): Promise<number> {
  let configuration;
  let registrationConfiguration;
  let address: IssuerServerAddress;
  try {
    configuration = loadIssuerBootstrapConfiguration(environment);
    registrationConfiguration = loadIssuerRegistrationConfiguration(environment);
    address = loadIssuerServerAddress(environment);
  } catch (cause) {
    if (cause instanceof IssuerFailure) {
      process.stderr.write(`${issuerErrorMessage(cause.detail)}\n`);
      return issuerErrorExitCode(cause.detail);
    }
    process.stderr.write('issuer serve failed during configuration decoding\n');
    return 2;
  }

  const result = await startDevrandomIssuer(configuration);
  if (result.kind === 'issuer-startup-rejected') {
    process.stderr.write(`${issuerErrorMessage(result.error)}\n`);
    return issuerErrorExitCode(result.error);
  }

  const mongo = new MongoClient(registrationConfiguration.mongodbUri);
  const sessions = new MongoRegistrationSessions(
    mongo.db(),
    registrationConfiguration.replayRetentionMs,
  );
  try {
    await mongo.connect();
    await sessions.verify();
  } catch {
    await mongo.close();
    const failure = new IssuerFailure({
      kind: 'issuer-server-failed',
      reason: 'Registration Session repository is unavailable',
    });
    process.stderr.write(`${issuerErrorMessage(failure.detail)}\n`);
    return issuerErrorExitCode(failure.detail);
  }

  const capabilityDerivation = registrationCapabilityDerivation(configuration.bran);
  const enrollment = new RegistrationEnrollment(
    {
      issuerAid: result.issuer.identity.issuerAid,
      issuerOobi: result.issuer.identity.issuerOobi,
      registrationSiteUrl: registrationConfiguration.registrationSiteUrl,
      lifetimeMs: registrationConfiguration.lifetimeMs,
      pollIntervalMs: registrationConfiguration.pollIntervalMs,
      challengeOperationTimeoutMs: configuration.operationTimeoutMs,
    },
    {
      sessions,
      challenge: result.infrastructure.challengeProof,
      resolveUserOobi: async (resolution) => {
        await result.infrastructure.userOobiResolution.resolve(resolution);
      },
      issueCapabilities: (creationKey) => capabilityDerivation.issue(creationKey),
      ...registrationEnrollmentDefaults,
    },
  );
  const issuance = new RegistrationIssuance(
    {
      issuerAlias: devrandomIssuerAlias,
      registryId: result.issuer.identity.registryId,
      schemaId: credentialSchema.$id,
      operationTimeoutMs: configuration.operationTimeoutMs,
    },
    {
      sessions,
      credentialDelivery: result.infrastructure.credentialDelivery,
      now: registrationEnrollmentDefaults.now,
    },
  );
  const registration = new UserRegistration(enrollment, issuance);
  const readiness = new IssuerReadiness(
    result.infrastructure.readiness,
    result.infrastructure.credentialSchema,
    sessions,
  );
  let hostedWorkMongo: MongoClient | undefined;
  let hostedWorkCandidate: MongoClient | undefined;
  let serverAtlas: ServerAtlasExperience | undefined;
  let hostedWork: HostedWorkCapabilities = { kind: 'Unavailable' };
  let workAccessPolicyManifest = manifestWorkAccessPolicy(workAccessPolicy);
  let hostedWorkReadiness: HostedWorkReadinessProbe = {
    verify: () => Promise.reject(new Error('Hosted work has not been composed')),
  };
  try {
    const hostedWorkConfiguration = loadHostedWorkConfiguration(environment);
    workAccessPolicyManifest = manifestWorkAccessPolicy(hostedWorkConfiguration.workAccessPolicy);
    const taskCursorKey = loadTaskCursorKey(environment);
    hostedWorkCandidate = createHostedWorkMongoClient(hostedWorkConfiguration.mongodbUri, 5_000);
    await hostedWorkCandidate.connect();
    const hostedDatabase = hostedWorkCandidate.db();
    const workAccessBootstrap = new MongoWorkAccessBootstrap(
      hostedDatabase,
      hostedWorkConfiguration.workAccessPolicy,
    );
    const taskBootstrap = new MongoTaskBootstrap(hostedDatabase);
    const mandateBootstrap = new MongoMandateBootstrap(hostedDatabase);
    const harnessBootstrap = new MongoHarnessBootstrap(hostedDatabase);
    const runBootstrap = new MongoRunBootstrap(hostedDatabase);
    const evidenceBootstrap = new MongoEvidenceBootstrap(hostedDatabase);
    const evaluationBootstrap = new MongoEvaluationBootstrap(hostedDatabase);
    await workAccessBootstrap.verify();
    await taskBootstrap.verify();
    await mandateBootstrap.verify();
    await harnessBootstrap.verify();
    await runBootstrap.verify();
    await evidenceBootstrap.verify();
    await evaluationBootstrap.verify();
    serverAtlas = await openServerAtlasExperience(
      loadAtlasExperienceConfiguration(environment),
      hostedDatabase,
    );
    const attempts = new MongoWorkAccessAttempts(
      hostedDatabase,
      hostedWorkConfiguration.workAccessPolicy,
    );
    const workAccessDependencies: CreateWorkAccessAttemptDependencies = {
      issuerRecipientAid: result.issuer.identity.issuerAid,
      policy: hostedWorkConfiguration.workAccessPolicy,
      attempts,
      credential: issuerWorkAccessCredentialVerification(
        result.infrastructure.currentUserCredentialVerification,
      ),
      challenge: issuerWorkAccessChallengeProof(
        result.infrastructure.asynchronousChallengeProof,
        result.issuer.identity.issuerAid,
      ),
      quota: new BoundedWorkAccessAttemptQuota(),
      now: () => new Date().toISOString(),
      newAttemptId: randomUUID,
    };
    const accessRoutes: WorkAccessRoutesConfiguration = {
      conversation: {
        create: (input) => createWorkAccessAttempt(input, workAccessDependencies),
        submitProof: (input) => submitWorkAccessProof(input, workAccessDependencies),
        observe: (input) => observeWorkAccessAttempt(input, workAccessDependencies),
        release: (input) => releaseWorkAccessGrantCapability(input, workAccessDependencies),
      },
      newCorrelationId: randomUUID,
    };
    const tasks = new MongoTasks(hostedDatabase);
    const taskCreationDependencies: CreateTaskDependencies = {
      tasks,
      eligibility: issuerTaskCreationEligibility(
        result.infrastructure.currentUserCredentialVerification,
      ),
      now: () => new Date().toISOString(),
      newTaskId: randomUUID,
      newHarnessLineageId: randomUUID,
    };
    const taskCursors = new HmacTaskPageCursor(taskCursorKey);
    const taskRoutesConfiguration: TaskRoutesConfiguration = {
      access: workAccessTaskAuthorizer(attempts),
      conversation: {
        create: (input) => createTask(input, taskCreationDependencies),
        list: (input) => listTasks(input, { tasks, cursors: taskCursors }),
        inspect: (input) => inspectTaskByLabel(input, tasks),
      },
      now: () => new Date().toISOString(),
      newCorrelationId: randomUUID,
    };
    const mandatePresentations = new MongoMandatePresentations(hostedDatabase);
    const mandateUserCredential = issuerMandateUserCredential(
      result.infrastructure.currentUserCredentialVerification,
    );
    const mandateAdmission = issuerMandateAdmission(result.infrastructure.mandateAdmission);
    const currentTaskMandate = {
      authorize: (authorization: Parameters<typeof authorizeCurrentTaskMandate>[0]) =>
        authorizeCurrentTaskMandate(authorization, {
          issuerAid: result.issuer.identity.issuerAid,
          tasks,
          presentations: mandatePresentations,
          admission: mandateAdmission,
        }),
    };
    const mandateRoutesConfiguration: MandateRoutesConfiguration = {
      access: workAccessMandateAuthorizer(attempts),
      conversation: {
        present: (input) =>
          presentMandate(input, {
            presentations: mandatePresentations,
            eligibility: mandateUserCredential,
            admission: mandateAdmission,
            tasks,
            issuerAid: result.issuer.identity.issuerAid,
            now: () => new Date().toISOString(),
          }),
      },
      now: () => new Date().toISOString(),
      newCorrelationId: randomUUID,
    };
    const harnessRevisions = new MongoHarnessRevisions(hostedDatabase);
    const harnessRoutesConfiguration: HarnessRoutesConfiguration = {
      access: workAccessHarnessAuthorizer(attempts),
      conversation: {
        admit: (input) =>
          admitBaselineHarness(input, {
            currentUserCredential: mandateUserCredential,
            currentTaskMandate,
            revisions: harnessRevisions,
            now: () => new Date().toISOString(),
          }),
      },
      now: () => new Date().toISOString(),
      newCorrelationId: randomUUID,
    };
    const runs = new MongoRuns(hostedWorkCandidate, hostedDatabase);
    const currentRunMandates: CurrentRunMandates = {
      async authorize(authorization) {
        const current = await authorizeCurrentPromotionMandate(authorization, {
          issuerAid: result.issuer.identity.issuerAid,
          currentTaskMandate,
          presentations: mandatePresentations,
          admission: mandateAdmission,
        });
        if (current.kind !== 'CurrentPromotionMandateAuthorized') {
          return current;
        }
        return {
          kind: 'CurrentRunMandatesAuthorized',
          task: current.task,
          personalAgentAid: current.taskMandate.credential.issueeAid,
          taskMandateSaid: current.taskMandate.credential.credentialSaid,
          taskMandateBudget: current.taskMandate.budgets,
          governorAid: current.promotionMandate.credential.issueeAid,
          promotionMandateSaid: current.promotionMandate.credential.credentialSaid,
        };
      },
    };
    const runRoutesConfiguration: RunRoutesConfiguration = {
      access: workAccessRunAuthorizer(attempts),
      conversation: {
        admit: (input) =>
          admitRun(input, {
            currentUserCredential: mandateUserCredential,
            reservations: runs,
            exchange: result.infrastructure.runAdmissionExchange,
            harnesses: harnessRevisions,
            currentMandates: currentRunMandates,
            commitments: runs,
            now: () => new Date().toISOString(),
            newRunId: randomUUID,
            newEvidenceStreamId: randomUUID,
          }),
        inspect: (input) => inspectRun(input, runs),
        acquireLease: (input) =>
          acquireRunLease(input, {
            currentUserCredential: mandateUserCredential,
            leases: runs,
            now: () => new Date().toISOString(),
          }),
        renewLease: (input) =>
          renewHeldRunLease(input, {
            leases: runs,
            now: () => new Date().toISOString(),
          }),
      },
      now: () => new Date().toISOString(),
      newCorrelationId: randomUUID,
    };
    const evidenceRunContexts = new MongoEvidenceRunContexts(hostedDatabase);
    const evidenceArtifacts = new MongoEvidenceArtifacts(hostedWorkCandidate, hostedDatabase);
    const runArtifactReading = new MongoRunArtifactReading(hostedDatabase);
    const runVerifierReceiptReading = new MongoRunVerifierReceiptReading(hostedDatabase);
    const evidenceBatches = new MongoEvidenceBatches(hostedWorkCandidate, hostedDatabase);
    const evidenceSealContexts = new MongoEvidenceSealContexts(hostedDatabase);
    const evidenceSeals = new MongoEvidenceSeals(hostedWorkCandidate, hostedDatabase);
    const evidenceTimelines = new MongoEvidenceTimelines(hostedDatabase);
    const evidenceTimelineCursor = new HmacEvidenceTimelineCursor(taskCursorKey);
    const evidenceSealExchanges = issuerEvidenceSealExchanges(
      result.infrastructure.evidenceSealExchange,
    );
    const evidenceRoutesConfiguration: EvidenceRoutesConfiguration = {
      access: workAccessEvidenceAuthorizer(attempts),
      conversation: {
        admitArtifact: (input) => evidenceArtifacts.admit(input),
        readArtifact: (input) => runArtifactReading.read(input),
        readVerifierReceipt: (input) => runVerifierReceiptReading.read(input),
        acceptBatch: (input) =>
          acceptEvidenceBatch(input, {
            contexts: evidenceRunContexts,
            authority: currentTaskMandate,
            batches: evidenceBatches,
          }),
        reconcileSeal: (input) =>
          reconcileEvidenceSeal(input, {
            issuerAid: result.issuer.identity.issuerAid,
            contexts: evidenceSealContexts,
            exchanges: evidenceSealExchanges,
            seals: evidenceSeals,
          }),
        inspectTimeline: (input) =>
          inspectEvidenceTimeline(input, {
            cursor: evidenceTimelineCursor,
            timelines: evidenceTimelines,
          }),
      },
      now: () => new Date().toISOString(),
      newCorrelationId: randomUUID,
    };
    const hostedEvaluation = composeHostedEvaluation({
      client: hostedWorkCandidate,
      database: hostedDatabase,
      attempts,
      tasks,
      presentations: mandatePresentations,
      currentTaskMandate,
      issuerAid: result.issuer.identity.issuerAid,
      closureExchanges: result.infrastructure.evaluationClosureSealExchange,
      experienceSources: serverAtlas.sources,
      ...(serverAtlas.kind === 'Available'
        ? { experience: serverAtlas.experience, experienceReceipts: serverAtlas.receipts }
        : {}),
    });
    const hostedActivation = composeHostedActivation({
      client: hostedWorkCandidate,
      database: hostedDatabase,
      attempts,
      issuerAid: result.issuer.identity.issuerAid,
      issuerAlias: devrandomIssuerAlias,
      promotionExchanges: result.infrastructure.promotionExchanges,
      activationReceiptExchange: result.infrastructure.activationReceiptExchange,
      mandates: {
        authorize: (input) =>
          authorizeCurrentPromotionMandate(input, {
            issuerAid: result.issuer.identity.issuerAid,
            currentTaskMandate,
            presentations: mandatePresentations,
            admission: mandateAdmission,
          }),
      },
    });
    hostedWorkMongo = hostedWorkCandidate;
    hostedWorkCandidate = undefined;
    hostedWork = {
      kind: 'Available',
      access: accessRoutes,
      tasks: taskRoutesConfiguration,
      mandates: mandateRoutesConfiguration,
      harness: harnessRoutesConfiguration,
      runs: runRoutesConfiguration,
      evidence: evidenceRoutesConfiguration,
      ...hostedEvaluation,
      activation: hostedActivation,
    };
    hostedWorkReadiness = {
      async verify() {
        if (verifyMandateSchemaCatalog().kind !== 'Verified') {
          throw new Error('Mandate schema catalog does not match its SAIDs');
        }
        await workAccessBootstrap.verify();
        await taskBootstrap.verify();
        await mandateBootstrap.verify();
        await harnessBootstrap.verify();
        await runBootstrap.verify();
        await evidenceBootstrap.verify();
        await evaluationBootstrap.verify();
        await serverAtlas?.verify();
        await result.infrastructure.taskMandateSchemaAvailability.verify();
        await result.infrastructure.taskMandateV2SchemaAvailability.verify();
        await result.infrastructure.promotionMandateSchemaAvailability.verify();
        await result.infrastructure.promotionMandateV2SchemaAvailability.verify();
        await result.infrastructure.promotionMandateV3SchemaAvailability.verify();
      },
    };
  } catch {
    await serverAtlas?.close();
    await hostedWorkCandidate?.close();
  }
  const server = buildDevrandomServer(
    result.issuer,
    {
      enrollment: registration,
      browserOrigin: registrationConfiguration.registrationSiteUrl,
      quota: new RegistrationRequestQuota(
        registrationConfiguration.maximumRequestsPerMinute,
        60_000,
        registrationEnrollmentDefaults.now,
      ),
    },
    readiness,
    hostedWorkReadiness,
    hostedWork,
    workAccessPolicyManifest,
  );
  try {
    await server.listen(address);
    await result.infrastructure.credentialSchema.resolve(
      registrationConfiguration.credentialSchemaOobiUrl,
    );
    await result.infrastructure.taskMandateSchemaAvailability.resolve(
      registrationConfiguration.taskMandateSchemaOobiUrl,
    );
    const taskV2SchemaOobi = new URL(registrationConfiguration.taskMandateSchemaOobiUrl);
    taskV2SchemaOobi.pathname = `/oobi/${taskMandateV2SchemaSaid}`;
    await result.infrastructure.taskMandateV2SchemaAvailability.resolve(taskV2SchemaOobi.href);
    await result.infrastructure.promotionMandateSchemaAvailability.resolve(
      registrationConfiguration.promotionMandateSchemaOobiUrl,
    );
    const promotionV2SchemaOobi = new URL(registrationConfiguration.promotionMandateSchemaOobiUrl);
    promotionV2SchemaOobi.pathname = `/oobi/${promotionMandateV2SchemaSaid}`;
    await result.infrastructure.promotionMandateV2SchemaAvailability.resolve(
      promotionV2SchemaOobi.href,
    );
    const promotionV3SchemaOobi = new URL(registrationConfiguration.promotionMandateSchemaOobiUrl);
    promotionV3SchemaOobi.pathname = `/oobi/${promotionMandateV3SchemaSaid}`;
    await result.infrastructure.promotionMandateV3SchemaAvailability.resolve(
      promotionV3SchemaOobi.href,
    );
  } catch (cause) {
    await server.close();
    await mongo.close();
    await hostedWorkMongo?.close();
    await serverAtlas?.close();
    const failure = new IssuerFailure({
      kind: 'issuer-server-failed',
      reason: cause instanceof Error ? cause.message : 'unknown listener failure',
    });
    process.stderr.write(`${issuerErrorMessage(failure.detail)}\n`);
    return issuerErrorExitCode(failure.detail);
  }

  return new Promise<number>((resolve) => {
    const stop = (): void => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      const shutdown = [server.close(), mongo.close()];
      if (hostedWorkMongo !== undefined) {
        shutdown.push(hostedWorkMongo.close());
      }
      if (serverAtlas !== undefined) {
        shutdown.push(serverAtlas.close());
      }
      void Promise.all(shutdown).then(
        () => {
          resolve(0);
        },
        (cause: unknown) => {
          const failure = new IssuerFailure({
            kind: 'issuer-server-failed',
            reason: cause instanceof Error ? cause.message : 'unknown shutdown failure',
          });
          process.stderr.write(`${issuerErrorMessage(failure.detail)}\n`);
          resolve(issuerErrorExitCode(failure.detail));
        },
      );
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

const [command, ...argumentsAfterCommand] = process.argv.slice(2);
if (command === 'bootstrap' && argumentsAfterCommand.length === 0) {
  process.exitCode = await runBootstrap(devrandomServerEnvironment(process.env));
} else if (command === 'serve' && argumentsAfterCommand.length === 0) {
  process.exitCode = await runServe(devrandomServerEnvironment(process.env));
} else {
  process.stderr.write('usage: devrandom-server <bootstrap|serve>\n');
  process.exitCode = 2;
}
