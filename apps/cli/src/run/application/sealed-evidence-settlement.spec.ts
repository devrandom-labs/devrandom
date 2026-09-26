import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireFirstRunLease, createRun, taskBudgetCeilings, type Run } from '@devrandom/domain';
import {
  IdentityFailure,
  issuerAid,
  personalAgentAid,
  type LocalEvidenceSealExchange,
} from '@devrandom/identity';
import { preparePublicVerifierReceipt, prepareVerifiedCheckpoint } from '@devrandom/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { ServerEvidenceHttp } from '../infrastructure/server-evidence-http.js';
import { SqliteEvidenceOutboxes } from '../infrastructure/sqlite-evidence-outbox.js';
import type { HostedEvidence } from './evidence-delivery.js';
import type { HostedEvidenceSeals } from './evidence-seal-delivery.js';
import { SealedEvidenceSettlement } from './sealed-evidence-settlement.js';

const temporaryDirectories: string[] = [];
const temporaryServers: Array<ReturnType<typeof createServer>> = [];
const personalAgent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const issuer = issuerAid('EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh');

function said(character: string): string {
  return `E${character.repeat(43)}`;
}

function leasedRun(): Run {
  const created = createRun({
    runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    ownerAid: said('a'),
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: said('b'),
    harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
    personalAgentAid: personalAgent,
    taskMandateSaid: said('d'),
    governorAid: said('e'),
    promotionMandateSaid: said('f'),
    initialHarnessRevisionSaid: said('g'),
    purpose: { kind: 'Retained' },
    initialSpecialization: {
      kind: 'InitialSpecializationAccepted',
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      harnessRevisionSaid: said('g'),
      runId: '3cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      acceptedAt: '2026-09-24T19:59:00.000Z',
    },
    repository: { objectFormat: 'sha1', commit: '1'.repeat(40), tree: '2'.repeat(40) },
    commandId: 'd2c9160a-58f8-4d43-ae67-22124c6e9112',
    admissionExchangeSaid: said('h'),
    evidenceStreamId: 'a1975db1-6130-41c2-b9dd-c8ec8bc12c94',
    budget: taskBudgetCeilings,
    acceptedAt: '2026-09-24T20:00:00.000Z',
  });
  if (created.kind !== 'Created') throw new Error('fixture Run must create');
  const leased = acquireFirstRunLease(created.run, {
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:01.000Z',
  });
  if (leased.kind !== 'Acquired') throw new Error('fixture Run lease must be acquired');
  return leased.run;
}

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-sealed-settlement-'));
  temporaryDirectories.push(root);
  const state = join(root, 'state');
  await mkdir(state, { mode: 0o700 });
  await chmod(state, 0o700);
  return state;
}

