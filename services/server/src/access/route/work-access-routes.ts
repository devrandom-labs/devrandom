import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import {
  createWorkAccessAttemptBodySchema,
  submitWorkAccessProofBodySchema,
  workAccessAttemptParametersSchema,
  workAccessAttemptProjectionSchema,
  workAccessAttemptExpiredProblemSchema,
  workAccessAuthorizationHeadersSchema,
  workAccessBodyTooLargeProblemSchema,
  workAccessCapabilityInvalidProblemSchema,
  workAccessCapacityProblemSchema,
  workAccessCommandConflictProblemSchema,
  workAccessConcurrentUpdateProblemSchema,
  workAccessCredentialRejectedProblemSchema,
  workAccessGrantReleaseConflictProblemSchema,
  workAccessProofConflictProblemSchema,
  workAccessProofRejectedProblemSchema,
  workAccessProofReplayedProblemSchema,
  workAccessRequestInvalidProblemSchema,
  workAccessUnavailableProblemSchema,
  type WorkAccessProblem,
  type WorkAccessRejectionReason,
} from '@devrandom/protocol';
import type { FastifyReply } from 'fastify';
import Type, { type TSchema } from 'typebox';
import Value from 'typebox/value';

import type {
  CreateWorkAccessAttemptInput,
  CreateWorkAccessAttemptOutcome,
} from '../application/create-work-access-attempt.js';
import type {
  ObserveWorkAccessAttemptInput,
  ObserveWorkAccessAttemptOutcome,
} from '../application/observe-work-access-attempt.js';
import type {
  SubmitWorkAccessProofInput,
  SubmitWorkAccessProofOutcome,
} from '../application/submit-work-access-proof.js';
import type {
  ReleaseWorkAccessGrantInput,
  ReleaseWorkAccessGrantOutcome,
} from '../application/release-work-access-grant.js';
import { workAccessPolicy } from '../domain/work-access-policy.js';

export interface WorkAccessConversation {
  create(input: CreateWorkAccessAttemptInput): Promise<CreateWorkAccessAttemptOutcome>;
  submitProof(input: SubmitWorkAccessProofInput): Promise<SubmitWorkAccessProofOutcome>;
  observe(input: ObserveWorkAccessAttemptInput): Promise<ObserveWorkAccessAttemptOutcome>;
  release(input: ReleaseWorkAccessGrantInput): Promise<ReleaseWorkAccessGrantOutcome>;
}

export interface WorkAccessRoutesConfiguration {
  readonly conversation: WorkAccessConversation;
  newCorrelationId(): string;
}

const noStoreHeader = { 'Cache-Control': Type.Literal('no-store') };

function noStoreResponse<Schema extends TSchema>(schema: Schema) {
  return { ...schema, headers: noStoreHeader };
}

function problemResponse<Schema extends TSchema>(schema: Schema) {
  return {
    headers: noStoreHeader,
    content: { 'application/problem+json': { schema } },
  };
}

const proofConflictResponseSchema = Type.Union([
  workAccessCommandConflictProblemSchema,
  workAccessProofConflictProblemSchema,
  workAccessProofReplayedProblemSchema,
  workAccessConcurrentUpdateProblemSchema,
]);

const proofRejectedResponseSchema = Type.Union([
  workAccessCredentialRejectedProblemSchema,
  workAccessProofRejectedProblemSchema,
]);

const responseSchemas = {
  400: problemResponse(workAccessRequestInvalidProblemSchema),
  200: noStoreResponse(workAccessAttemptProjectionSchema),
  202: noStoreResponse(workAccessAttemptProjectionSchema),
  401: problemResponse(workAccessCapabilityInvalidProblemSchema),
  403: problemResponse(proofRejectedResponseSchema),
  409: problemResponse(proofConflictResponseSchema),
  410: problemResponse(workAccessAttemptExpiredProblemSchema),
  413: problemResponse(workAccessBodyTooLargeProblemSchema),
  429: problemResponse(workAccessCapacityProblemSchema),
  503: problemResponse(workAccessUnavailableProblemSchema),
};

