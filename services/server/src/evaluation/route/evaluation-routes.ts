import { taskBudgetCeilings } from '@devrandom/domain';
import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply } from 'fastify';
import {
  evaluationAdmissionCommandSchema,
  evaluationAdmissionReceiptSchema,
  evaluationClosureCommandSchema,
  evaluationEvidenceAcknowledgementSchema,
  evaluationEvidenceUploadSchema,
  evaluationLeaseRenewalCommandSchema,
  evaluationLeaseRenewalReceiptSchema,
  evaluationManifestLockCommandSchema,
  evaluationManifestLockReceiptSchema,
  evaluationPreparationCommandSchema,
  workAccessAuthorizationHeadersSchema,
} from '@devrandom/protocol';
import Type from 'typebox';
import { Check, Errors } from 'typebox/value';

import type {
  EvaluationAdmissionCommand,
  EvaluationAdmissionOutcome,
} from '../application/admit-evaluation.js';
import type {
  EvaluationEvidenceAcceptance,
  EvaluationEvidenceUpload,
} from '../application/accept-evaluation-evidence.js';
import type { EvaluationClosureOutcome } from '../application/close-evaluation.js';
import type { EvaluationPreparations } from '../application/prepare-evaluation.js';
import type {
  EvaluationLeaseRenewalCommand,
  EvaluationLeaseRenewalReceipt,
} from '../application/renew-evaluation-lease.js';
import type {
  EvaluationManifestInspection,
  EvaluationManifestLockCommand,
  EvaluationManifestLockOutcome,
} from '../application/lock-evaluation-manifest.js';

type EvaluationScope =
  | 'evaluation:prepare'
  | 'evaluation:admit'
  | 'evaluation:renew'
  | 'evaluation:append'
  | 'evaluation:close';
const evaluationIdParameters = Type.Object(
  {
    evaluationId: Type.String({
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    }),
  },
  { additionalProperties: false },
);
const manifestParameters = Type.Object(
  {
    evaluationId: evaluationIdParameters.properties.evaluationId,
    manifestSaid: Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' }),
  },
  { additionalProperties: false },
);
const problem = Type.Object(
  {
    code: Type.String(),
    correlationId: Type.String(),
    status: Type.Integer(),
    title: Type.String(),
    type: Type.String(),
  },
  { additionalProperties: false },
);
const prepared = Type.Object({
  kind: Type.Union([Type.Literal('Prepared'), Type.Literal('AlreadyPrepared')]),
});
const closed = Type.Object({
  kind: Type.Union([Type.Literal('Closed'), Type.Literal('AlreadyClosed')]),
  closureSaid: Type.String(),
});

export interface EvaluationRoutesConfiguration {
  readonly access: {
    authorize(input: {
      readonly bearerSecret: string;
      readonly scope: EvaluationScope;
      readonly observedAt: string;
    }): Promise<
      | { readonly kind: 'Authorized'; readonly ownerAid: string }
      | { readonly kind: 'Denied' | 'Unavailable' }
    >;
  };
  readonly preparation: EvaluationPreparations;
  readonly admission: {
    admit(input: {
      readonly ownerAid: string;
      readonly command: EvaluationAdmissionCommand;
    }): Promise<EvaluationAdmissionOutcome>;
  };
  readonly leases: {
    renew(input: {
      readonly ownerAid: string;
      readonly command: EvaluationLeaseRenewalCommand;
    }): Promise<EvaluationLeaseRenewalReceipt>;
  };
  readonly manifest: {
    lock(input: {
      readonly ownerAid: string;
      readonly command: EvaluationManifestLockCommand;
    }): Promise<EvaluationManifestLockOutcome>;
    inspect(input: {
      readonly ownerAid: string;
      readonly evaluationId: string;
      readonly manifestSaid: string;
    }): Promise<EvaluationManifestInspection>;
  };
  readonly evidence: {
    accept(input: {
      readonly ownerAid: string;
      readonly upload: EvaluationEvidenceUpload;
    }): Promise<EvaluationEvidenceAcceptance>;
    close(input: {
      readonly ownerAid: string;
      readonly expectedEvaluationVersion: number;
      readonly closure: Type.Static<typeof evaluationClosureCommandSchema>['closure'];
    }): Promise<EvaluationClosureOutcome>;
  };
  now(): string;
  newCorrelationId(): string;
}

