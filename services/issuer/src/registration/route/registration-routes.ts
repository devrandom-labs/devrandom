import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { IssuerOobi } from '@devrandom/identity';
import {
  browserApprovalRequestSchema,
  browserMutationHeadersSchema,
  browserRegistrationProjectionSchema,
  cliRegistrationProjectionSchema,
  createRegistrationRequestSchema,
  createRegistrationResponseSchema,
  registrationCapabilityHeadersSchema,
  registrationCreationHeadersSchema,
  registrationErrorSchema,
  registrationPathParametersSchema,
  registrationRejectionRequestSchema,
  submitAidProofRequestSchema,
  type BrowserRegistrationProjection,
  type CliRegistrationProjection,
} from '@devrandom/protocol';
import type { FastifyReply } from 'fastify';
import Type, { type TSchema } from 'typebox';

import { RegistrationEnrollmentFailure } from '../application/registration-enrollment.js';
import {
  browserRegistrationProjection,
  cliRegistrationProjection,
} from '../application/registration-projection.js';
import type { UserRegistrationConversation } from '../application/user-registration.js';
import type { RegistrationRequestQuota } from './registration-request-quota.js';

export interface RegistrationRoutesConfiguration {
  readonly enrollment: UserRegistrationConversation;
  readonly browserOrigin: string;
  readonly issuerOobi: IssuerOobi;
  readonly quota: RegistrationRequestQuota;
}

const noStoreHeader = { 'Cache-Control': Type.Literal('no-store') };
const rateLimitHeaders = {
  ...noStoreHeader,
  'Retry-After': Type.String({ pattern: '^[1-9][0-9]*$' }),
};

function noStoreResponse<Schema extends TSchema>(schema: Schema) {
  return { ...schema, headers: noStoreHeader };
}

function rateLimitedResponse<Schema extends TSchema>(schema: Schema) {
  return { ...schema, headers: rateLimitHeaders };
}

const errorResponses = {
  404: noStoreResponse(registrationErrorSchema),
  409: noStoreResponse(registrationErrorSchema),
  410: noStoreResponse(registrationErrorSchema),
  422: noStoreResponse(registrationErrorSchema),
  429: rateLimitedResponse(registrationErrorSchema),
  503: noStoreResponse(registrationErrorSchema),
};

export function registrationRoutes(
  configuration: RegistrationRoutesConfiguration,
): FastifyPluginCallbackTypebox {
  return (server, _options, done) => {
    server.addHook('onSend', (_request, reply, payload, next) => {
      void reply.header('cache-control', 'no-store');
      next(null, payload);
    });

    server.post(
      '/registrations',
      {
        schema: {
          operationId: 'createRegistration',
          body: createRegistrationRequestSchema,
          headers: registrationCreationHeadersSchema,
          response: {
            200: noStoreResponse(createRegistrationResponseSchema),
            201: noStoreResponse(createRegistrationResponseSchema),
            422: noStoreResponse(registrationErrorSchema),
            429: rateLimitedResponse(registrationErrorSchema),
            503: noStoreResponse(registrationErrorSchema),
          },
        },
      },
      async (request, reply) => {
        if (!admitRequest(configuration, request.ip, 'create', reply)) {
          return;
        }
        try {
          const creation = await configuration.enrollment.create(
            request.body,
            request.headers['idempotency-key'],
          );
          await reply
            .code(creation.kind === 'registration-created' ? 201 : 200)
            .send(creation.response);
        } catch (cause) {
          await sendRegistrationFailure(cause, reply);
        }
      },
    );

    server.get(
      '/registrations/:registrationId',
      {
        schema: {
          operationId: 'getRegistration',
          params: registrationPathParametersSchema,
          headers: registrationCapabilityHeadersSchema,
          response: { 200: noStoreResponse(cliRegistrationProjectionSchema), ...errorResponses },
        },
      },
      async (request, reply) => {
        if (!admitRequest(configuration, request.ip, 'get-registration', reply)) {
          return;
        }
        try {
          const current = await configuration.enrollment.cliSession(
            request.params.registrationId,
            request.headers['x-devrandom-registration-capability'],
          );
          await reply
            .code(200)
            .send(cliRegistrationProjection(current.session, configuration.issuerOobi));
        } catch (cause) {
          await sendRegistrationFailure(cause, reply);
        }
      },
    );

    server.post(
      '/registrations/:registrationId/aid-proof',
      {
        schema: {
          operationId: 'submitAidProof',
          params: registrationPathParametersSchema,
          headers: registrationCapabilityHeadersSchema,
          body: submitAidProofRequestSchema,
          response: {
            200: noStoreResponse(cliRegistrationProjectionSchema),
            202: noStoreResponse(cliRegistrationProjectionSchema),
            ...errorResponses,
          },
        },
      },
      async (request, reply) => {
        if (!admitRequest(configuration, request.ip, 'submit-aid-proof', reply)) {
          return;
        }
        try {
          const current = await configuration.enrollment.submitAidProof(
            request.params.registrationId,
            request.headers['x-devrandom-registration-capability'],
            request.body,
          );
          const projection = cliRegistrationProjection(current.session, configuration.issuerOobi);
          await reply.code(mutationStatus(projection)).send(projection);
        } catch (cause) {
          await sendRegistrationFailure(cause, reply);
        }
      },
    );

    server.get(
      '/registrations/:registrationId/approval',
      {
        schema: {
          operationId: 'getRegistrationApproval',
          params: registrationPathParametersSchema,
          headers: registrationCapabilityHeadersSchema,
          response: {
            200: noStoreResponse(browserRegistrationProjectionSchema),
            ...errorResponses,
          },
        },
      },
      async (request, reply) => {
        if (!admitRequest(configuration, request.ip, 'get-approval', reply)) {
          return;
        }
        try {
          const current = await configuration.enrollment.browserSession(
            request.params.registrationId,
            request.headers['x-devrandom-registration-capability'],
          );
          await reply.code(200).send(browserRegistrationProjection(current.session));
        } catch (cause) {
          await sendRegistrationFailure(cause, reply);
        }
      },
    );

    server.post(
      '/registrations/:registrationId/approval',
      {
        schema: {
          operationId: 'approveRegistration',
          params: registrationPathParametersSchema,
          headers: browserMutationHeadersSchema,
          body: browserApprovalRequestSchema,
          response: {
            200: noStoreResponse(browserRegistrationProjectionSchema),
            202: noStoreResponse(browserRegistrationProjectionSchema),
            ...errorResponses,
          },
        },
      },
      async (request, reply) => {
        if (!admitRequest(configuration, request.ip, 'approve', reply)) {
          return;
        }
        if (!validBrowserMetadata(request.raw.headers, configuration.browserOrigin)) {
          await reply.code(422).send({ error: 'request-invalid' });
          return;
        }
        try {
          const current = await configuration.enrollment.approve(
            request.params.registrationId,
            request.headers['x-devrandom-registration-capability'],
            request.body,
          );
          const projection = browserRegistrationProjection(current.session);
          await reply.code(mutationStatus(projection)).send(projection);
        } catch (cause) {
          await sendRegistrationFailure(cause, reply);
        }
      },
    );

    server.post(
      '/registrations/:registrationId/rejection',
      {
        schema: {
          operationId: 'rejectRegistration',
          params: registrationPathParametersSchema,
          headers: browserMutationHeadersSchema,
          body: registrationRejectionRequestSchema,
          response: {
            200: noStoreResponse(browserRegistrationProjectionSchema),
            202: noStoreResponse(browserRegistrationProjectionSchema),
            ...errorResponses,
          },
        },
      },
      async (request, reply) => {
        if (!admitRequest(configuration, request.ip, 'reject', reply)) {
          return;
        }
        if (!validBrowserMetadata(request.raw.headers, configuration.browserOrigin)) {
          await reply.code(422).send({ error: 'request-invalid' });
          return;
        }
        try {
          const current = await configuration.enrollment.reject(
            request.params.registrationId,
            request.headers['x-devrandom-registration-capability'],
          );
          const projection = browserRegistrationProjection(current.session);
          await reply.code(mutationStatus(projection)).send(projection);
        } catch (cause) {
          await sendRegistrationFailure(cause, reply);
        }
      },
    );

    done();
  };
}

