import { randomUUID } from 'node:crypto';

import swagger from '@fastify/swagger';
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { LogController } from 'fastify';

import { credentialSchema } from '@devrandom/protocol';
import {
  activationRoutes,
  type ActivationRoutesConfiguration,
} from './activation/route/activation-routes.js';

import {
  manifestWorkAccessPolicy,
  workAccessPolicy,
  type WorkAccessPolicyManifest,
} from './access/domain/work-access-policy.js';
import {
  type WorkAccessRoutesConfiguration,
  workAccessRoutes,
} from './access/route/work-access-routes.js';
import {
  evidenceRoutes,
  type EvidenceRoutesConfiguration,
} from './evidence/route/evidence-routes.js';
import {
  terminalCalibrationRoutes,
  type TerminalCalibrationRoutesConfiguration,
} from './evidence/route/terminal-calibration-routes.js';
import {
  evidenceReadRoutes,
  type EvidenceReadRoutesConfiguration,
} from './evidence/route/evidence-read-routes.js';
import {
  evaluationRoutes,
  type EvaluationRoutesConfiguration,
} from './evaluation/route/evaluation-routes.js';
import {
  experienceRoutes,
  type ExperienceRoutesConfiguration,
} from './experience/route/experience-routes.js';
import { harnessRoutes, type HarnessRoutesConfiguration } from './harness/route/harness-routes.js';
import type { VerifiedDevrandomIssuer } from './domain/verified-devrandom-issuer.js';
import { mandateRoutes, type MandateRoutesConfiguration } from './mandate/route/mandate-routes.js';
import {
  registrationRoutes,
  type RegistrationRoutesConfiguration,
} from './registration/route/registration-routes.js';
import { healthRoute, type IssuerReadinessProbe } from './route/health-route.js';
import { problemMediaOpenApiTransform } from './route/problem-media.js';
import {
  type HostedWorkReadinessProbe,
  serverReadinessRoute,
} from './route/server-readiness-route.js';
import { schemaOobiRoute } from './route/schema-oobi-route.js';
import { runRoutes, type RunRoutesConfiguration } from './run/route/run-routes.js';
import { type TaskRoutesConfiguration, taskRoutes } from './task/route/task-routes.js';

export type DevrandomServerRegistration = Omit<RegistrationRoutesConfiguration, 'issuerOobi'>;

export type HostedWorkCapabilities =
  | {
      readonly kind: 'Available';
      readonly access: WorkAccessRoutesConfiguration;
      readonly tasks: TaskRoutesConfiguration;
      readonly mandates: MandateRoutesConfiguration;
      readonly harness: HarnessRoutesConfiguration;
      readonly runs: RunRoutesConfiguration;
      readonly evidence: EvidenceRoutesConfiguration;
      readonly terminalCalibration?: TerminalCalibrationRoutesConfiguration;
      readonly evaluation?: EvaluationRoutesConfiguration;
      readonly evidenceReading?: EvidenceReadRoutesConfiguration;
      readonly experience?: ExperienceRoutesConfiguration;
      readonly activation?: ActivationRoutesConfiguration;
    }
  | { readonly kind: 'Unavailable' };

const hostedWorkUnavailable: HostedWorkCapabilities = { kind: 'Unavailable' };
const defaultWorkAccessPolicyManifest = manifestWorkAccessPolicy(workAccessPolicy);