export function evaluationRoutes(
  configuration: EvaluationRoutesConfiguration,
): FastifyPluginCallbackTypebox {
  return (server, _options, done) => {
    server.setValidatorCompiler(({ schema }) => (input) => {
      if (Check(schema, input)) return { value: input };
      const [first] = Errors(schema, input);
      return {
        error: Object.assign(new Error(first?.message ?? 'invalid evaluation request'), {
          statusCode: 400,
        }),
      };
    });
    server.setErrorHandler(async (error, _request, reply) => {
      const reportedStatus =
        error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
      const status = reportedStatus === 400 ? 400 : reportedStatus === 413 ? 413 : 500;
      const code =
        status === 400
          ? 'EvaluationRequestInvalid'
          : status === 413
            ? 'EvaluationBodyTooLarge'
            : 'EvaluationUnavailable';
      await reply
        .code(status)
        .type('application/problem+json')
        .send({
          type: `https://devrandom.example/problems/${code.toLowerCase()}`,
          title: code,
          status,
          code,
          correlationId: configuration.newCorrelationId(),
        });
    });
    server.addHook('onSend', (_request, reply, payload, next) => {
      void reply.header('cache-control', 'no-store');
      next(null, payload);
    });
    const fail = async (reply: FastifyReply, status: number, code: string) => {
      await reply
        .code(status)
        .type('application/problem+json')
        .send({
          type: `https://devrandom.example/problems/${code.toLowerCase()}`,
          title: code,
          status,
          code,
          correlationId: configuration.newCorrelationId(),
        });
    };
    const authorize = async (authorization: string, scope: EvaluationScope) =>
      configuration.access.authorize({
        bearerSecret: authorization.slice('Bearer '.length),
        scope,
        observedAt: configuration.now(),
      });

    server.post(
      '/api/evaluations/prepare',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'prepareEvaluation',
          headers: workAccessAuthorizationHeadersSchema,
          body: evaluationPreparationCommandSchema,
          response: {
            200: prepared,
            201: prepared,
            400: problem,
            403: problem,
            409: problem,
            503: problem,
          },
        },
      },
      async (request, reply) => {
        const access = await authorize(request.headers.authorization, 'evaluation:prepare');
        if (access.kind !== 'Authorized')
          return fail(reply, access.kind === 'Unavailable' ? 503 : 403, 'EvaluationAccessDenied');
        const result = await configuration.preparation.prepare({
          ownerAid: access.ownerAid,
          command: request.body,
        });
        if (result === 'Prepared' || result === 'AlreadyPrepared')
          return reply.code(result === 'Prepared' ? 201 : 200).send({ kind: result });
        return fail(
          reply,
          result === 'Rejected' ? 400 : result === 'Conflict' ? 409 : 503,
          'EvaluationPreparationRejected',
        );
      },
    );

    server.post(
      '/api/evaluations',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'admitEvaluation',
          headers: workAccessAuthorizationHeadersSchema,
          body: evaluationAdmissionCommandSchema,
          response: {
            201: evaluationAdmissionReceiptSchema,
            400: problem,
            403: problem,
            409: problem,
            422: problem,
            503: problem,
          },
        },
      },
      async (request, reply) => {
        const access = await authorize(request.headers.authorization, 'evaluation:admit');
        if (access.kind !== 'Authorized')
          return fail(reply, access.kind === 'Unavailable' ? 503 : 403, 'EvaluationAccessDenied');
        const result = await configuration.admission.admit({
          ownerAid: access.ownerAid,
          command: request.body,
        });
        if (result.kind === 'Admitted') return reply.code(201).send(result);
        const status =
          result.kind === 'Blocked'
            ? 422
            : result.kind === 'Conflict'
              ? 409
              : result.kind === 'Unavailable'
                ? 503
                : 400;
        return fail(
          reply,
          status,
          result.kind === 'Blocked'
            ? `EvaluationBlocked${result.gate}`
            : `Evaluation${result.kind}`,
        );
      },
    );

    server.put(
      '/api/evaluations/:evaluationId/manifest',
      {
        bodyLimit: taskBudgetCeilings.artifactRequestBodyBytes,
        schema: {
          operationId: 'lockEvaluationManifest',
          headers: workAccessAuthorizationHeadersSchema,
          params: evaluationIdParameters,
          body: evaluationManifestLockCommandSchema,
          response: {
            200: evaluationManifestLockReceiptSchema,
            201: evaluationManifestLockReceiptSchema,
            400: problem,
            403: problem,
            409: problem,
            413: problem,
            503: problem,
          },
        },
      },
      async (request, reply) => {
        const access = await authorize(request.headers.authorization, 'evaluation:append');
        if (access.kind !== 'Authorized')
          return fail(reply, access.kind === 'Unavailable' ? 503 : 403, 'EvaluationAccessDenied');
        if (request.params.evaluationId !== request.body.manifest.evaluationId)
          return fail(reply, 400, 'EvaluationBindingRejected');
        const result = await configuration.manifest.lock({
          ownerAid: access.ownerAid,
          command: request.body,
        });
        if (result.kind === 'Locked' || result.kind === 'AlreadyLocked')
          return reply.code(result.kind === 'Locked' ? 201 : 200).send(result);
        return fail(
          reply,
          result.kind === 'Invalid'
            ? 400
            : result.kind === 'QuotaExceeded'
              ? 413
              : result.kind === 'Conflict'
                ? 409
                : 503,
          `EvaluationManifest${result.kind}`,
        );
      },
    );

    server.get(
      '/api/evaluations/:evaluationId/manifest/:manifestSaid',
      {
        schema: {
          operationId: 'inspectEvaluationManifest',
          headers: workAccessAuthorizationHeadersSchema,
          params: manifestParameters,
          response: {
            200: evaluationManifestLockReceiptSchema,
            400: problem,
            403: problem,
            409: problem,
            503: problem,
          },
        },
      },
      async (request, reply) => {
        const access = await authorize(request.headers.authorization, 'evaluation:append');
        if (access.kind !== 'Authorized')
          return fail(reply, access.kind === 'Unavailable' ? 503 : 403, 'EvaluationAccessDenied');
        const result = await configuration.manifest.inspect({
          ownerAid: access.ownerAid,
          evaluationId: request.params.evaluationId,
          manifestSaid: request.params.manifestSaid,
        });
        if (result.kind === 'Locked' || result.kind === 'AlreadyLocked')
          return reply.code(200).send(result);
        return fail(
          reply,
          result.kind === 'Unavailable' ? 503 : 409,
          `EvaluationManifest${result.kind}`,
        );
      },
    );

    server.post(
      '/api/evaluations/:evaluationId/batches',
      {
        bodyLimit: taskBudgetCeilings.artifactRequestBodyBytes,
        schema: {
          operationId: 'appendEvaluationEvidence',
          headers: workAccessAuthorizationHeadersSchema,
          params: evaluationIdParameters,
          body: evaluationEvidenceUploadSchema,
          response: {
            200: evaluationEvidenceAcknowledgementSchema,
            201: evaluationEvidenceAcknowledgementSchema,
            400: problem,
            403: problem,
            409: problem,
            413: problem,
            503: problem,
          },
        },
      },
      async (request, reply) => {
        const access = await authorize(request.headers.authorization, 'evaluation:append');
        if (access.kind !== 'Authorized')
          return fail(reply, access.kind === 'Unavailable' ? 503 : 403, 'EvaluationAccessDenied');
        if (request.params.evaluationId !== request.body.batch.evaluationId)
          return fail(reply, 400, 'EvaluationBindingRejected');
        const result = await configuration.evidence.accept({
          ownerAid: access.ownerAid,
          upload: request.body,
        });
        if (result.kind === 'Accepted' || result.kind === 'AlreadyAccepted')
          return reply.code(result.kind === 'Accepted' ? 201 : 200).send({
            version: 1,
            disposition: result.kind,
            evaluationId: result.evaluationId,
            streamId: result.streamId,
            batchSaid: result.batchSaid,
            acceptedThroughSequence: result.acceptedThroughSequence,
            chainHeadSaid: result.chainHeadSaid,
          });
        const status =
          result.kind === 'QuotaExceeded'
            ? 413
            : result.kind === 'Unavailable'
              ? 503
              : result.kind === 'Rejected'
                ? 400
                : 409;
        return fail(reply, status, `EvaluationEvidence${result.kind}`);
      },
    );

    server.put(
      '/api/evaluations/:evaluationId/lease',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'renewEvaluationLease',
          headers: workAccessAuthorizationHeadersSchema,
          params: evaluationIdParameters,
          body: evaluationLeaseRenewalCommandSchema,
          response: {
            200: evaluationLeaseRenewalReceiptSchema,
            400: problem,
            403: problem,
            409: problem,
            422: problem,
            503: problem,
          },
        },
      },
      async (request, reply) => {
        const access = await authorize(request.headers.authorization, 'evaluation:renew');
        if (access.kind !== 'Authorized')
          return fail(reply, access.kind === 'Unavailable' ? 503 : 403, 'EvaluationAccessDenied');
        if (request.params.evaluationId !== request.body.evaluationId)
          return fail(reply, 400, 'EvaluationBindingRejected');
        const result = await configuration.leases.renew({
          ownerAid: access.ownerAid,
          command: request.body,
        });
        if (result.kind === 'Renewed' || result.kind === 'AlreadyRenewed')
          return reply.code(200).send(result);
        return fail(
          reply,
          result.kind === 'Blocked' ? 422 : result.kind === 'Unavailable' ? 503 : 409,
          `EvaluationLease${result.kind}`,
        );
      },
    );

    server.put(
      '/api/evaluations/:evaluationId/closure',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'closeEvaluationEvidenceOnly',
          headers: workAccessAuthorizationHeadersSchema,
          params: evaluationIdParameters,
          body: evaluationClosureCommandSchema,
          response: {
            200: closed,
            201: closed,
            400: problem,
            403: problem,
            409: problem,
            422: problem,
            503: problem,
          },
        },
      },
      async (request, reply) => {
        const access = await authorize(request.headers.authorization, 'evaluation:close');
        if (access.kind !== 'Authorized')
          return fail(reply, access.kind === 'Unavailable' ? 503 : 403, 'EvaluationAccessDenied');
        if (request.params.evaluationId !== request.body.closure.evaluationId)
          return fail(reply, 400, 'EvaluationBindingRejected');
        const result = await configuration.evidence.close({
          ownerAid: access.ownerAid,
          expectedEvaluationVersion: request.body.expectedEvaluationVersion,
          closure: request.body.closure,
        });
        if (result.kind === 'Closed' || result.kind === 'AlreadyClosed')
          return reply.code(result.kind === 'Closed' ? 201 : 200).send(result);
        return fail(
          reply,
          result.kind === 'Denied'
            ? 403
            : result.kind === 'Incomplete'
              ? 422
              : result.kind === 'Conflict'
                ? 409
                : 503,
          `EvaluationClosure${result.kind}`,
        );
      },
    );

    done();
  };
}
