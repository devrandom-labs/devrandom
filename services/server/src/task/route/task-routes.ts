import type { FastifyPluginCallbackTypebox } from '@fastify/type-provider-typebox';
import { ProtectedCredentials } from '@devrandom/domain';
import {
  createTaskBodySchema,
  taskBodyTooLargeProblemSchema,
  taskBudgetCeilings,
  taskCapabilityInvalidProblemSchema,
  taskCapacityProblemSchema,
  taskCommandConflictProblemSchema,
  taskContractRejectedProblemSchema,
  taskCreationForbiddenProblemSchema,
  taskLabelConflictProblemSchema,
  taskLabelParametersSchema,
  taskListProjectionSchema,
  taskListQuerySchema,
  taskNotFoundProblemSchema,
  taskProjectionSchema,
  taskRequestInvalidProblemSchema,
  taskUnavailableProblemSchema,
  workAccessAuthorizationHeadersSchema,
  workAccessGrantConcurrentUpdateProblemSchema,
  workAccessGrantExhaustedProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
  type TaskProblem,
} from '@devrandom/protocol';
import type { FastifyReply } from 'fastify';
import Type from 'typebox';
import { Check, Convert, Errors } from 'typebox/value';

import type { CreateTaskInput, CreateTaskOutcome } from '../application/create-task.js';
import type { InspectTaskOutcome, ListTasksOutcome } from '../application/inspect-tasks.js';
import type { AuthenticatedTaskOwner } from '../application/tasks.js';

export type TaskAccessAuthorization =
  | { readonly kind: 'TaskAccessAuthorized'; readonly owner: AuthenticatedTaskOwner }
  | { readonly kind: 'TaskAccessInvalid' }
  | { readonly kind: 'TaskAccessExpired' }
  | { readonly kind: 'TaskAccessReleased' }
  | { readonly kind: 'TaskAccessRevoked'; readonly reason: 'SecurityIncident' }
  | { readonly kind: 'TaskAccessScopeRejected' }
  | { readonly kind: 'TaskAccessConcurrentUpdate' }
  | { readonly kind: 'TaskAccessExhausted' }
  | {
      readonly kind: 'TaskAccessUnavailable';
      readonly dependency: 'HostedMongoDB';
    };

export interface TaskAccessAuthorizer {
  authorize(input: {
    readonly bearerSecret: string;
    readonly scope: 'task:create' | 'task:read';
    readonly observedAt: string;
  }): Promise<TaskAccessAuthorization>;
}

export interface TaskConversation {
  create(input: CreateTaskInput): Promise<CreateTaskOutcome>;
  list(input: {
    readonly ownerAid: string;
    readonly query: { readonly limit?: number; readonly cursor?: string };
  }): Promise<ListTasksOutcome>;
  inspect(input: {
    readonly ownerAid: string;
    readonly label: string;
  }): Promise<InspectTaskOutcome>;
}

export interface TaskRoutesConfiguration {
  readonly access: TaskAccessAuthorizer;
  readonly conversation: TaskConversation;
  now(): string;
  newCorrelationId(): string;
}

const unauthorizedResponseSchema = Type.Union([
  taskCapabilityInvalidProblemSchema,
  workAccessGrantExpiredProblemSchema,
  workAccessGrantReleasedProblemSchema,
]);
const authorizationForbiddenResponseSchema = Type.Union([
  workAccessGrantRevokedProblemSchema,
  workAccessGrantScopeRejectedProblemSchema,
]);
const authorizationProblems = {
  401: unauthorizedResponseSchema,
  403: authorizationForbiddenResponseSchema,
  409: workAccessGrantConcurrentUpdateProblemSchema,
  429: workAccessGrantExhaustedProblemSchema,
};

function bearerSecret(authorization: string): string {
  return authorization.slice('Bearer '.length);
}

async function sendProblem(reply: FastifyReply, body: TaskProblem): Promise<void> {
  await reply.type('application/problem+json').code(body.status).send(body);
}

function taskProblem(
  code:
    | 'TaskRequestInvalid'
    | 'TaskCapabilityInvalid'
    | 'TaskNotFound'
    | 'TaskBodyTooLarge'
    | 'TaskCapacityExceeded',
  correlationId: string,
): TaskProblem {
  switch (code) {
    case 'TaskRequestInvalid':
      return {
        type: 'https://devrandom.example/problems/task-request-invalid',
        title: 'Task request is invalid',
        status: 400,
        code,
        correlationId,
      };
    case 'TaskCapabilityInvalid':
      return {
        type: 'https://devrandom.example/problems/task-capability-invalid',
        title: 'Work Access capability is invalid',
        status: 401,
        code,
        correlationId,
      };
    case 'TaskNotFound':
      return {
        type: 'https://devrandom.example/problems/task-not-found',
        title: 'Task was not found',
        status: 404,
        code,
        correlationId,
      };
    case 'TaskBodyTooLarge':
      return {
        type: 'https://devrandom.example/problems/task-body-too-large',
        title: 'Task request body is too large',
        status: 413,
        code,
        correlationId,
      };
    case 'TaskCapacityExceeded':
      return {
        type: 'https://devrandom.example/problems/task-capacity-exceeded',
        title: 'Task capacity exceeded',
        status: 429,
        code,
        correlationId,
      };
  }
}

