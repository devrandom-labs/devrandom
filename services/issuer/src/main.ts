#!/usr/bin/env node

import { bootstrapDevrandomIssuer } from './application/issuer-bootstrap.js';
import { IssuerReadiness } from './application/issuer-readiness.js';
import { startDevrandomIssuer } from './application/issuer-startup.js';
import { credentialSchema } from '@devrandom/protocol';
import { MongoClient } from 'mongodb';
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
import { buildIssuerServer } from './route/issuer-server.js';
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

async function runBootstrap(environment: IssuerEnvironment): Promise<number> {
  let configuration;
  try {
    configuration = loadIssuerBootstrapConfiguration(environment);
  } catch (cause) {
    if (cause instanceof IssuerFailure) {
      process.stderr.write(`${issuerErrorMessage(cause.detail)}\n`);
      return issuerErrorExitCode(cause.detail);
    }
    process.stderr.write('issuer bootstrap failed during configuration decoding\n');
    return 2;
  }

  const result = await bootstrapDevrandomIssuer(configuration);
  switch (result.kind) {
    case 'issuer-provisioned':
    case 'existing-issuer-verified':
      process.stdout.write(`${bootstrapSummary(result.kind, result.profile)}\n`);
      return 0;
    case 'issuer-bootstrap-rejected':
      process.stderr.write(`${issuerErrorMessage(result.error)}\n`);
      return issuerErrorExitCode(result.error);
  }
}

async function runServe(environment: IssuerEnvironment): Promise<number> {
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
    await sessions.prepare();
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
  const server = buildIssuerServer(
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
  );
  try {
    await server.listen(address);
    await result.infrastructure.credentialSchema.resolve(
      registrationConfiguration.credentialSchemaOobiUrl,
    );
  } catch (cause) {
    await server.close();
    await mongo.close();
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
      void Promise.all([server.close(), mongo.close()]).then(
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
  process.exitCode = await runBootstrap(issuerEnvironment(process.env));
} else if (command === 'serve' && argumentsAfterCommand.length === 0) {
  process.exitCode = await runServe(issuerEnvironment(process.env));
} else {
  process.stderr.write('usage: devrandom-issuer <bootstrap|serve>\n');
  process.exitCode = 2;
}