function bearerSecret(authorization: string): string {
  return authorization.slice('Bearer '.length);
}

type SimpleWorkAccessProblemCode = Exclude<
  WorkAccessProblem['code'],
  | 'WorkAccessProofRejected'
  | 'WorkAccessGrantExpired'
  | 'WorkAccessGrantRevoked'
  | 'WorkAccessGrantScopeRejected'
  | 'WorkAccessGrantConcurrentUpdate'
  | 'WorkAccessGrantExhausted'
  | 'WorkAccessGrantReleased'
>;

function problem(code: SimpleWorkAccessProblemCode, correlationId: string): WorkAccessProblem {
  switch (code) {
    case 'WorkAccessRequestInvalid':
      return {
        type: 'https://devrandom.example/problems/work-access-request-invalid',
        title: 'Work Access request is invalid',
        status: 400,
        code,
        correlationId,
      };
    case 'WorkAccessCapabilityInvalid':
      return {
        type: 'https://devrandom.example/problems/work-access-capability-invalid',
        title: 'Work Access capability is invalid',
        status: 401,
        code,
        correlationId,
      };
    case 'WorkAccessCredentialRejected':
      return {
        type: 'https://devrandom.example/problems/work-access-credential-rejected',
        title: 'User credential is not current',
        status: 403,
        code,
        correlationId,
      };
    case 'WorkAccessAttemptNotFound':
      return {
        type: 'https://devrandom.example/problems/work-access-attempt-not-found',
        title: 'Work Access Attempt was not found',
        status: 404,
        code,
        correlationId,
      };
    case 'WorkAccessCommandConflict':
      return {
        type: 'https://devrandom.example/problems/work-access-command-conflict',
        title: 'Work Access command conflict',
        status: 409,
        code,
        correlationId,
      };
    case 'WorkAccessProofConflict':
      return {
        type: 'https://devrandom.example/problems/work-access-proof-conflict',
        title: 'Work Access proof conflict',
        status: 409,
        code,
        correlationId,
      };
    case 'WorkAccessProofReplayed':
      return {
        type: 'https://devrandom.example/problems/work-access-proof-replayed',
        title: 'Work Access proof was already used',
        status: 409,
        code,
        correlationId,
      };
    case 'WorkAccessConcurrentUpdate':
      return {
        type: 'https://devrandom.example/problems/work-access-concurrent-update',
        title: 'Work Access Attempt changed concurrently',
        status: 409,
        code,
        correlationId,
      };
    case 'WorkAccessGrantReleaseConflict':
      return {
        type: 'https://devrandom.example/problems/work-access-grant-release-conflict',
        title: 'Work Access Grant cannot be released',
        status: 409,
        code,
        correlationId,
      };
    case 'WorkAccessAttemptExpired':
      return {
        type: 'https://devrandom.example/problems/work-access-attempt-expired',
        title: 'Work Access Attempt expired',
        status: 410,
        code,
        correlationId,
      };
    case 'WorkAccessBodyTooLarge':
      return {
        type: 'https://devrandom.example/problems/work-access-body-too-large',
        title: 'Work Access request body is too large',
        status: 413,
        code,
        correlationId,
      };
    case 'WorkAccessCapacityExceeded':
      return {
        type: 'https://devrandom.example/problems/work-access-capacity-exceeded',
        title: 'Work Access capacity exceeded',
        status: 429,
        code,
        correlationId,
      };
    case 'WorkAccessUnavailable':
      return {
        type: 'https://devrandom.example/problems/work-access-unavailable',
        title: 'Work Access dependency is unavailable',
        status: 503,
        code,
        correlationId,
      };
  }
}