async function authorize(
  reply: FastifyReply,
  authorization: string,
  scope: 'task:create' | 'task:read',
  configuration: TaskRoutesConfiguration,
): Promise<AuthenticatedTaskOwner | undefined> {
  const outcome = await configuration.access.authorize({
    bearerSecret: bearerSecret(authorization),
    scope,
    observedAt: configuration.now(),
  });
  const correlationId = configuration.newCorrelationId();
  switch (outcome.kind) {
    case 'TaskAccessAuthorized':
      return outcome.owner;
    case 'TaskAccessInvalid':
      await sendProblem(reply, taskProblem('TaskCapabilityInvalid', correlationId));
      return undefined;
    case 'TaskAccessExpired':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-expired',
        title: 'Work Access Grant expired',
        status: 401,
        code: 'WorkAccessGrantExpired',
        correlationId,
      });
      return undefined;
    case 'TaskAccessReleased':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-released',
        title: 'Work Access Grant was released',
        status: 401,
        code: 'WorkAccessGrantReleased',
        correlationId,
      });
      return undefined;
    case 'TaskAccessRevoked':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-revoked',
        title: 'Work Access Grant was revoked',
        status: 403,
        code: 'WorkAccessGrantRevoked',
        correlationId,
        reason: outcome.reason,
      });
      return undefined;
    case 'TaskAccessScopeRejected':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-scope-rejected',
        title: 'Work Access Grant scope was rejected',
        status: 403,
        code: 'WorkAccessGrantScopeRejected',
        correlationId,
        requiredScope: scope,
      });
      return undefined;
    case 'TaskAccessConcurrentUpdate':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-concurrent-update',
        title: 'Work Access Grant changed concurrently',
        status: 409,
        code: 'WorkAccessGrantConcurrentUpdate',
        correlationId,
      });
      return undefined;
    case 'TaskAccessExhausted':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/work-access-grant-exhausted',
        title: 'Work Access Grant request budget is exhausted',
        status: 429,
        code: 'WorkAccessGrantExhausted',
        correlationId,
      });
      return undefined;
    case 'TaskAccessUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/task-unavailable',
        title: 'Task dependency is unavailable',
        status: 503,
        code: 'TaskUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
      return undefined;
  }
}

async function sendCreateOutcome(
  reply: FastifyReply,
  outcome: CreateTaskOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'TaskCreated':
      await reply.code(201).send(outcome.task);
      return;
    case 'ExistingTask':
      await reply.code(200).send(outcome.task);
      return;
    case 'CommandConflict':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/task-command-conflict',
        title: 'Task command conflicts with its prior use',
        status: 409,
        code: 'TaskCommandConflict',
        correlationId,
        commandId: outcome.commandId,
      });
      return;
    case 'LabelConflict':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/task-label-conflict',
        title: 'Task label already exists',
        status: 409,
        code: 'TaskLabelConflict',
        correlationId,
        label: outcome.label,
      });
      return;
    case 'TaskCapacityExceeded':
      await sendProblem(reply, taskProblem('TaskCapacityExceeded', correlationId));
      return;
    case 'EligibilityMissing':
    case 'CredentialNotCurrent':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/task-forbidden',
        title: 'Task creation is not permitted',
        status: 403,
        code: 'TaskCreationForbidden',
        correlationId,
        reason: outcome.kind,
      });
      return;
    case 'TaskContractRejected':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/task-contract-rejected',
        title: 'Task contract was rejected',
        status: 422,
        code: 'TaskContractRejected',
        correlationId,
        reason: outcome.reason,
      });
      return;
    case 'DependencyUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/task-unavailable',
        title: 'Task dependency is unavailable',
        status: 503,
        code: 'TaskUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
      return;
  }
}

async function sendReadOutcome(
  reply: FastifyReply,
  outcome: ListTasksOutcome | InspectTaskOutcome,
  correlationId: string,
): Promise<void> {
  switch (outcome.kind) {
    case 'TasksListed':
      await reply.code(200).send(outcome.page);
      return;
    case 'TaskFound':
      await reply.code(200).send(outcome.task);
      return;
    case 'TaskNotFound':
      await sendProblem(reply, taskProblem('TaskNotFound', correlationId));
      return;
    case 'TaskQueryRejected':
      await sendProblem(reply, taskProblem('TaskRequestInvalid', correlationId));
      return;
    case 'DependencyUnavailable':
      await sendProblem(reply, {
        type: 'https://devrandom.example/problems/task-unavailable',
        title: 'Task dependency is unavailable',
        status: 503,
        code: 'TaskUnavailable',
        correlationId,
        dependency: outcome.dependency,
      });
      return;
  }
}

