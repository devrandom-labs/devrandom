import { type FailedOperation, type Operation, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure, reasonFromUnknown } from './identity-error.js';

const operationReferenceSchema = Type.Object({ name: Type.String({ minLength: 1 }) });

function operationName(value: unknown, stage: string): string {
  if (!Value.Check(operationReferenceSchema, value)) {
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage,
      reason: 'operation reference has no name',
    });
  }
  return value.name;
}

function isFailedOperation(operation: Operation): operation is FailedOperation {
  return operation.done && 'error' in operation;
}

async function latestOperation(
  client: SignifyClient,
  name: string,
  stage: string,
): Promise<Operation> {
  try {
    return await client.operations().get(name);
  } catch (cause) {
    throw new IdentityFailure(
      {
        kind: 'keria-unavailable',
        stage,
        reason: reasonFromUnknown(cause),
      },
      cause,
    );
  }
}

export async function completeSignifyOperation(
  client: SignifyClient,
  reference: unknown,
  stage: string,
  timeoutMs: number,
): Promise<void> {
  const name = operationName(reference, stage);
  const pending = await latestOperation(client, name, stage);

  try {
    const completed = await client.operations().wait(pending, {
      signal: AbortSignal.timeout(timeoutMs),
      maxSleep: Math.min(1_000, timeoutMs),
    });
    await client.operations().delete(completed.name);
  } catch (cause) {
    const latest = await latestOperation(client, name, stage);
    if (isFailedOperation(latest)) {
      throw new IdentityFailure(
        {
          kind: 'keria-operation-failed',
          operationName: latest.name,
          stage,
          status: latest.error.code,
          reason: latest.error.message,
        },
        cause,
      );
    }
    if (latest.done) {
      await client.operations().delete(latest.name);
      return;
    }
    throw new IdentityFailure(
      {
        kind: 'keria-operation-timeout',
        operationName: latest.name,
        stage,
      },
      cause,
    );
  }
}