async function sendProblem(
  reply: FastifyReply,
  code: SimpleWorkAccessProblemCode,
  correlationId: string,
): Promise<void> {
  const body = problem(code, correlationId);
  await reply.type('application/problem+json').code(body.status).send(body);
}

async function sendProofRejected(
  reply: FastifyReply,
  reason: WorkAccessRejectionReason,
  correlationId: string,
): Promise<void> {
  await reply
    .type('application/problem+json')
    .code(403)
    .send({
      type: 'https://devrandom.example/problems/work-access-proof-rejected',
      title: 'Work Access proof was rejected',
      status: 403,
      code: 'WorkAccessProofRejected',
      correlationId,
      reason,
    } satisfies WorkAccessProblem);
}

async function sendCreation(
  reply: FastifyReply,
  outcome: CreateWorkAccessAttemptOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'AttemptCreated':
      await reply.code(201).send(outcome.attempt);
      return;
    case 'ExistingAttempt':
      await reply.code(200).send(outcome.attempt);
      return;
    case 'CommandConflict':
      return sendProblem(reply, 'WorkAccessCommandConflict', correlationId);
    case 'CredentialRejected':
      return sendProblem(reply, 'WorkAccessCredentialRejected', correlationId);
    case 'AttemptCapacityExceeded':
    case 'AttemptRateExceeded':
      return sendProblem(reply, 'WorkAccessCapacityExceeded', correlationId);
    case 'DependencyUnavailable':
      return sendProblem(reply, 'WorkAccessUnavailable', correlationId);
  }
}

async function sendProof(
  reply: FastifyReply,
  outcome: SubmitWorkAccessProofOutcome | ObserveWorkAccessAttemptOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'AttemptObserved':
      await reply.code(200).send(outcome.attempt);
      return;
    case 'ProofPending':
      await reply.code(202).send(outcome.attempt);
      return;
    case 'CapabilityInvalid':
      return sendProblem(reply, 'WorkAccessCapabilityInvalid', correlationId);
    case 'CredentialRejected':
      return sendProblem(reply, 'WorkAccessCredentialRejected', correlationId);
    case 'ProofRejected':
      return sendProofRejected(reply, outcome.reason, correlationId);
    case 'AttemptExpired':
      return sendProblem(reply, 'WorkAccessAttemptExpired', correlationId);
    case 'ProofConflict':
      return sendProblem(reply, 'WorkAccessProofConflict', correlationId);
    case 'ProofReplayed':
      return sendProblem(reply, 'WorkAccessProofReplayed', correlationId);
    case 'ConcurrentUpdate':
      return sendProblem(reply, 'WorkAccessConcurrentUpdate', correlationId);
    case 'DependencyUnavailable':
      return sendProblem(reply, 'WorkAccessUnavailable', correlationId);
    case 'GrantCapacityExceeded':
      return sendProblem(reply, 'WorkAccessCapacityExceeded', correlationId);
  }
}

async function sendRelease(
  reply: FastifyReply,
  outcome: ReleaseWorkAccessGrantOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'GrantReleased':
      await reply.code(204).send();
      return;
    case 'CapabilityInvalid':
      return sendProblem(reply, 'WorkAccessCapabilityInvalid', correlationId);
    case 'GrantReleaseConflict':
      return sendProblem(reply, 'WorkAccessGrantReleaseConflict', correlationId);
    case 'ConcurrentUpdate':
      return sendProblem(reply, 'WorkAccessConcurrentUpdate', correlationId);
    case 'DependencyUnavailable':
      return sendProblem(reply, 'WorkAccessUnavailable', correlationId);
  }
}

