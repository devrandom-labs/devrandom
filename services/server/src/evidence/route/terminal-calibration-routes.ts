import { ProtectedCredentials, taskBudgetCeilings } from '@devrandom/domain';
import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import {
  evidenceBatchAcknowledgementSchema,
  evidenceCapabilityInvalidProblemSchema,
  evidenceConflictProblemSchema,
  evidenceQuotaExceededProblemSchema,
  evidenceRejectedProblemSchema,
  evidenceRequestInvalidProblemSchema,
  evidenceRunNotFoundProblemSchema,
  evidenceUnavailableProblemSchema,
  runParametersSchema,
  terminalCalibrationReconciliationBodySchema,
  workAccessAuthorizationHeadersSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
} from '@devrandom/protocol';
import Type from 'typebox';
import { Check, Errors } from 'typebox/value';

import type { TerminalCalibrationEvidence } from '../application/terminal-calibration-reconciliation.js';
import type { EvidenceAccessAuthorizer } from './evidence-routes.js';

export interface TerminalCalibrationRoutesConfiguration {
  readonly access: EvidenceAccessAuthorizer;
  readonly reconciliation: TerminalCalibrationEvidence;
  now(): string;
  newCorrelationId(): string;
}

/** A separate write boundary cannot silently inherit ordinary append's expiry exception. */
export function terminalCalibrationRoutes(
  configuration: TerminalCalibrationRoutesConfiguration,
): FastifyPluginCallbackTypebox {
  return (server, _options, done) => {
    server.setValidatorCompiler(({ schema }) => (input) => {
      if (Check(schema, input)) return { value: input };
      const [first] = Errors(schema, input);
      return { error: new Error(first?.message ?? 'invalid terminal reconciliation') };
    });
    server.addHook('onSend', (_request, reply, payload, next) => {
      void reply.header('cache-control', 'no-store');
      next(null, payload);
    });
    server.setErrorHandler(async (failure, _request, reply) => {
      const code: unknown =
        failure instanceof Error && 'code' in failure ? failure.code : undefined;
      const context: unknown =
        failure instanceof Error && 'validationContext' in failure
          ? failure.validationContext
          : undefined;
      const correlationId = configuration.newCorrelationId();
      if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        await reply.code(413).send({
          type: 'https://devrandom.example/problems/evidence-quota-exceeded',
          title: 'Evidence size or storage quota was exceeded',
          status: 413,
          code: 'EvidenceQuotaExceeded',
          correlationId,
          reason: 'RequestBodyTooLarge',
        });
      } else if (context === 'headers') {
        await reply.code(401).send({
          type: 'https://devrandom.example/problems/evidence-capability-invalid',
          title: 'Work Access capability is invalid',
          status: 401,
          code: 'EvidenceCapabilityInvalid',
          correlationId,
        });
      } else if (
        context === 'body' ||
        context === 'params' ||
        code === 'FST_ERR_CTP_INVALID_JSON_BODY'
      ) {
        await reply.code(400).send({
          type: 'https://devrandom.example/problems/evidence-request-invalid',
          title: 'Evidence request is invalid',
          status: 400,
          code: 'EvidenceRequestInvalid',
          correlationId,
        });
      } else {
        await reply.code(500).send();
      }
    });
    server.post(
      '/api/runs/:runId/evidence-terminal-reconciliation',
      {
        bodyLimit: taskBudgetCeilings.evidenceBatchBodyBytes,
        schema: {
          operationId: 'reconcileTerminalCalibrationEvidence',
          headers: workAccessAuthorizationHeadersSchema,
          params: runParametersSchema,
          body: terminalCalibrationReconciliationBodySchema,
          response: {
            200: evidenceBatchAcknowledgementSchema,
            201: evidenceBatchAcknowledgementSchema,
            400: evidenceRequestInvalidProblemSchema,
            401: Type.Union([
              evidenceCapabilityInvalidProblemSchema,
              workAccessGrantExpiredProblemSchema,
              workAccessGrantReleasedProblemSchema,
            ]),
            403: Type.Union([
              workAccessGrantRevokedProblemSchema,
              workAccessGrantScopeRejectedProblemSchema,
            ]),
            404: evidenceRunNotFoundProblemSchema,
            409: Type.Union([
              evidenceConflictProblemSchema,
              workAccessGrantConcurrentUpdateProblemSchema,
            ]),
            413: evidenceQuotaExceededProblemSchema,
            422: evidenceRejectedProblemSchema,
            429: workAccessGrantExhaustedProblemSchema,
            503: evidenceUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const correlationId = configuration.newCorrelationId();
        const bearerSecret = request.headers.authorization.slice('Bearer '.length);
        const access = await configuration.access.authorize({
          bearerSecret,
          scope: 'evidence:append',
          observedAt: configuration.now(),
        });
        if (access.kind !== 'EvidenceAccessAuthorized') {
          switch (access.kind) {
            case 'EvidenceAccessInvalid':
              await reply.code(401).send({
                type: 'https://devrandom.example/problems/evidence-capability-invalid',
                title: 'Work Access capability is invalid',
                status: 401,
                code: 'EvidenceCapabilityInvalid',
                correlationId,
              });
              return;
            case 'EvidenceAccessExpired':
              await reply.code(401).send({
                type: 'https://devrandom.example/problems/work-access-grant-expired',
                title: 'Work Access Grant expired',
                status: 401,
                code: 'WorkAccessGrantExpired',
                correlationId,
              });
              return;
            case 'EvidenceAccessReleased':
              await reply.code(401).send({
                type: 'https://devrandom.example/problems/work-access-grant-released',
                title: 'Work Access Grant was released',
                status: 401,
                code: 'WorkAccessGrantReleased',
                correlationId,
              });
              return;
            case 'EvidenceAccessRevoked':
              await reply.code(403).send({
                type: 'https://devrandom.example/problems/work-access-grant-revoked',
                title: 'Work Access Grant was revoked',
                status: 403,
                code: 'WorkAccessGrantRevoked',
                correlationId,
                reason: access.reason,
              });
              return;
            case 'EvidenceAccessScopeRejected':
              await reply.code(403).send({
                type: 'https://devrandom.example/problems/work-access-grant-scope-rejected',
                title: 'Work Access Grant scope was rejected',
                status: 403,
                code: 'WorkAccessGrantScopeRejected',
                correlationId,
                requiredScope: 'evidence:append',
              });
              return;
            case 'EvidenceAccessConcurrentUpdate':
              await reply.code(409).send({
                type: 'https://devrandom.example/problems/work-access-grant-concurrent-update',
                title: 'Work Access Grant changed concurrently',
                status: 409,
                code: 'WorkAccessGrantConcurrentUpdate',
                correlationId,
              });
              return;
            case 'EvidenceAccessExhausted':
              await reply.code(429).send({
                type: 'https://devrandom.example/problems/work-access-grant-exhausted',
                title: 'Work Access Grant request budget is exhausted',
                status: 429,
                code: 'WorkAccessGrantExhausted',
                correlationId,
              });
              return;
            case 'EvidenceAccessUnavailable':
              await reply.code(503).send({
                type: 'https://devrandom.example/problems/evidence-unavailable',
                title: 'Evidence dependency is unavailable',
                status: 503,
                code: 'EvidenceUnavailable',
                correlationId,
                dependency: access.dependency,
              });
              return;
          }
        }
        const disclosure = new ProtectedCredentials([bearerSecret]).inspect(
          new TextEncoder().encode(JSON.stringify(request.body)),
        );
        if (disclosure.kind === 'WithheldSecret') {
          await reply.code(422).send({
            type: 'https://devrandom.example/problems/evidence-rejected',
            title: 'Evidence content was rejected',
            status: 422,
            code: 'EvidenceRejected',
            correlationId,
            reason: 'SecretDetected',
          });
          return;
        }
        const outcome = await configuration.reconciliation.reconcile({
          ownerAid: access.ownerAid,
          runId: request.params.runId,
          command: request.body,
          receivedAt: configuration.now(),
        });
        switch (outcome.kind) {
          case 'EvidenceBatchAccepted':
            await reply.code(201).send(outcome.acknowledgement);
            return;
          case 'EvidenceBatchAlreadyAccepted':
            await reply.code(200).send(outcome.acknowledgement);
            return;
          case 'EvidenceRunNotFound':
            await reply.code(404).send({
              type: 'https://devrandom.example/problems/evidence-run-not-found',
              title: 'Evidence Run was not found',
              status: 404,
              code: 'EvidenceRunNotFound',
              correlationId,
            });
            return;
          case 'EvidenceBatchRejected':
            await reply.code(422).send({
              type: 'https://devrandom.example/problems/evidence-rejected',
              title: 'Evidence content was rejected',
              status: 422,
              code: 'EvidenceRejected',
              correlationId,
              reason: outcome.reason,
            });
            return;
          case 'RunEvidenceQuotaExceeded':
          case 'GlobalEvidenceQuotaExceeded':
            await reply.code(413).send({
              type: 'https://devrandom.example/problems/evidence-quota-exceeded',
              title: 'Evidence size or storage quota was exceeded',
              status: 413,
              code: 'EvidenceQuotaExceeded',
              correlationId,
              reason: outcome.kind,
            });
            return;
          case 'DependencyUnavailable':
            await reply.code(503).send({
              type: 'https://devrandom.example/problems/evidence-unavailable',
              title: 'Evidence dependency is unavailable',
              status: 503,
              code: 'EvidenceUnavailable',
              correlationId,
              dependency: outcome.dependency,
            });
            return;
          case 'EvidenceBatchConflict':
          case 'EvidenceCheckpointConflict':
          case 'EvidenceCursorConcurrentUpdate':
          case 'EvidenceStreamSealed': {
            const reason =
              outcome.kind === 'EvidenceBatchConflict'
                ? 'BatchConflict'
                : outcome.kind === 'EvidenceCheckpointConflict'
                  ? 'CheckpointConflict'
                  : outcome.kind === 'EvidenceStreamSealed'
                    ? 'SealConflict'
                    : 'CursorConcurrentUpdate';
            await reply.code(409).send({
              type: 'https://devrandom.example/problems/evidence-conflict',
              title: 'Evidence delivery conflicts with the accepted stream',
              status: 409,
              code: 'EvidenceConflict',
              correlationId,
              reason,
            });
            return;
          }
          case 'EvidenceSequenceGap':
            await reply.code(409).send({
              type: 'https://devrandom.example/problems/evidence-conflict',
              title: 'Evidence delivery conflicts with the accepted stream',
              status: 409,
              code: 'EvidenceConflict',
              correlationId,
              reason: 'SequenceGap',
              expectedStartingSequence: outcome.expectedStartingSequence,
              receivedStartingSequence: outcome.receivedStartingSequence,
            });
        }
      },
    );
    done();
  };
}