function validBrowserMetadata(
  headers: Readonly<NodeJS.Dict<string | string[]>>,
  expectedOrigin: string,
): boolean {
  return (
    headers.origin === expectedOrigin &&
    headers['sec-fetch-site'] === 'same-origin' &&
    headers['sec-fetch-mode'] === 'cors' &&
    headers['sec-fetch-dest'] === 'empty'
  );
}

function admitRequest(
  configuration: RegistrationRoutesConfiguration,
  remoteAddress: string,
  operation: string,
  reply: FastifyReply,
): boolean {
  const admission = configuration.quota.admit(`${remoteAddress}:${operation}`);
  if (admission.kind === 'registration-request-admitted') {
    return true;
  }
  void reply
    .header('retry-after', String(admission.retryAfterSeconds))
    .code(429)
    .send({ error: 'rate-limited' });
  return false;
}

async function sendRegistrationFailure(cause: unknown, reply: FastifyReply): Promise<void> {
  if (!(cause instanceof RegistrationEnrollmentFailure)) {
    reply.log.error('Registration request failed');
    await reply.code(503).send({ error: 'registration-unavailable' });
    return;
  }
  switch (cause.detail.kind) {
    case 'registration-unavailable':
      await reply.code(404).send({ error: 'registration-unavailable' });
      return;
    case 'registration-conflict':
      await reply.code(409).send({ error: 'registration-conflict' });
      return;
    case 'aid-proof-rejected':
      await reply.code(422).send({ error: 'aid-proof-rejected' });
      return;
    case 'aid-proof-replayed':
      await reply.code(422).send({ error: 'aid-proof-replayed' });
      return;
    case 'registration-expired':
      await reply.code(410).send({ error: 'registration-expired' });
      return;
    case 'registration-rejected':
      await reply.code(422).send({ error: 'registration-rejected' });
      return;
    case 'request-invalid':
      await reply.code(422).send({ error: 'request-invalid' });
  }
}

function mutationStatus(
  projection: CliRegistrationProjection | BrowserRegistrationProjection,
): 200 | 202 {
  switch (projection.kind) {
    case 'pending-proof':
    case 'pending-approval':
    case 'approved':
    case 'issuing':
      return 202;
    case 'issued':
    case 'rejected':
    case 'expired':
      return 200;
  }
}
