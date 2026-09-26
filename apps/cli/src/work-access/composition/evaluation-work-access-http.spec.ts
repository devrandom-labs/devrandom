import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  prepareEvaluationEvidenceEvent,
  prepareEvaluationEvidenceBatch,
  workAccessScopes,
} from '@devrandom/protocol';
import { expect, it, vi } from 'vitest';
import type { GrantedWorkAccessProjection } from '../infrastructure/server-work-access-http.js';
import { acquireWorkAccess } from '../application/work-access-acquisition.js';
import {
  confirmCurrentUserCustody,
  ProtectedCredentials,
  decideUserAdmission,
  verifyDevrandomUserCredential,
  type AdmittedUser,
} from '@devrandom/domain';
import { challengeResponseSaid } from '@devrandom/identity';
import { clientInstanceId } from '../../identity/domain/user-profile.js';
import { createWorkAccessAttemptBodySchema } from '@devrandom/protocol';
import Value from 'typebox/value';
import type { GrantedEvaluationAccess } from '../application/evaluation-work-access.js';
import { evaluationWorkAccessHttp } from './evaluation-work-access-http.js';

const userAid = 'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4';
const credentialSaid = 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho';
const issuerAid = 'EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh';
function admittedUser(): AdmittedUser {
  const custody = confirmCurrentUserCustody({
    user: { aid: userAid },
    controllerAid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
    keriaAgentAid: 'EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs',
    kelSequence: 0,
    witnessAids: ['BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha'],
    witnessThreshold: 1,
    witnessReceiptIndexes: [0],
    verifiedAt: '2026-09-24T12:00:00.000Z',
  });
  if (custody.kind !== 'Current') {
    throw new Error('test custody must be current');
  }
  const credential = verifyDevrandomUserCredential(
    {
      issuerAid,
      issueeAid: userAid,
      registryId: 'EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK',
      schemaSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
    },
    {
      credentialSaid,
      attributeSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
      issuerAid,
      issueeAid: userAid,
      registryId: 'EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK',
      schemaSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
      issuedAt: '2026-09-24T11:00:00.000Z',
      verifiedAt: '2026-09-24T12:00:00.000Z',
      credentialSaidBinding: { kind: 'Verified' },
      attributeSaidBinding: { kind: 'Verified' },
      schemaDocument: {
        kind: 'Resolved',
        schemaSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
      },
      telState: { kind: 'Issued' },
      issuerAnchor: {
        kind: 'Anchored',
        eventSaid: 'EJ6aiZ1xOnnCKGKhOn9LEit6k5eolN26_mB9P_YD0Jfs',
      },
      eligibilityClaims: [
        'CreateAgent',
        'CreateTask',
        'RunPrivateTask',
        'PublishHarness',
        'ReceiveTaskResults',
      ],
    },
  );
  if (credential.kind !== 'Current') {
    throw new Error('test credential must be current');
  }
  const admission = decideUserAdmission({
    kind: 'CurrentCustody',
    custody: custody.custody,
    credential: { kind: 'Current', credential: credential.credential },
  });
  if (admission.kind !== 'Ready') {
    throw new Error('test admission must be ready');
  }
  return admission.user;
}