export function taskRoutes(configuration: TaskRoutesConfiguration): FastifyPluginCallbackTypebox {
  return (server, _options, done) => {
    server.setValidatorCompiler(({ schema, httpPart }) => (input) => {
      const decoded: unknown = httpPart === 'querystring' ? Convert(schema, input) : input;
      if (Check(schema, decoded)) {
        return { value: decoded };
      }
      const [firstError] = Errors(schema, decoded);
      return { error: new Error(firstError?.message ?? 'request does not match route schema') };
    });
    server.addHook('onSend', (_request, reply, payload, next) => {
      void reply.header('cache-control', 'no-store');
      next(null, payload);
    });
    server.setErrorHandler(async (failure, _request, reply) => {
      const fastifyCode: unknown =
        failure instanceof Error && 'code' in failure ? failure.code : undefined;
      const bodyTooLarge = fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE';
      const validationContext: unknown =
        failure instanceof Error && 'validationContext' in failure
          ? failure.validationContext
          : undefined;
      const requestInvalid =
        validationContext === 'body' ||
        validationContext === 'params' ||
        validationContext === 'querystring' ||
        fastifyCode === 'FST_ERR_CTP_INVALID_JSON_BODY';
      if (!bodyTooLarge && validationContext !== 'headers' && !requestInvalid) {
        await reply.status(500).send();
        return;
      }
      const code = bodyTooLarge
        ? 'TaskBodyTooLarge'
        : validationContext === 'headers'
          ? 'TaskCapabilityInvalid'
          : 'TaskRequestInvalid';
      await sendProblem(reply, taskProblem(code, configuration.newCorrelationId()));
    });

    server.post(
      '/api/tasks',
      {
        bodyLimit: taskBudgetCeilings.ordinaryJsonRequestBodyBytes,
        schema: {
          operationId: 'createTask',
          headers: workAccessAuthorizationHeadersSchema,
          body: createTaskBodySchema,
          response: {
            ...authorizationProblems,
            400: taskRequestInvalidProblemSchema,
            200: taskProjectionSchema,
            201: taskProjectionSchema,
            403: Type.Union([
              authorizationForbiddenResponseSchema,
              taskCreationForbiddenProblemSchema,
            ]),
            409: Type.Union([
              workAccessGrantConcurrentUpdateProblemSchema,
              taskCommandConflictProblemSchema,
              taskLabelConflictProblemSchema,
            ]),
            413: taskBodyTooLargeProblemSchema,
            422: taskContractRejectedProblemSchema,
            429: Type.Union([workAccessGrantExhaustedProblemSchema, taskCapacityProblemSchema]),
            503: taskUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const owner = await authorize(
          reply,
          request.headers.authorization,
          'task:create',
          configuration,
        );
        if (owner === undefined) {
          return;
        }
        const outcome = await configuration.conversation.create({
          protectedCredentials: new ProtectedCredentials([
            bearerSecret(request.headers.authorization),
          ]),
          owner,
          command: request.body,
        });
        await sendCreateOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );

    server.get(
      '/api/tasks',
      {
        schema: {
          operationId: 'listTasks',
          headers: workAccessAuthorizationHeadersSchema,
          querystring: taskListQuerySchema,
          response: {
            ...authorizationProblems,
            200: taskListProjectionSchema,
            400: taskRequestInvalidProblemSchema,
            503: taskUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const owner = await authorize(
          reply,
          request.headers.authorization,
          'task:read',
          configuration,
        );
        if (owner === undefined) {
          return;
        }
        const outcome = await configuration.conversation.list({
          ownerAid: owner.ownerAid,
          query: request.query,
        });
        await sendReadOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );

    server.get(
      '/api/tasks/by-label/:label',
      {
        schema: {
          operationId: 'inspectTaskByLabel',
          headers: workAccessAuthorizationHeadersSchema,
          params: taskLabelParametersSchema,
          response: {
            ...authorizationProblems,
            200: taskProjectionSchema,
            400: taskRequestInvalidProblemSchema,
            404: taskNotFoundProblemSchema,
            503: taskUnavailableProblemSchema,
          },
        },
      },
      async (request, reply) => {
        const owner = await authorize(
          reply,
          request.headers.authorization,
          'task:read',
          configuration,
        );
        if (owner === undefined) {
          return;
        }
        const outcome = await configuration.conversation.inspect({
          ownerAid: owner.ownerAid,
          label: request.params.label,
        });
        await sendReadOutcome(reply, outcome, configuration.newCorrelationId());
      },
    );

    done();
  };
}
