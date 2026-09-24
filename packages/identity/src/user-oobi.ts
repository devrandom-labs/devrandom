import type { SignifyClient } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure, reasonFromUnknown } from './identity-error.js';
import { agentAid, type AgentAid, type UserAid } from './keri-identifier.js';

const resolvedOobiSchema = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    done: Type.Literal(true),
    response: Type.Object(
      {
        i: Type.String({ minLength: 1 }),
        d: Type.String({ minLength: 1 }),
        s: Type.String({ minLength: 1 }),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

export interface UserOobiResolutionInput {
  readonly userAid: UserAid;
  readonly userAgentOobi: string;
}

export interface ResolvedUserOobi {
  readonly userAid: UserAid;
  readonly agentAid: AgentAid;
}

export interface IssuerUserOobiResolution {
  resolve(input: UserOobiResolutionInput): Promise<ResolvedUserOobi>;
}

function invalidUserOobi(reason: string, cause?: unknown): never {
  throw new IdentityFailure(
    { kind: 'user-oobi-invalid', reason },
    cause === undefined ? undefined : cause,
  );
}

export function verifyResolvedUserOobiEvidence(
  oobi: string,
  expectedUserAid: UserAid,
  evidence: unknown,
): ResolvedUserOobi {
  let parsed: URL;
  try {
    parsed = new URL(oobi);
  } catch (cause) {
    return invalidUserOobi('value is not a URL', cause);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return invalidUserOobi('value is not a plain HTTP OOBI URL');
  }
  const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
  if (
    segments.length !== 4 ||
    segments[0] !== 'oobi' ||
    segments[1] !== expectedUserAid ||
    segments[2] !== 'agent' ||
    segments[3] === undefined
  ) {
    return invalidUserOobi('URL does not bind the expected user AID and one agent endpoint');
  }

  if (!Value.Check(resolvedOobiSchema, evidence) || evidence.response.i !== expectedUserAid) {
    return invalidUserOobi('resolved key state does not bind the expected user AID');
  }

  try {
    return { userAid: expectedUserAid, agentAid: agentAid(segments[3]) };
  } catch (cause) {
    return invalidUserOobi('URL agent endpoint is not a valid KERI AID', cause);
  }
}

export function signifyIssuerUserOobiResolution(
  client: SignifyClient,
  operationTimeoutMs: number,
): IssuerUserOobiResolution {
  return {
    async resolve(input) {
      let operation;
      try {
        operation = await client.oobis().resolve(input.userAgentOobi);
      } catch (cause) {
        throw new IdentityFailure(
          {
            kind: 'keria-unavailable',
            stage: 'user OOBI resolution submission',
            reason: reasonFromUnknown(cause),
          },
          cause,
        );
      }

      let evidence: unknown;
      try {
        evidence = await client.operations().wait(operation, {
          signal: AbortSignal.timeout(operationTimeoutMs),
          maxSleep: Math.min(1_000, operationTimeoutMs),
        });
      } catch (cause) {
        throw new IdentityFailure(
          {
            kind: 'keria-unavailable',
            stage: 'user OOBI resolution completion',
            reason: reasonFromUnknown(cause),
          },
          cause,
        );
      }
      return verifyResolvedUserOobiEvidence(input.userAgentOobi, input.userAid, evidence);
    },
  };
}