async function exerciseRollover(scenario: 'continuity' | 'slow-proof-sequencing') {
  // Synthetic localhost admission/ledger. Real HTTP clients, no live identity,
  // MongoDB, provider, Evaluation lease extension or native effects are claimed.
  const evaluationId = randomUUID();
  const streamId = randomUUID();
  const leaseId = randomUUID();
  const leaseStartedAt = Date.now() - 31_000;
  let leaseRenewals = 0;
  const proofAllowed = Promise.withResolvers<undefined>();
  const renewalAllowed = Promise.withResolvers<undefined>();
  const renewalArrived = Promise.withResolvers<undefined>();
  let appendRequests = 0;
  const said = (letter: string) => `E${letter.repeat(43)}`;
  const event = prepareEvaluationEvidenceEvent({
    evaluationId,
    streamId,
    originRunId: randomUUID(),
    taskId: randomUUID(),
    taskRevisionSaid: said('t'),
    personalAgentAid: said('a'),
    taskMandateSaid: said('m'),
    harnessRevisionSaid: said('h'),
    phase: { kind: 'Research', policySaid: said('p'), role: 'DiagnosticRefiner' },
    sequence: 0,
    previous: { kind: 'Genesis' },
    occurredAt: new Date().toISOString(),
    detail: {
      kind: 'UsageDebited',
      providerRequests: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      spendMicroUsd: 1,
      elapsedMilliseconds: 1,
    },
  });
  if (event.kind !== 'Prepared') throw new Error('event');
  const batch = prepareEvaluationEvidenceBatch([event.event]);
  if (batch.kind !== 'Prepared') throw new Error('batch');
  const upload = {
    version: 1 as const,
    commandId: randomUUID(),
    fingerprint: `sha256:${'a'.repeat(64)}`,
    batch: batch.batch,
    events: [event.event],
    publicArtifacts: [],
    protectedArtifacts: [],
  };
  const ledger = new Map<
    string,
    { grant: GrantedWorkAccessProjection; remaining: number; charged: number; released: boolean }
  >();
  const commandBodies = new Set<string>();
  let observations = 0;
  let acquisitions = 0;
  const attempts = new Map<string, GrantedWorkAccessProjection>();
  const responseSaid = challengeResponseSaid('EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4');
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader('cache-control', 'no-store');
      response.setHeader('content-type', 'application/json');
      if (request.method === 'POST' && request.url === '/api/work-access-attempts') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
        const command: unknown = JSON.parse(Buffer.concat(chunks).toString());
        if (!Value.Check(createWorkAccessAttemptBodySchema, command))
          throw new Error('attempt command');
        acquisitions++;
        const grant: GrantedWorkAccessProjection = {
          ...command,
          kind: 'Granted',
          attemptId: randomUUID(),
          issuerRecipientAid: issuerAid,
          attemptExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          verifiedResponseSaid: responseSaid,
          scopes: [...workAccessScopes],
          policyFingerprint: `sha256:${'b'.repeat(64)}`,
          disposition: {
            kind: 'Active',
            expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
            remainingRequests: 2000,
          },
        };
        attempts.set(grant.attemptId, grant);
        response.writeHead(201).end(
          JSON.stringify({
            ...command,
            attemptId: grant.attemptId,
            issuerRecipientAid: issuerAid,
            attemptExpiresAt: grant.attemptExpiresAt,
            kind: 'AwaitingProof',
            challengeWords: Array.from({ length: 24 }, (_value, index) => `word-${String(index)}`),
          }),
        );
        return;
      }
      if (request.method === 'PUT' && request.url?.endsWith('/proof')) {
        const id = request.url.split('/')[3] ?? '';
        const grant = attempts.get(id);
        const secret = request.headers.authorization?.slice(7) ?? '';
        if (
          grant === undefined ||
          grant.grantSecretHash !==
            `sha256:${createHash('sha256').update(Buffer.from(secret, 'base64url')).digest('hex')}`
        )
          throw new Error('proof binding');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
        expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({
          version: 1,
          responseSaid,
        });
        ledger.set(secret, { grant, remaining: 2000, charged: 0, released: false });
        const binding = Object.fromEntries(
          Object.entries(grant).filter(
            ([key]) =>
              !['disposition', 'scopes', 'policyFingerprint', 'verifiedResponseSaid'].includes(key),
          ),
        );
        response
          .writeHead(202)
          .end(JSON.stringify({ ...binding, kind: 'VerifyingProof', responseSaid }));
        return;
      }
      const held = ledger.get(request.headers.authorization?.slice(7) ?? '');
      if (held === undefined) throw new Error('unknown synthetic grant');
      if (request.url?.startsWith('/api/work-access-attempts/')) {
        if (request.method === 'DELETE') {
          held.released = true;
          response.writeHead(204).end();
          return;
        }
        observations++;
        response.end(
          JSON.stringify({
            ...held.grant,
            disposition: held.released
              ? { kind: 'Released', releasedAt: new Date().toISOString() }
              : held.remaining === 0
                ? { kind: 'Exhausted' }
                : {
                    kind: 'Active',
                    expiresAt:
                      held.grant.disposition.kind === 'Active'
                        ? held.grant.disposition.expiresAt
                        : '',
                    remainingRequests: held.remaining,
                  },
          }),
        );
        return;
      }
      if (held.remaining === 0 || held.released) {
        response.writeHead(403).end(
          JSON.stringify({
            status: 403,
            code: 'EvaluationAccessDenied',
            title: 'Denied',
            type: 'https://devrandom.example/denied',
            correlationId: randomUUID(),
          }),
        );
        return;
      }
      held.remaining--;
      held.charged++;
      if (request.url?.endsWith('/position')) {
        expect(held.grant.attemptId).toBe(initial.server.grant.attemptId);
        response.end(
          JSON.stringify({
            version: 1,
            currentEvaluationVersion: 1,
            evaluationId,
            ownerAid: userAid,
            commandId: upload.commandId,
            originRunId: event.event.originRunId,
            streamId,
            reservationSaid: said('r'),
            acceptedThroughSequence: -1,
            chainHeadSaid: null,
            lease: {
              evaluationId,
              leaseId,
              version: 1,
              serverTime: new Date().toISOString(),
              expiresAt: new Date(leaseStartedAt + 45_000).toISOString(),
            },
          }),
        );
        return;
      }
      if (request.method === 'GET') {
        expect(held.grant.attemptId).not.toBe(initial.server.grant.attemptId);
        response.writeHead(404, { 'cache-control': 'no-store' }).end('{}');
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const encoded = Buffer.concat(chunks).toString();
      if (request.url?.endsWith('/lease')) {
        const command = JSON.parse(encoded) as {
          evaluationId: string;
          leaseId: string;
          expectedEvaluationVersion: number;
        };
        expect(command).toMatchObject({ evaluationId, leaseId, expectedEvaluationVersion: 1 });
        expect(Date.now() - leaseStartedAt).toBeGreaterThanOrEqual(30_000);
        expect(Date.now() - leaseStartedAt).toBeLessThan(45_000);
        leaseRenewals++;
        if (scenario === 'slow-proof-sequencing') {
          renewalArrived.resolve(undefined);
          await renewalAllowed.promise;
        }
        response.end(
          JSON.stringify({
            kind: 'Renewed',
            evaluationId,
            version: 2,
            lease: {
              evaluationId,
              leaseId,
              version: 2,
              serverTime: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 45_000).toISOString(),
            },
          }),
        );
        return;
      }
      commandBodies.add(encoded);
      appendRequests++;
      response.writeHead(200).end(
        JSON.stringify({
          version: 1,
          disposition: 'AlreadyAccepted',
          evaluationId,
          streamId,
          batchSaid: batch.batch.d,
          acceptedThroughSequence: 0,
          chainHeadSaid: event.event.d,
        }),
      );
    })().catch(() => {
      response.writeHead(500).end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('listen');
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const identity = {
    kind: 'Ready' as const,
    user: admittedUser(),
    clientInstanceId: clientInstanceId(randomUUID()),
    userAidProof: { respond: () => Promise.resolve(responseSaid) },
    protectedCredentials: new ProtectedCredentials(),
  };
  const acquire = async (signal?: AbortSignal): Promise<GrantedEvaluationAccess> => {
    const acquired = await acquireWorkAccess(origin, identity, undefined, signal);
    if (acquired.kind !== 'Granted') throw new Error(`synthetic acquisition: ${acquired.kind}`);
    return acquired;
  };
  const initial = await acquire();
  const initialLedger = [...ledger.values()][0];
  if (initialLedger === undefined) throw new Error('initial grant');
  if (scenario === 'slow-proof-sequencing') initialLedger.remaining = 128;
  const freshProof = vi.fn(async (signal: AbortSignal) => {
    if (scenario === 'slow-proof-sequencing') await proofAllowed.promise;
    return acquire(signal);
  });
  const stopped = new AbortController();
  const transport = evaluationWorkAccessHttp(
    { initial, acquire: freshProof, release: (grant) => grant.server.releaseGrant() },
    origin,
    stopped.signal,
  );
  const capturedClient = transport.evaluations;
  const capturedQualification = transport.qualification;
  try {
    if (scenario === 'slow-proof-sequencing') {
      let mutationFinished = Promise.resolve();
      let sequencerEntries = 0;
      const sequenceMutation = <T>(effect: () => Promise<T>): Promise<T> => {
        sequencerEntries++;
        const pending = mutationFinished.then(() => {
          stopped.signal.throwIfAborted();
          return effect();
        });
        mutationFinished = pending.then(
          () => undefined,
          () => undefined,
        );
        return pending;
      };
      const append = transport.appendEvidence(upload, stopped.signal, sequenceMutation);
      void append.catch(() => undefined);
      await vi.waitFor(() => {
        expect(freshProof).toHaveBeenCalledTimes(1);
      });
      expect(sequencerEntries).toBe(0);
      expect(appendRequests).toBe(0);
      const maintenance = sequenceMutation(async () => {
        expect(await capturedClient.readPosition(evaluationId)).toMatchObject({ kind: 'Read' });
        return capturedClient.renewLease({
          version: 1,
          commandId: randomUUID(),
          fingerprint: `sha256:${'c'.repeat(64)}`,
          evaluationId,
          leaseId,
          expectedEvaluationVersion: 1,
        });
      });
      await renewalArrived.promise;
      expect(acquisitions).toBe(1);
      expect(leaseRenewals).toBe(1);
      proofAllowed.resolve(undefined);
      await vi.waitFor(
        () => {
          expect(sequencerEntries).toBe(2);
        },
        { timeout: 5000 },
      );
      expect(appendRequests).toBe(0);
      expect(initialLedger.released).toBe(false);
      renewalAllowed.resolve(undefined);
      expect(await maintenance).toMatchObject({
        kind: 'Renewed',
        receipt: { evaluationId, lease: { leaseId } },
      });
      expect(await append).toMatchObject({
        kind: 'Acknowledged',
        acknowledgement: { batchSaid: batch.batch.d, chainHeadSaid: event.event.d },
      });
      await vi.waitFor(() => {
        expect(initialLedger.released).toBe(true);
      });
      expect(appendRequests).toBe(1);
      expect(commandBodies).toEqual(new Set([JSON.stringify(upload)]));
      expect([...ledger.values()].map((held) => held.charged)).toEqual([2, 1]);
      return;
    }
    for (let index = 0; index < 2100; index++) {
      expect(await capturedClient.appendEvidence(upload)).toMatchObject({
        kind: 'Acknowledged',
        acknowledgement: { batchSaid: batch.batch.d, chainHeadSaid: event.event.d },
      });
    }
    expect(
      await capturedClient.renewLease({
        version: 1,
        commandId: randomUUID(),
        fingerprint: `sha256:${'c'.repeat(64)}`,
        evaluationId,
        leaseId,
        expectedEvaluationVersion: 1,
      }),
    ).toMatchObject({ kind: 'Renewed', receipt: { evaluationId, lease: { leaseId } } });
    expect(leaseRenewals).toBe(1);
    const runId = randomUUID();
    // These callbacks are retained before rollover and reused by later H0 qualification.
    // Missing fixture history is intentional; each actual GET must use the new bearer.
    expect(await capturedQualification.runs.inspect(runId)).toEqual({ kind: 'ResponseInvalid' });
    expect(await capturedQualification.evidence.inspect(runId, { limit: 100 })).toEqual({
      kind: 'ResponseInvalid',
    });
    expect(await capturedQualification.evidence.readArtifact(runId, event.event.d)).toEqual({
      kind: 'NotFound',
    });
    expect(await capturedQualification.evidence.readVerifierReceipt(runId, event.event.d)).toEqual({
      kind: 'NotFound',
    });
    expect(acquisitions).toBeGreaterThan(1);
    expect([...ledger.values()].every((item) => item.charged <= 2000)).toBe(true);
    expect([...ledger.values()].reduce((sum, item) => sum + item.charged, 0)).toBe(2105);
    expect([...ledger.values()].filter((item) => item.released).length).toBe(acquisitions - 1);
    expect(commandBodies).toEqual(new Set([JSON.stringify(upload)]));
    expect(observations).toBeGreaterThan(0);
    expect(observations).toBeLessThan(150);
  } finally {
    stopped.abort();
    proofAllowed.resolve(undefined);
    renewalAllowed.resolve(undefined);
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
}

it.each(['continuity', 'slow-proof-sequencing'] as const)(
  'keeps exact Evaluation HTTP commands, ACKs and maintenance through rollover: %s',
  exerciseRollover,
  30_000,
);
