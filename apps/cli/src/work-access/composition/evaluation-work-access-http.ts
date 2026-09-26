import { isDeepStrictEqual } from 'node:util';
import {
  EvaluationWorkAccess,
  type EvaluationWorkAccessSupply,
} from '../application/evaluation-work-access.js';
import type { ServerEvaluationHttp } from '../../harness/infrastructure/server-evaluation-http.js';

/** Concrete HTTP wiring for one Evaluation; all retained consumers see this stable client. */
export function evaluationWorkAccessHttp(
  supply: EvaluationWorkAccessSupply,
  origin: string,
  signal: AbortSignal,
) {
  const adapt = (access: EvaluationWorkAccessSupply['initial']) => {
    const expected = access.server.grant;
    return {
      id: expected.attemptId,
      origin,
      userAid: expected.userAid,
      credentialSaid: expected.credentialSaid,
      clientInstanceId: expected.clientInstanceId,
      issuerAid: expected.issuerRecipientAid,
      scopes: [...expected.scopes],
      policyFingerprint: expected.policyFingerprint,
      deadline: access.grantDeadline,
      server: access.server,
      observe: async () => {
        try {
          const observed = await access.server.observeWorkAccessAttempt();
          const actual = observed.attempt;
          if (
            observed.kind !== 'Observed' ||
            actual.kind !== 'Granted' ||
            actual.attemptId !== expected.attemptId ||
            actual.commandId !== expected.commandId ||
            actual.grantSecretHash !== expected.grantSecretHash ||
            actual.userAid !== expected.userAid ||
            actual.credentialSaid !== expected.credentialSaid ||
            actual.clientInstanceId !== expected.clientInstanceId ||
            actual.issuerRecipientAid !== expected.issuerRecipientAid ||
            actual.policyFingerprint !== expected.policyFingerprint ||
            !isDeepStrictEqual(actual.scopes, expected.scopes) ||
            actual.disposition.kind !== 'Active' ||
            expected.disposition.kind !== 'Active' ||
            actual.disposition.expiresAt !== expected.disposition.expiresAt ||
            Date.parse(actual.disposition.expiresAt) <= Date.now()
          )
            return { kind: 'Denied' as const };
          return {
            kind: 'Active' as const,
            remainingRequests: actual.disposition.remainingRequests,
          };
        } catch {
          return { kind: 'Unavailable' as const };
        }
      },
      release: () => supply.release(access),
    };
  };
  const access = new EvaluationWorkAccess<ReturnType<typeof adapt>>(
    adapt(supply.initial),
    async (signal) => {
      const next = await supply.acquire(signal);
      if (
        next.kind === 'AttemptRejected' ||
        next.kind === 'ServerRejected' ||
        next.kind === 'ServerResponseInvalid' ||
        (next.kind === 'GrantInactive' && next.disposition === 'Revoked')
      )
        return { kind: 'Denied' as const };
      return next.kind === 'Granted' ? adapt(next) : undefined;
    },
    signal,
  );
  type Client = ServerEvaluationHttp;
  const calls: Pick<Client, keyof Client> = {
    prepare: (...args) => access.request((grant) => grant.server.evaluations().prepare(...args)),
    admit: (...args) => access.request((grant) => grant.server.evaluations().admit(...args)),
    appendEvidence: (...args) =>
      access.request((grant) => grant.server.evaluations().appendEvidence(...args)),
    readPosition: (...args) =>
      access.request((grant) => grant.server.evaluations().readPosition(...args), true),
    readEvidencePage: (...args) =>
      access.request((grant) => grant.server.evaluations().readEvidencePage(...args)),
    readPublicArtifact: (...args) =>
      access.request((grant) => grant.server.evaluations().readPublicArtifact(...args)),
    renewLease: (...args) =>
      access.request((grant) => grant.server.evaluations().renewLease(...args), true),
    lockManifest: (...args) =>
      access.request((grant) => grant.server.evaluations().lockManifest(...args)),
    inspectManifestLock: (...args) =>
      access.request((grant) => grant.server.evaluations().inspectManifestLock(...args)),
    closeEvidence: (...args) =>
      access.request((grant) => grant.server.evaluations().closeEvidence(...args)),
  };
  // Preserve the existing nominal client type without exposing or copying its
  // private bearer. Explicit public operations forward to the admitted client.
  const evaluations = new Proxy(supply.initial.server.evaluations(), {
    get(_target, name): unknown {
      switch (name) {
        case 'prepare':
          return calls.prepare;
        case 'admit':
          return calls.admit;
        case 'appendEvidence':
          return calls.appendEvidence;
        case 'readPosition':
          return calls.readPosition;
        case 'readEvidencePage':
          return calls.readEvidencePage;
        case 'readPublicArtifact':
          return calls.readPublicArtifact;
        case 'renewLease':
          return calls.renewLease;
        case 'lockManifest':
          return calls.lockManifest;
        case 'inspectManifestLock':
          return calls.inspectManifestLock;
        case 'closeEvidence':
          return calls.closeEvidence;
        default:
          throw new Error('EvaluationWorkAccessOperation');
      }
    },
  });
  const readArtifact: ReturnType<
    EvaluationWorkAccessSupply['initial']['server']['evidence']
  >['readArtifact'] = (...args) =>
    access.request((grant) => grant.server.evidence().readArtifact(...args));
  const context = (
    inventory: Parameters<EvaluationWorkAccessSupply['initial']['server']['context']>[0],
  ) => {
    const initial = supply.initial.server.context(inventory);
    const retrieve: typeof initial.retrieval.retrieve = (...args) =>
      access.request(
        (grant) => grant.server.context(inventory).retrieval.retrieve(...args),
        false,
        2,
      );
    const read: typeof initial.reading.read = (...args) =>
      access.request((grant) => grant.server.context(inventory).reading.read(...args));
    return {
      retrieval: new Proxy(initial.retrieval, {
        get(_target, name): unknown {
          if (name === 'retrieve') return retrieve;
          throw new Error('EvaluationRetrievalOperation');
        },
      }),
      reading: new Proxy(initial.reading, {
        get(_target, name): unknown {
          if (name === 'read') return read;
          throw new Error('EvaluationReadingOperation');
        },
      }),
    };
  };
  type Server = EvaluationWorkAccessSupply['initial']['server'];
  const inspectRun: ReturnType<Server['runs']>['inspect'] = (...args) =>
    access.request((grant) => grant.server.runs().inspect(...args));
  const readSuccessorSegment: ReturnType<Server['runs']>['readSuccessorSegment'] = (...args) =>
    access.request((grant) => grant.server.runs().readSuccessorSegment(...args));
  const inspectEvidence: ReturnType<Server['evidence']>['inspect'] = (...args) =>
    access.request((grant) => grant.server.evidence().inspect(...args));
  const readVerifierReceipt: ReturnType<Server['evidence']>['readVerifierReceipt'] = (...args) =>
    access.request((grant) => grant.server.evidence().readVerifierReceipt(...args));
  return {
    evaluations,
    // Fresh proof must not hold the comparison lock needed by lease renewal.
    appendEvidence: (
      upload: Parameters<Client['appendEvidence']>[0],
      signal: AbortSignal,
      sequenceMutation: <T>(effect: () => Promise<T>) => Promise<T>,
    ): ReturnType<Client['appendEvidence']> =>
      access.request((grant) =>
        sequenceMutation(() => grant.server.evaluations().appendEvidence(upload, signal)),
      ),
    readArtifact,
    context,
    qualification: {
      runs: { inspect: inspectRun, readSuccessorSegment },
      evidence: { inspect: inspectEvidence, readArtifact, readVerifierReceipt },
    },
    close: () => access.close(),
  };
}
