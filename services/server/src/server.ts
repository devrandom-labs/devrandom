import { randomUUID } from 'node:crypto';

import swagger from '@fastify/swagger';
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { LogController } from 'fastify';

import { credentialSchema } from '@devrandom/protocol';

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
      acceptBatch: () => Promise.resolve(unavailable),
      reconcileSeal: () => Promise.resolve(unavailable),
      inspectTimeline: () => Promise.resolve(unavailable),
    },
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
  void server.register(schemaOobiRoute);
  void server.register(
    registrationRoutes({ ...registration, issuerOobi: issuer.profile.issuerOobi }),
  );

  return server;
}