function unavailableWorkAccessRoutes(): WorkAccessRoutesConfiguration {
  const unavailable = { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
  return {
    conversation: {
      create: () => Promise.resolve(unavailable),
      submitProof: () => Promise.resolve(unavailable),
      observe: () => Promise.resolve(unavailable),
      release: () => Promise.resolve(unavailable),
    },
    newCorrelationId: randomUUID,
  };
}

function unavailableTaskRoutes(): TaskRoutesConfiguration {
  const unavailable = { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
  return {
    access: {
      authorize: () =>
        Promise.resolve({
          kind: 'TaskAccessUnavailable',
          dependency: 'HostedMongoDB',
        }),
    },
    conversation: {
      create: () => Promise.resolve(unavailable),
      list: () => Promise.resolve(unavailable),
      inspect: () => Promise.resolve(unavailable),
    },
    now: () => new Date().toISOString(),
    newCorrelationId: randomUUID,
  };
}

function unavailableMandateRoutes(): MandateRoutesConfiguration {
  const unavailable = { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
  return {
    access: {
      authorize: () =>
        Promise.resolve({
          kind: 'MandateAccessUnavailable',
          dependency: 'HostedMongoDB',
        }),
    },
    conversation: { present: () => Promise.resolve(unavailable) },
    now: () => new Date().toISOString(),
    newCorrelationId: randomUUID,
  };
}

function unavailableHarnessRoutes(): HarnessRoutesConfiguration {
  const unavailable = { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
  return {
    access: {
      authorize: () =>
        Promise.resolve({
          kind: 'HarnessAccessUnavailable',
          dependency: 'HostedMongoDB',
        }),
    },
    conversation: { admit: () => Promise.resolve(unavailable) },
    now: () => new Date().toISOString(),
    newCorrelationId: randomUUID,
  };
}

function unavailableRunRoutes(): RunRoutesConfiguration {
  const unavailable = { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
  return {
    access: {
      authorize: () =>
        Promise.resolve({ kind: 'RunAccessUnavailable', dependency: 'HostedMongoDB' }),
    },
    conversation: {
      admit: () => Promise.resolve(unavailable),
      inspect: () => Promise.resolve(unavailable),
      acquireLease: () => Promise.resolve(unavailable),
      renewLease: () => Promise.resolve(unavailable),
    },
    now: () => new Date().toISOString(),
    newCorrelationId: randomUUID,
  };
}

function unavailableEvidenceRoutes(): EvidenceRoutesConfiguration {
  const unavailable = { kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' } as const;
  return {
    access: {
      authorize: () =>
        Promise.resolve({ kind: 'EvidenceAccessUnavailable', dependency: 'HostedMongoDB' }),
    },
    conversation: {
      admitArtifact: () => Promise.resolve(unavailable),
      readArtifact: () => Promise.resolve({ kind: 'Unavailable' }),
      acceptBatch: () => Promise.resolve(unavailable),
      reconcileSeal: () => Promise.resolve(unavailable),
      inspectTimeline: () => Promise.resolve(unavailable),
    },
    now: () => new Date().toISOString(),
    newCorrelationId: randomUUID,
  };
}

function unavailableEvaluationRoutes(): EvaluationRoutesConfiguration {
  const unavailable = { kind: 'Unavailable' } as const;
  return {
    access: { authorize: () => Promise.resolve(unavailable) },
    preparation: { prepare: () => Promise.resolve('Unavailable') },
    admission: { admit: () => Promise.resolve(unavailable) },
    manifest: {
      lock: () => Promise.resolve(unavailable),
      inspect: () => Promise.resolve(unavailable),
    },
    leases: { renew: () => Promise.resolve(unavailable) },
    evidence: {
      accept: () => Promise.resolve(unavailable),
      close: () => Promise.resolve(unavailable),
    },
    now: () => new Date().toISOString(),
    newCorrelationId: randomUUID,
  };
}

function unavailableTerminalCalibrationRoutes(): TerminalCalibrationRoutesConfiguration {
  return {
    access: unavailableEvidenceRoutes().access,
    reconciliation: {
      reconcile: () =>
        Promise.resolve({ kind: 'DependencyUnavailable', dependency: 'HostedMongoDB' }),
    },
    now: () => new Date().toISOString(),
    newCorrelationId: randomUUID,
  };
}

function unavailableEvidenceReadRoutes(): EvidenceReadRoutesConfiguration {
  return {
    access: { authorize: () => Promise.resolve({ kind: 'Unavailable' }) },
    conversation: { read: () => Promise.resolve({ kind: 'Unavailable' }) },
    now: () => new Date().toISOString(),
    newCorrelationId: randomUUID,
  };
}

function unavailableExperienceRoutes(): ExperienceRoutesConfiguration {
  return {
    access: { authorize: () => Promise.resolve({ kind: 'Unavailable' }) },
    conversation: {
      retrieve: () => Promise.resolve({ kind: 'Unavailable' }),
      readReceipt: () => Promise.resolve({ kind: 'Unavailable' }),
    },
    now: () => new Date().toISOString(),
    newCorrelationId: randomUUID,
  };
}

function unavailableActivationRoutes(): ActivationRoutesConfiguration {
  return {
    access: { authorize: () => Promise.resolve({ kind: 'Unavailable' }) },
    activation: { commit: () => Promise.resolve({ kind: 'Unavailable' }) },
    reading: { readCurrent: () => Promise.resolve({ kind: 'Unavailable' }) },
    now: () => new Date().toISOString(),
    newCorrelationId: randomUUID,
  };
}

export function buildDevrandomServer(
  issuer: VerifiedDevrandomIssuer,
  registration: DevrandomServerRegistration,
  readiness: IssuerReadinessProbe,
  hostedWorkReadiness: HostedWorkReadinessProbe,
  hostedWork: HostedWorkCapabilities = hostedWorkUnavailable,
  workAccessPolicyManifest: WorkAccessPolicyManifest = defaultWorkAccessPolicyManifest,
) {
  const server = Fastify({
    logger: true,
    logController: new LogController({ disableRequestLogging: true }),
  }).withTypeProvider<TypeBoxTypeProvider>();
  server.decorate('devrandomIssuer', issuer);

  void server.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Devrandom Server',
        version: '0.0.0',
      },
    },
    convertConstToEnum: false,
    transform: problemMediaOpenApiTransform,
  });

  void server.register(
    healthRoute(readiness, {
      issuerAid: issuer.profile.issuerAid,
      issuerOobi: issuer.profile.issuerOobi,
      registryId: issuer.profile.registryId,
      schemaId: credentialSchema.$id,
    }),
  );
  void server.register(serverReadinessRoute(hostedWorkReadiness, workAccessPolicyManifest));
  void server.register(
    workAccessRoutes(
      hostedWork.kind === 'Available' ? hostedWork.access : unavailableWorkAccessRoutes(),
    ),
  );
  void server.register(
    taskRoutes(hostedWork.kind === 'Available' ? hostedWork.tasks : unavailableTaskRoutes()),
  );
  void server.register(
    mandateRoutes(
      hostedWork.kind === 'Available' ? hostedWork.mandates : unavailableMandateRoutes(),
    ),
  );
  void server.register(
    harnessRoutes(
      hostedWork.kind === 'Available' ? hostedWork.harness : unavailableHarnessRoutes(),
    ),
  );
  void server.register(
    runRoutes(hostedWork.kind === 'Available' ? hostedWork.runs : unavailableRunRoutes()),
  );
  void server.register(
    evidenceRoutes(
      hostedWork.kind === 'Available' ? hostedWork.evidence : unavailableEvidenceRoutes(),
    ),
  );
  void server.register(
    evaluationRoutes(
      hostedWork.kind === 'Available' && hostedWork.evaluation !== undefined
        ? hostedWork.evaluation
        : unavailableEvaluationRoutes(),
    ),
  );
  void server.register(
    terminalCalibrationRoutes(
      hostedWork.kind === 'Available' && hostedWork.terminalCalibration !== undefined
        ? hostedWork.terminalCalibration
        : unavailableTerminalCalibrationRoutes(),
    ),
  );
  void server.register(
    evidenceReadRoutes(
      hostedWork.kind === 'Available' && hostedWork.evidenceReading !== undefined
        ? hostedWork.evidenceReading
        : unavailableEvidenceReadRoutes(),
    ),
  );
  void server.register(
    experienceRoutes(
      hostedWork.kind === 'Available' && hostedWork.experience !== undefined
        ? hostedWork.experience
        : unavailableExperienceRoutes(),
    ),
  );
  void server.register(
    activationRoutes(
      hostedWork.kind === 'Available' && hostedWork.activation !== undefined
        ? hostedWork.activation
        : unavailableActivationRoutes(),
    ),
  );
  void server.register(schemaOobiRoute);
  void server.register(
    registrationRoutes({ ...registration, issuerOobi: issuer.profile.issuerOobi }),
  );

  return server;
}
