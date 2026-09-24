import { Saider, type SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import type { CredentialPayloadSchema } from './credential-delivery.js';
import { IdentityFailure } from './identity-error.js';
import { completeSignifyOperation } from './signify-operation.js';

const schemaDocument = Type.Object(
  { $id: Type.String({ minLength: 1 }) },
  { additionalProperties: true },
);

export interface CredentialSchemaAvailability {
  resolve(schemaOobi: string): Promise<void>;
  verify(): Promise<void>;
}

export function verifyCredentialSchemaEvidence(evidence: unknown, expectedSaid: string): void {
  if (!Value.Check(schemaDocument, evidence) || evidence.$id !== expectedSaid) {
    throw new IdentityFailure({
      kind: 'keria-response-invalid',
      stage: 'credential schema readiness',
      reason: 'response does not identify the exact credential schema',
    });
  }

  try {
    const schemaSaid = new Saider({ qb64: evidence.$id });
    if (!schemaSaid.verify(evidence, true, false, undefined, '$id')) {
      throw new IdentityFailure({
        kind: 'keria-response-invalid',
        stage: 'credential schema readiness',
        reason: 'credential schema content is not bound by its SAID',
      });
    }
  } catch (cause) {
    if (cause instanceof IdentityFailure) {
      throw cause;
    }
    throw new IdentityFailure(
      {
        kind: 'keria-response-invalid',
        stage: 'credential schema readiness',
        reason: 'credential schema SAID is invalid',
      },
      cause,
    );
  }
}

export function signifyCredentialSchemaAvailability(
  client: SignifyClient,
  expected: CredentialPayloadSchema,
  operationTimeoutMs: number,
): CredentialSchemaAvailability {
  const retrieve = async (): Promise<unknown> => client.schemas().get(expected.$id);
  const verify = async (): Promise<void> => {
    let evidence: unknown;
    try {
      evidence = await retrieve();
    } catch (cause) {
      throw unavailable(cause);
    }
    verifyCredentialSchemaEvidence(evidence, expected.$id);
  };

  return {
    async resolve(schemaOobi) {
      try {
        const evidence = await retrieve();
        verifyCredentialSchemaEvidence(evidence, expected.$id);
        return;
      } catch (cause) {
        if (!schemaNotFound(cause, expected.$id)) {
          if (cause instanceof IdentityFailure) {
            throw cause;
          }
          throw unavailable(cause);
        }
      }

      try {
        await completeSignifyOperation(
          client,
          await client.oobis().resolve(schemaOobi, 'devrandom-credential-schema'),
          'credential schema resolution',
          operationTimeoutMs,
        );
      } catch (cause) {
        if (cause instanceof IdentityFailure) {
          throw cause;
        }
        throw unavailable(cause);
      }
      await verify();
    },
    verify,
  };
}

function schemaNotFound(cause: unknown, expectedSaid: string): boolean {
  return (
    cause instanceof Error && cause.message.startsWith(`HTTP GET /schema/${expectedSaid} - 404 `)
  );
}

function unavailable(cause: unknown): IdentityFailure {
  return new IdentityFailure(
    {
      kind: 'keria-unavailable',
      stage: 'credential schema readiness',
      reason: cause instanceof Error ? cause.message : 'credential schema request failed',
    },
    cause,
  );
}