afterEach(async () => {
  await Promise.all(
    temporaryServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        }),
    ),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('sealed evidence settlement', () => {
  it.each([
    'Pending',
    'TransientPreparation',
    'UnavailablePreparation',
    'InvalidPreparation',
    'InterruptedPreparationRetry',
    'LostBatchResponse',
    'TransientBatchRejection',
    'LostResponsesEachBatch',
    'UnavailableBatch',
    'InvalidBatch',
    'LostDeliveryResponse',
    'UnavailableDelivery',
    'InvalidDelivery',
    'LostResponse',
    'TransientSealRejection',
    'TransientAcknowledgement',
    'UnavailableAcknowledgement',
    'ThrownResponse',
    'Unavailable',
    'InvalidResponse',
    'ReenterSeal',
    'ReenterDelivery',
    'AlreadySealed',
    'ReenterChangedCursor',
  ] as const)(
    'reconciles %s with bounded observations of one signed exchange',
    async (firstObservation) => {
      const run = leasedRun();
      let instant = 2;
      const opened = new SqliteEvidenceOutboxes(
        () => `2026-09-24T20:00:${String(instant++).padStart(2, '0')}.000Z`,
      ).open({ run, stateRoot: await stateRoot() });
      if (opened.kind !== 'Opened') throw new Error('fixture evidence outbox must open');
      const started = opened.recorder.record({
        occurredAt: '2026-09-24T20:00:02.000Z',
        producer: { kind: 'RunSupervisor' },
        event: { kind: 'RunStarted', fromRunVersion: run.version },
      });
      if (started.kind !== 'Recorded') throw new Error('fixture Run start must record');
      if (run.lease.kind !== 'Held') throw new Error('fixture Run must hold its lease');
      const receipt = preparePublicVerifierReceipt({
        version: 1,
        completionConditionId: 'legacy-compatibility',
        commandSaid: said('i'),
        recordedAt: '2026-09-24T20:00:03.000Z',
        outcome: {
          kind: 'Rejected',
          reason: { kind: 'UnexpectedExitCode', expected: 0, observed: 1 },
          elapsedMilliseconds: 20,
          outputArtifactSaids: [],
        },
      });
      if (receipt.kind !== 'Prepared') throw new Error('fixture receipt must prepare');
      const prepared = prepareVerifiedCheckpoint(
        {
          version: 1,
          taskId: run.binding.taskId,
          taskRevisionSaid: run.binding.taskRevisionSaid,
          runId: run.binding.runId,
          incarnationId: run.lease.incarnationId,
          harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
          harnessLineageId: run.binding.harnessLineageId,
          personalAgentAid: run.binding.personalAgentAid,
          governorAid: run.binding.governorAid,
          taskMandateSaid: run.binding.taskMandateSaid,
          promotionMandateSaid: run.binding.promotionMandateSaid,
          purpose: run.binding.purpose,
          repository: {
            objectFormat: run.binding.repository.objectFormat,
            baseCommit: run.binding.repository.commit,
            baseTree: run.binding.repository.tree,
            changedFiles: [],
          },
          outputArtifactSaids: [],
          verifierReceipts: [receipt.receipt],
          evidence: { eventCount: 1, finalSequence: 0, chainHeadSaid: started.event.d },
          budget: { consumed: run.consumedBudget, remaining: run.binding.budget },
          runState: {
            kind: 'Active',
            phase: { kind: 'Blocked', reason: 'HarnessCompatibilityFailure' },
            verification: { kind: 'Rejected' },
          },
          continuation: { kind: 'LaterHarnessCompatibilityResolutionRequired' },
        },
        ['legacy-compatibility'],
      );
      if (prepared.kind !== 'Prepared') throw new Error('fixture checkpoint must prepare');
      expect(
        opened.recorder.storeCheckpoint({
          checkpoint: prepared.checkpoint,
          completionConditionIds: ['legacy-compatibility'],
        }),
      ).toMatchObject({ kind: 'Stored' });
      expect(
        opened.recorder.record({
          occurredAt: '2026-09-24T20:00:04.000Z',
          producer: { kind: 'EvidenceRecorder' },
          event: { kind: 'CheckpointVerified', checkpointSaid: prepared.checkpoint.d },
        }),
      ).toMatchObject({ kind: 'Recorded' });
      expect(
        opened.recorder.record({
          occurredAt: '2026-09-24T20:00:05.000Z',
          producer: { kind: 'RunSupervisor' },
          event: {
            kind: 'RunBlocked',
            reason: 'HarnessCompatibilityFailure',
            checkpointSaid: prepared.checkpoint.d,
          },
        }),
      ).toMatchObject({ kind: 'Recorded' });

      const beforeAcknowledgement = opened.recorder.readiness();
      expect(opened.recorder.recordCheckpointAcceptance(prepared.checkpoint.d)).toEqual({
        kind: 'ObservationRejected',
      });
      expect(opened.recorder.readiness()).toEqual(beforeAcknowledgement);
      let acceptedThroughSequence = -1;
      let chainHeadSaid = '';
      let checkpointSaid: string | undefined;
      const hostedEvidence = {
        storeArtifact: vi.fn().mockResolvedValue({ kind: 'InputInvalid' }),
        appendBatch: vi.fn<HostedEvidence['appendBatch']>((_runId, body) => {
          const last = body.events.at(-1);
          if (last === undefined) throw new Error('fixture batch must contain an event');
          acceptedThroughSequence = body.batch.endingSequence;
          chainHeadSaid = last.d;
          checkpointSaid = body.checkpoint?.d ?? checkpointSaid;
          return Promise.resolve({
            kind: 'Accepted',
            acknowledgement: {
              version: 1,
              disposition: { kind: 'Accepted' },
              runId: run.binding.runId,
              evidenceStreamId: run.binding.evidenceStreamId,
              batchSaid: body.batch.d,
              acceptedThroughSequence,
              chainHeadSaid,
              receivedAt: '2026-09-24T20:00:06.000Z',
            },
          });
        }),
      } satisfies HostedEvidence;
      if (firstObservation === 'LostBatchResponse') {
        const append = hostedEvidence.appendBatch.getMockImplementation();
        if (append === undefined) throw new Error('fixture append must exist');
        hostedEvidence.appendBatch.mockImplementationOnce(async (...arguments_) => {
          await append(...arguments_);
          return { kind: 'ServerUnavailable' };
        });
      }
      if (firstObservation === 'TransientBatchRejection') {
        const append = hostedEvidence.appendBatch.getMockImplementation();
        if (append === undefined) throw new Error('fixture append must exist');
        hostedEvidence.appendBatch.mockImplementationOnce(async (...arguments_) => {
          await append(...arguments_);
          return {
            kind: 'RequestRejected',
            problem: {
              type: 'https://devrandom.example/problems/evidence-unavailable',
              title: 'Evidence dependency is unavailable',
              status: 503,
              code: 'EvidenceUnavailable',
              dependency: 'HostedMongoDB',
              correlationId: run.binding.runId,
            },
          };
        });
      }
      if (firstObservation === 'LostResponsesEachBatch') {
        const append = hostedEvidence.appendBatch.getMockImplementation();
        if (append === undefined) throw new Error('fixture append must exist');
        const attempts = new Map<string, number>();
        hostedEvidence.appendBatch.mockImplementation(async (...arguments_) => {
          const result = await append(...arguments_);
          const batchSaid = arguments_[1].batch.d;
          const attempt = (attempts.get(batchSaid) ?? 0) + 1;
          attempts.set(batchSaid, attempt);
          return attempt < 3 ? { kind: 'ServerUnavailable' } : result;
        });
      }
      if (firstObservation === 'UnavailableBatch')
        hostedEvidence.appendBatch.mockResolvedValue({ kind: 'ServerUnavailable' });
      if (firstObservation === 'InvalidBatch')
        hostedEvidence.appendBatch.mockResolvedValue({ kind: 'ResponseInvalid' });
      let reconciliation = 0;
      const hostedSeals = {
        reconcileSeal: vi.fn<HostedEvidenceSeals['reconcileSeal']>((_runId, body) => {
          reconciliation += 1;
          if (
            (firstObservation === 'ReenterSeal' || firstObservation === 'ReenterChangedCursor') &&
            reconciliation <= 3
          )
            return Promise.resolve({ kind: 'ServerUnavailable' });
          if (firstObservation === 'Unavailable')
            return Promise.resolve({ kind: 'ServerUnavailable' });
          if (firstObservation === 'InvalidResponse')
            return Promise.resolve({ kind: 'ResponseInvalid' });
          const accepted = {
            version: 1,
            runId: run.binding.runId,
            evidenceStreamId: run.binding.evidenceStreamId,
            cursor: {
              kind: 'Accepted',
              eventCount: acceptedThroughSequence + 1,
              acceptedThroughSequence,
              chainHeadSaid,
            },
            checkpoint: { kind: 'Accepted', checkpointSaid: checkpointSaid ?? '' },
          } as const;
          if (reconciliation === 1 && firstObservation !== 'LostResponse') {
            if (firstObservation === 'TransientSealRejection')
              return Promise.resolve({
                kind: 'RequestRejected',
                problem: {
                  type: 'https://devrandom.example/problems/evidence-conflict',
                  title: 'Evidence delivery conflicts with the accepted stream',
                  status: 409,
                  code: 'EvidenceConflict',
                  reason: 'CursorConcurrentUpdate',
                  correlationId: run.binding.runId,
                },
              });
            if (firstObservation === 'ThrownResponse')
              return Promise.reject(new Error('seal response lost'));
            return Promise.resolve({
              kind: 'Pending',
              stream: {
                ...accepted,
                seal: { kind: 'SealExchangePending', sealExchangeSaid: body.sealExchangeSaid },
              },
            });
          }
          return Promise.resolve({
            kind: 'Sealed',
            stream: {
              ...accepted,
              seal: {
                kind: 'Sealed',
                sealExchangeSaid: body.sealExchangeSaid,
                eventCount: acceptedThroughSequence + 1,
                finalSequence: acceptedThroughSequence,
                chainHeadSaid,
                sealedAt: '2026-09-24T20:00:09.000Z',
              },
            },
          });
        }),
      } satisfies HostedEvidenceSeals;
      const sealRequests: Array<{
        path: string | undefined;
        authorization: string | undefined;
        body: string;
      }> = [];
      let sealTransport: HostedEvidenceSeals = hostedSeals;
      if (firstObservation === 'LostResponse') {
        const server = createServer((request, response) => {
          let body = '';
          request.setEncoding('utf8');
          request.on('data', (part: string) => {
            body += part;
          });
          request.on('end', () => {
            sealRequests.push({
              path: request.url,
              authorization: request.headers.authorization,
              body,
            });
            void hostedSeals
              .reconcileSeal(run.binding.runId, {
                version: 1,
                sealExchangeSaid: said('s'),
              })
              .then((outcome) => {
                if (sealRequests.length === 1) {
                  response.destroy();
                  return;
                }
                if (outcome.kind !== 'Sealed') {
                  response.destroy();
                  return;
                }
                response.writeHead(200, {
                  'cache-control': 'no-store',
                  'content-type': 'application/json',
                });
                response.end(JSON.stringify(outcome.stream));
              })
              .catch(() => {
                response.destroy();
              });
          });
        });
        temporaryServers.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (address === null || typeof address === 'string')
          throw new Error('missing HTTP address');
        const origin = decodeDevrandomServerOrigin(`http://127.0.0.1:${String(address.port)}`);
        if (origin.kind !== 'Accepted') throw new Error('invalid loopback origin');
        sealTransport = new ServerEvidenceHttp(origin.origin, 'a'.repeat(43), fetch);
      }
      const prepare = vi
        .fn<LocalEvidenceSealExchange['prepare']>()
        .mockResolvedValue({ exchangeSaid: said('s') });
      const deliver = vi
        .fn<LocalEvidenceSealExchange['deliver']>()
        .mockResolvedValue({ exchangeSaid: said('s') });
      const unavailableDelivery = new IdentityFailure({
        kind: 'keria-unavailable',
        stage: 'Evidence seal delivery',
        reason: 'response lost',
      });
      const unavailablePreparation = new IdentityFailure({
        kind: 'keria-unavailable',
        stage: 'Evidence seal preparation',
        reason: 'temporary dependency loss',
      });
      if (firstObservation === 'TransientPreparation')
        prepare.mockRejectedValueOnce(unavailablePreparation);
      if (
        firstObservation === 'UnavailablePreparation' ||
        firstObservation === 'InterruptedPreparationRetry'
      )
        prepare.mockRejectedValue(unavailablePreparation);
      if (firstObservation === 'InvalidPreparation')
        prepare.mockRejectedValue(
          new IdentityFailure({
            kind: 'keria-response-invalid',
            stage: 'Evidence seal preparation',
            reason: 'invalid exchange',
          }),
        );
      if (firstObservation === 'LostDeliveryResponse')
        deliver.mockRejectedValueOnce(unavailableDelivery);
      if (firstObservation === 'UnavailableDelivery')
        deliver.mockRejectedValue(unavailableDelivery);
      if (firstObservation === 'InvalidDelivery')
        deliver.mockRejectedValue(
          new IdentityFailure({
            kind: 'keria-response-invalid',
            stage: 'Evidence seal delivery',
            reason: 'invalid exchange',
          }),
        );
      if (firstObservation === 'ReenterDelivery')
        deliver.mockRejectedValueOnce(new Error('KERIA delivery response lost'));
      const exchange = {
        prepare,
        deliver,
      } satisfies LocalEvidenceSealExchange;
      const wait = vi.fn().mockResolvedValue(undefined);
      if (firstObservation === 'InterruptedPreparationRetry')
        wait.mockRejectedValue(new Error('interrupted wait'));
      const dependencies = {
        hostedEvidence,
        hostedSeals: sealTransport,
        exchange,
        sourceAid: personalAgent,
        recipientAid: issuer,
        wait,
        maximumObservations: 3,
      };
      const recordSealAcknowledgement = vi.spyOn(opened.recorder, 'recordSealAcknowledgement');
      if (firstObservation === 'TransientAcknowledgement') {
        recordSealAcknowledgement.mockImplementationOnce(() => ({
          kind: 'Unavailable',
        }));
      }
      if (firstObservation === 'UnavailableAcknowledgement') {
        recordSealAcknowledgement.mockReturnValue({
          kind: 'Unavailable',
        });
      }
      const settlement = new SealedEvidenceSettlement(dependencies);
      if (
        firstObservation === 'ReenterSeal' ||
        firstObservation === 'ReenterDelivery' ||
        firstObservation === 'ReenterChangedCursor'
      ) {
        await expect(settlement.settle(opened.recorder, prepared.checkpoint.d)).resolves.toEqual({
          kind:
            firstObservation !== 'ReenterDelivery'
              ? 'SealObservationUnavailable'
              : 'SealExchangeUnavailable',
        });
      }

      if (firstObservation === 'ReenterChangedCursor') {
        expect(
          opened.recorder.record({
            occurredAt: '2026-09-24T20:00:10.000Z',
            producer: { kind: 'RunSupervisor' },
            event: {
              kind: 'RunBlocked',
              reason: 'HarnessCompatibilityFailure',
              checkpointSaid: prepared.checkpoint.d,
            },
          }),
        ).toMatchObject({ kind: 'Recorded' });
      }
      const outcome = await new SealedEvidenceSettlement(dependencies).settle(
        opened.recorder,
        prepared.checkpoint.d,
      );

      if (firstObservation === 'UnavailableBatch' || firstObservation === 'InvalidBatch') {
        expect(outcome).toEqual({
          kind: 'EvidenceDeliveryRejected',
          outcome: {
            kind: 'BatchDeliveryRejected',
            outcome: {
              kind:
                firstObservation === 'UnavailableBatch' ? 'ServerUnavailable' : 'ResponseInvalid',
            },
          },
        });
        expect(hostedEvidence.appendBatch).toHaveBeenCalledTimes(
          firstObservation === 'UnavailableBatch' ? 3 : 1,
        );
        for (const call of hostedEvidence.appendBatch.mock.calls)
          expect(call).toEqual(hostedEvidence.appendBatch.mock.calls[0]);
        expect(wait).toHaveBeenCalledTimes(firstObservation === 'UnavailableBatch' ? 2 : 0);
        expect(prepare).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
        expect(hostedSeals.reconcileSeal).not.toHaveBeenCalled();
        expect(opened.recorder.sealAcknowledgement()).toEqual({ kind: 'NotFound' });
        expect(opened.recorder.page()).toMatchObject({ kind: 'Page' });
        opened.recorder.close();
        return;
      }
      if (
        firstObservation === 'UnavailablePreparation' ||
        firstObservation === 'InvalidPreparation' ||
        firstObservation === 'InterruptedPreparationRetry'
      ) {
        expect(outcome).toEqual({ kind: 'SealExchangeUnavailable' });
        expect(prepare).toHaveBeenCalledTimes(
          firstObservation === 'UnavailablePreparation' ? 3 : 1,
        );
        expect(wait).toHaveBeenCalledTimes(
          firstObservation === 'UnavailablePreparation'
            ? 2
            : firstObservation === 'InterruptedPreparationRetry'
              ? 1
              : 0,
        );
        for (const call of prepare.mock.calls) expect(call).toEqual(prepare.mock.calls[0]);
        expect(deliver).not.toHaveBeenCalled();
        expect(hostedSeals.reconcileSeal).not.toHaveBeenCalled();
        expect(opened.recorder.sealAcknowledgement()).toEqual({ kind: 'NotFound' });
        opened.recorder.close();
        return;
      }
      if (firstObservation === 'UnavailableDelivery' || firstObservation === 'InvalidDelivery') {
        expect(outcome).toEqual({ kind: 'SealExchangeUnavailable' });
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(deliver).toHaveBeenCalledTimes(firstObservation === 'UnavailableDelivery' ? 3 : 1);
        expect(wait).toHaveBeenCalledTimes(firstObservation === 'UnavailableDelivery' ? 2 : 0);
        expect(hostedSeals.reconcileSeal).not.toHaveBeenCalled();
        expect(hostedEvidence.appendBatch).toHaveBeenCalledTimes(2);
        expect(opened.recorder.sealAcknowledgement()).toEqual({ kind: 'NotFound' });
        opened.recorder.close();
        return;
      }
      if (firstObservation === 'ReenterChangedCursor') {
        expect(outcome).toEqual({ kind: 'EvidenceIntegrityFailure' });
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(opened.recorder.sealAcknowledgement()).toEqual({ kind: 'NotFound' });
        opened.recorder.close();
        return;
      }
      if (firstObservation === 'Unavailable' || firstObservation === 'InvalidResponse') {
        expect(outcome).toEqual(
          firstObservation === 'Unavailable'
            ? { kind: 'SealObservationUnavailable' }
            : { kind: 'SealReconciliationRejected', outcome: { kind: 'ResponseInvalid' } },
        );
        expect(hostedSeals.reconcileSeal).toHaveBeenCalledTimes(
          firstObservation === 'Unavailable' ? 3 : 1,
        );
        expect(wait).toHaveBeenCalledTimes(firstObservation === 'Unavailable' ? 2 : 0);
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(deliver).toHaveBeenCalledTimes(1);
        expect(hostedEvidence.appendBatch).toHaveBeenCalledTimes(2);
        expect(opened.recorder.sealAcknowledgement()).toEqual({ kind: 'NotFound' });
        opened.recorder.close();
        return;
      }
      if (firstObservation === 'UnavailableAcknowledgement') {
        expect(outcome).toEqual({ kind: 'EvidenceUnavailable' });
        expect(recordSealAcknowledgement).toHaveBeenCalledTimes(3);
        expect(wait).toHaveBeenCalledTimes(3);
        expect(prepare).toHaveBeenCalledOnce();
        expect(deliver).toHaveBeenCalledOnce();
        expect(hostedSeals.reconcileSeal).toHaveBeenCalledTimes(2);
        expect(opened.recorder.sealAcknowledgement()).toEqual({ kind: 'NotFound' });
        opened.recorder.close();
        return;
      }

      expect(outcome).toMatchObject({
        kind: 'Sealed',
        stream: {
          runId: run.binding.runId,
          evidenceStreamId: run.binding.evidenceStreamId,
          checkpoint: { kind: 'Accepted', checkpointSaid: prepared.checkpoint.d },
          seal: { kind: 'Sealed', sealExchangeSaid: said('s') },
        },
      });
      if (firstObservation === 'TransientAcknowledgement')
        expect(recordSealAcknowledgement).toHaveBeenCalledTimes(2);
      expect(prepare).toHaveBeenCalledWith({
        senderAlias: 'devrandom-personal-agent',
        sourceAid: run.binding.personalAgentAid,
        recipientAid: issuer,
        payload: {
          version: 1,
          kind: 'EvidenceStreamSeal',
          runId: run.binding.runId,
          evidenceStreamId: run.binding.evidenceStreamId,
          eventCount: 4,
          finalSequence: 3,
          chainHeadSaid,
          harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
          taskMandateSaid: run.binding.taskMandateSaid,
        },
        preparedAt: Date.parse('2026-09-24T20:00:06.000Z'),
      });
      if (firstObservation === 'AlreadySealed')
        await expect(
          new SealedEvidenceSettlement(dependencies).settle(opened.recorder, prepared.checkpoint.d),
        ).resolves.toEqual(outcome);
      const signingAttempts =
        firstObservation === 'ReenterSeal' ||
        firstObservation === 'ReenterDelivery' ||
        firstObservation === 'TransientPreparation'
          ? 2
          : 1;
      expect(prepare).toHaveBeenCalledTimes(signingAttempts);
      expect(deliver).toHaveBeenCalledTimes(
        firstObservation === 'TransientPreparation'
          ? 1
          : firstObservation === 'LostDeliveryResponse'
            ? 2
            : signingAttempts,
      );
      if (firstObservation === 'LostDeliveryResponse')
        expect(deliver.mock.calls[1]).toEqual(deliver.mock.calls[0]);
      if (signingAttempts === 2) expect(prepare.mock.calls[1]).toEqual(prepare.mock.calls[0]);
      expect(hostedSeals.reconcileSeal).toHaveBeenCalledTimes(
        firstObservation === 'ReenterSeal' ? 4 : 2,
      );
      expect(hostedSeals.reconcileSeal).toHaveBeenNthCalledWith(1, run.binding.runId, {
        version: 1,
        sealExchangeSaid: said('s'),
      });
      expect(hostedSeals.reconcileSeal).toHaveBeenNthCalledWith(2, run.binding.runId, {
        version: 1,
        sealExchangeSaid: said('s'),
      });
      if (firstObservation === 'LostResponse') {
        expect(sealRequests).toEqual(
          Array.from({ length: 2 }, () => ({
            path: `/api/runs/${run.binding.runId}/evidence-seal`,
            authorization: `Bearer ${'a'.repeat(43)}`,
            body: JSON.stringify({ version: 1, sealExchangeSaid: said('s') }),
          })),
        );
      }
      expect(hostedEvidence.appendBatch).toHaveBeenCalledTimes(
        firstObservation === 'LostResponsesEachBatch'
          ? 6
          : firstObservation === 'LostBatchResponse' ||
              firstObservation === 'TransientBatchRejection'
            ? 3
            : 2,
      );
      if (
        firstObservation === 'LostBatchResponse' ||
        firstObservation === 'TransientBatchRejection'
      )
        expect(hostedEvidence.appendBatch.mock.calls[1]).toEqual(
          hostedEvidence.appendBatch.mock.calls[0],
        );
      if (firstObservation === 'LostResponsesEachBatch') {
        const calls = hostedEvidence.appendBatch.mock.calls;
        expect(calls[1]).toEqual(calls[0]);
        expect(calls[2]).toEqual(calls[0]);
        expect(calls[4]).toEqual(calls[3]);
        expect(calls[5]).toEqual(calls[3]);
        expect(calls[3]?.[1].batch.d).not.toBe(calls[0]?.[1].batch.d);
      }
      expect(wait).toHaveBeenCalledTimes(
        firstObservation === 'LostResponsesEachBatch'
          ? 5
          : firstObservation === 'TransientPreparation' ||
              firstObservation === 'ReenterSeal' ||
              firstObservation === 'LostDeliveryResponse' ||
              firstObservation === 'LostBatchResponse' ||
              firstObservation === 'TransientBatchRejection' ||
              firstObservation === 'TransientAcknowledgement'
            ? 2
            : 1,
      );
      expect(wait).toHaveBeenCalledWith(1_000);
      expect(opened.recorder.sealAcknowledgement()).toMatchObject({
        kind: 'Read',
        projection: { seal: { kind: 'Sealed', sealExchangeSaid: said('s') } },
      });
      opened.recorder.close();
    },
  );
});
