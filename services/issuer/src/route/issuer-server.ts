import swagger from '@fastify/swagger';
import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify, { LogController } from 'fastify';

import { credentialSchema } from '@devrandom/protocol';

import type { VerifiedDevrandomIssuer } from '../domain/verified-devrandom-issuer.js';
import {
  registrationRoutes,
  type RegistrationRoutesConfiguration,
} from '../registration/route/registration-routes.js';
import { healthRoute, type IssuerReadinessProbe } from './health-route.js';
import { schemaOobiRoute } from './schema-oobi-route.js';

export type IssuerServerRegistration = Omit<RegistrationRoutesConfiguration, 'issuerOobi'>;

export function buildIssuerServer(
  issuer: VerifiedDevrandomIssuer,
  registration: IssuerServerRegistration,
  readiness: IssuerReadinessProbe,
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
        title: 'Devrandom issuer service',
        version: '0.0.0',
      },
    },
    convertConstToEnum: false,
  });

  void server.register(
    healthRoute(readiness, {
      issuerAid: issuer.profile.issuerAid,
      issuerOobi: issuer.profile.issuerOobi,
      registryId: issuer.profile.registryId,
      schemaId: credentialSchema.$id,
    }),
  );
  void server.register(schemaOobiRoute);
  void server.register(
    registrationRoutes({ ...registration, issuerOobi: issuer.profile.issuerOobi }),
  );

  return server;
}