export function workAccessRoutes(
  configuration: WorkAccessRoutesConfiguration,
): FastifyPluginCallbackTypebox {
  return (server, _options, done) => {
    server.setValidatorCompiler(({ schema }) => (input) => {
      if (Value.Check(schema, input)) {
        return { value: input };
      }
      const [firstError] = Value.Errors(schema, input);
      return {
        error: new Error(firstError?.message ?? 'request does not match the route schema'),
      };
    });
    server.addHook('onSend', (_request, reply, payload, next) => {
      void reply.header('cache-control', 'no-store');
      next(null, payload);
    });
    server.setErrorHandler(async (failure, _request, reply) => {
      const invalidRequest = failure instanceof Error && 'validationContext' in failure;
      const bodyTooLarge =
        failure instanceof Error &&
        'code' in failure &&
        failure.code === 'FST_ERR_CTP_BODY_TOO_LARGE';
      await sendProblem(
        reply,
        bodyTooLarge
          ? 'WorkAccessBodyTooLarge'
          : invalidRequest
            ? 'WorkAccessRequestInvalid'
            : 'WorkAccessUnavailable',
        configuration.newCorrelationId(),
      );
    });

    server.post(
      '/api/work-access-attempts',
      {
        bodyLimit: workAccessPolicy.ordinaryRequestBytes,
        schema: {
          operationId: 'createWorkAccessAttempt',
          body: createWorkAccessAttemptBodySchema,
          response: {
            400: responseSchemas[400],
            200: noStoreResponse(workAccessAttemptProjectionSchema),
            201: noStoreResponse(workAccessAttemptProjectionSchema),
            403: responseSchemas[403],
            409: problemResponse(workAccessCommandConflictProblemSchema),
            413: responseSchemas[413],
            429: responseSchemas[429],
            503: responseSchemas[503],
          },
        },
      },
      async (request, reply) => {
        const outcome = await configuration.conversation.create({
          ...request.body,
          sourceAddress: request.ip,
        });
        await sendCreation(reply, outcome, configuration.newCorrelationId());
      },
    );

    server.put(
      '/api/work-access-attempts/:attemptId/proof',
      {
        bodyLimit: workAccessPolicy.ordinaryRequestBytes,
        schema: {
          operationId: 'submitWorkAccessProof',
          params: workAccessAttemptParametersSchema,
          headers: workAccessAuthorizationHeadersSchema,
          body: submitWorkAccessProofBodySchema,
          response: responseSchemas,
        },
      },
      async (request, reply) => {
        const outcome = await configuration.conversation.submitProof({
          attemptId: request.params.attemptId,
          bearerSecret: bearerSecret(request.headers.authorization),
          responseSaid: request.body.responseSaid,
        });
        await sendProof(reply, outcome, configuration.newCorrelationId());
      },
    );

    server.get(
      '/api/work-access-attempts/:attemptId',
      {
        schema: {
          operationId: 'getWorkAccessAttempt',
          params: workAccessAttemptParametersSchema,
          headers: workAccessAuthorizationHeadersSchema,
          response: responseSchemas,
        },
      },
      async (request, reply) => {
        const outcome = await configuration.conversation.observe({
          attemptId: request.params.attemptId,
          bearerSecret: bearerSecret(request.headers.authorization),
        });
        await sendProof(reply, outcome, configuration.newCorrelationId());
      },
    );

    server.delete(
      '/api/work-access-attempts/:attemptId/grant',
      {
        schema: {
          operationId: 'releaseWorkAccessGrant',
          params: workAccessAttemptParametersSchema,
          headers: workAccessAuthorizationHeadersSchema,
          response: {
            204: { type: 'null', headers: noStoreHeader },
            400: responseSchemas[400],
            401: responseSchemas[401],
            409: problemResponse(
              Type.Union([
                workAccessGrantReleaseConflictProblemSchema,
                workAccessConcurrentUpdateProblemSchema,
              ]),
            ),
            503: responseSchemas[503],
          },
        },
      },
      async (request, reply) => {
        const outcome = await configuration.conversation.release({
          attemptId: request.params.attemptId,
          bearerSecret: bearerSecret(request.headers.authorization),
        });
        await sendRelease(reply, outcome, configuration.newCorrelationId());
      },
    );

    done();
  };
}
