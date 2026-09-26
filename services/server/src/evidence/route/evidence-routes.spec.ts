import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { acquireFirstRunLease, acceptEvidenceBatch, createEvidenceStream } from '@devrandom/domain';
import {
  prepareEvidenceArtifact,
  prepareEvidenceBatch,
  prepareEvidenceEvent,
} from '@devrandom/protocol';

import { runFixture } from '../../run/test/run-fixture.js';
import {
  evidenceRoutes,
  type EvidenceConversation,
  type EvidenceRoutesConfiguration,
} from './evidence-routes.js';

const ownerAid = `E${'a'.repeat(43)}`;
const runId = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
const bearer = `A${'s'.repeat(42)}`;
const evidenceStreamId = 'a30aae94-a652-485f-a2cc-8980134f4acc';
const incarnationId = 'b5c5f13e-63df-4a4f-b1fc-08df00150f15';

function batchBody(resource?: string) {
  const preparedEvent = prepareEvidenceEvent({
    version: 1,
    sequence: 0,
    predecessor: { kind: 'Genesis' },
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: `E${'t'.repeat(43)}`,
    runId,
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    harnessRevisionSaid: `E${'h'.repeat(43)}`,
    personalAgentAid: `E${'p'.repeat(43)}`,
    taskMandateSaid: `E${'m'.repeat(43)}`,
    occurredAt: '2026-09-24T20:00:00.000Z',
    recordedAt: '2026-09-24T20:00:00.001Z',
    producer: { kind: 'RunSupervisor' },
    event: { kind: 'RunStarted', fromRunVersion: 1 },
  });
  if (preparedEvent.kind !== 'Prepared') {
    throw new Error('event fixture failed');
  }
  const events = [preparedEvent.event];
  if (resource !== undefined) {
    const proposed = prepareEvidenceEvent({
      version: 1,
      sequence: 1,
      predecessor: { kind: 'Previous', eventSaid: preparedEvent.event.d },
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      taskRevisionSaid: `E${'t'.repeat(43)}`,
      runId,
      incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
      harnessRevisionSaid: `E${'h'.repeat(43)}`,
      personalAgentAid: `E${'p'.repeat(43)}`,
      taskMandateSaid: `E${'m'.repeat(43)}`,
      occurredAt: '2026-09-24T20:00:01.000Z',
      recordedAt: '2026-09-24T20:00:01.001Z',
      producer: { kind: 'ToolGateway' },
      event: {
        kind: 'ToolProposed',
        piSessionId: 'b1ef07c8-4790-4eee-95c8-44cac2b7a7ed',
        modelTurnId: 'turn-1',
        toolCallId: 'call-1',
        proposalIndex: 0,
        tool: 'read_file',
        requiredCapability: 'ReadRepository',
        resource,
      },
    });
    if (proposed.kind !== 'Prepared') throw new Error('tool proposal fixture failed');
    events.push(proposed.event);
  }
  const preparedBatch = prepareEvidenceBatch({
    version: 1,
    runId,
    evidenceStreamId,
    events,
  });
  if (preparedBatch.kind !== 'Prepared') {
    throw new Error('batch fixture failed');
  }
  return {
    version: 1 as const,
    batch: preparedBatch.batch,
    events,
  };
}

function pendingSealStream() {
  const acquired = acquireFirstRunLease(runFixture(), {
    incarnationId,
    expectedRunVersion: 0,
    serverTime: '2026-09-24T20:00:00.000Z',
  });
  if (acquired.kind !== 'Acquired') {
    throw new Error('Run lease fixture failed');
  }
  const created = createEvidenceStream({
    streamId: acquired.run.binding.evidenceStreamId,
    runId: acquired.run.binding.runId,
    ownerAid: acquired.run.binding.ownerAid,
    taskId: acquired.run.binding.taskId,
    taskRevisionSaid: acquired.run.binding.taskRevisionSaid,
    incarnationId,
    harnessRevisionSaid: acquired.run.binding.initialHarnessRevisionSaid,
    personalAgentAid: acquired.run.binding.personalAgentAid,
    taskMandateSaid: acquired.run.binding.taskMandateSaid,
    combinedByteCeiling: acquired.run.binding.budget.evidencePlusArtifactsPerRunBytes,
  });
  if (created.kind !== 'Created') {
    throw new Error('Evidence stream fixture failed');
  }
  const accepted = acceptEvidenceBatch(created.stream, {
    batchSaid: `E${'b'.repeat(43)}`,
    startingSequence: 0,
    endingSequence: 0,
    predecessor: { kind: 'Genesis' },
    eventSaids: [`E${'v'.repeat(43)}`],
    encodedBytes: 128,
    checkpoint: {
      kind: 'Present',
      checkpointSaid: `E${'c'.repeat(43)}`,
      lifecycle: {
        kind: 'Active',
        phase: {
          kind: 'Blocked',
          reason: 'HarnessCompatibilityFailure',
          checkpointSaid: `E${'c'.repeat(43)}`,
        },
      },
      submissionVerification: { kind: 'NotSubmitted' },
    },
  });
  if (accepted.kind !== 'Accepted') {
    throw new Error('Evidence acceptance fixture failed');
  }
  return accepted.stream;
}

function configuration(
  conversation: EvidenceRoutesConfiguration['conversation'],
): EvidenceRoutesConfiguration {
  return {
    access: {
      authorize: vi.fn().mockResolvedValue({ kind: 'EvidenceAccessAuthorized', ownerAid }),
    },
    conversation,
    now: () => '2026-09-24T20:01:00.000Z',
    newCorrelationId: randomUUID,
  };
}

function conversation(): EvidenceRoutesConfiguration['conversation'] {
  return {
    admitArtifact: vi.fn().mockResolvedValue({ kind: 'EvidenceRunNotFound' }),
    readArtifact: vi.fn().mockResolvedValue({ kind: 'NotFound' }),
    acceptBatch: vi.fn().mockResolvedValue({ kind: 'EvidenceRunNotFound' }),
    reconcileSeal: vi.fn().mockResolvedValue({ kind: 'EvidenceRunNotFound' }),
    inspectTimeline: vi.fn().mockResolvedValue({ kind: 'EvidenceRunNotFound' }),
  };
}

describe('Evidence HTTP routes', () => {
  it('returns exact Run artifact bytes through the owner-authorized public read route', async () => {
    const bytes = new TextEncoder().encode('retained raw receipt');
    const prepared = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
    if (prepared.kind !== 'Prepared') throw new Error('artifact fixture failed');
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await server.register(
      evidenceRoutes(
        configuration({
          ...conversation(),
          readArtifact: vi.fn().mockResolvedValue({
            kind: 'Read',
            artifact: prepared.artifact,
            bytes,
          }),
        }),
      ),
    );

    const response = await server.inject({
      method: 'GET',
      url: `/api/runs/${runId}/artifacts/${prepared.artifact.d}`,
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(Buffer.from(bytes));
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['etag']).toBe(`"${prepared.artifact.d}"`);
    await server.close();
  });

  it('returns deterministic bounded ranges and hides bytes after scope denial', async () => {
    const bytes = new TextEncoder().encode('0123456789');
    const prepared = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
    if (prepared.kind !== 'Prepared') throw new Error('artifact fixture failed');
    const readArtifact = vi.fn().mockResolvedValue({
      kind: 'Read',
      artifact: prepared.artifact,
      bytes,
    });
    const access = vi.fn().mockResolvedValue({ kind: 'EvidenceAccessAuthorized', ownerAid });
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await server.register(
      evidenceRoutes({
        ...configuration({ ...conversation(), readArtifact }),
        access: { authorize: access },
      }),
    );
    const url = `/api/runs/${runId}/artifacts/${prepared.artifact.d}`;
    const headers = { authorization: `Bearer ${bearer}`, range: 'bytes=2-5' };

    const first = await server.inject({ method: 'GET', url, headers });
    const retry = await server.inject({ method: 'GET', url, headers });
    expect(first.statusCode).toBe(206);
    expect(first.rawPayload).toEqual(Buffer.from('2345'));
    expect(first.headers['content-range']).toBe('bytes 2-5/10');
    expect(retry.rawPayload).toEqual(first.rawPayload);
    expect(access).toHaveBeenCalledWith(expect.objectContaining({ scope: 'run:read' }));
    expect(readArtifact).toHaveBeenCalledWith({
      ownerAid,
      runId,
      artifactSaid: prepared.artifact.d,
    });

    const invalid = await server.inject({
      method: 'GET',
      url,
      headers: { ...headers, range: 'bytes=0-70000' },
    });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe('bytes */10');
    expect(invalid.payload).not.toContain('0123456789');

    access.mockResolvedValue({ kind: 'EvidenceAccessScopeRejected' });
    readArtifact.mockClear();
    const denied = await server.inject({ method: 'GET', url, headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({
      code: 'WorkAccessGrantScopeRejected',
      requiredScope: 'run:read',
    });
    expect(readArtifact).not.toHaveBeenCalled();
    await server.close();
  });

  it.each([
    'application/octet-stream',
    'application/json',
    'text/plain; charset=utf-8',
    'text/x-diff; charset=utf-8',
  ] as const)(
    'keeps %s artifact content as exact raw bytes and recomputes its SAID',
    async (mediaType) => {
      const bytes = new TextEncoder().encode('{"literal":"bytes"}');
      const prepared = prepareEvidenceArtifact(bytes, mediaType);
      if (prepared.kind !== 'Prepared') {
        throw new Error('artifact fixture failed');
      }
      const admitArtifact = vi.fn<EvidenceConversation['admitArtifact']>((input) =>
        Promise.resolve({
          kind: 'EvidenceArtifactStored',
          acknowledgement: {
            version: 1,
            disposition: 'Stored',
            runId,
            artifact: input.artifact,
            receivedAt: input.receivedAt,
          },
        }),
      );
      const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
      const conversations = conversation();
      await server.register(evidenceRoutes(configuration({ ...conversations, admitArtifact })));

      const response = await server.inject({
        method: 'PUT',
        url: `/api/runs/${runId}/artifacts/${prepared.artifact.d}`,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': mediaType },
        payload: Buffer.from(bytes),
      });

      expect(response.statusCode).toBe(201);
      expect(admitArtifact).toHaveBeenCalledWith({
        ownerAid,
        runId,
        artifact: prepared.artifact,
        bytes,
        receivedAt: '2026-09-24T20:01:00.000Z',
      });
      await server.close();
    },
  );

  it('rejects a changed artifact path SAID without invoking persistence', async () => {
    const bytes = new TextEncoder().encode('evidence');
    const prepared = prepareEvidenceArtifact(bytes, 'application/octet-stream');
    if (prepared.kind !== 'Prepared') {
      throw new Error('artifact fixture failed');
    }
    const admitArtifact = vi.fn<EvidenceConversation['admitArtifact']>().mockResolvedValue({
      kind: 'EvidenceRunNotFound',
    });
    const conversations = { ...conversation(), admitArtifact };
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await server.register(evidenceRoutes(configuration(conversations)));

    const response = await server.inject({
      method: 'PUT',
      url: `/api/runs/${runId}/artifacts/E${'z'.repeat(43)}`,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from(bytes),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'EvidenceRejected',
      reason: 'ArtifactSaidMismatch',
    });
    expect(admitArtifact).not.toHaveBeenCalled();
    await server.close();
  });

  it('rejects artifact bytes containing the authorized grant bearer before persistence', async () => {
    const bytes = new TextEncoder().encode(`captured output: ${bearer}`);
    const prepared = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
    if (prepared.kind !== 'Prepared') {
      throw new Error('artifact fixture failed');
    }
    const admitArtifact = vi.fn<EvidenceConversation['admitArtifact']>().mockResolvedValue({
      kind: 'EvidenceRunNotFound',
    });
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await server.register(evidenceRoutes(configuration({ ...conversation(), admitArtifact })));

    const response = await server.inject({
      method: 'PUT',
      url: `/api/runs/${runId}/artifacts/${prepared.artifact.d}`,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'text/plain; charset=utf-8',
      },
      payload: Buffer.from(bytes),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'EvidenceRejected', reason: 'SecretDetected' });
    const mismatchedPath = await server.inject({
      method: 'PUT',
      url: `/api/runs/${runId}/artifacts/E${'z'.repeat(43)}`,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'text/plain; charset=utf-8',
      },
      payload: Buffer.from(bytes),
    });
    expect(mismatchedPath.statusCode).toBe(422);
    expect(mismatchedPath.json()).toMatchObject({
      code: 'EvidenceRejected',
      reason: 'SecretDetected',
    });
    expect(admitArtifact).not.toHaveBeenCalled();
    await server.close();
  });

  it('maps an ordered batch gap without weakening the durable cursor', async () => {
    const body = batchBody();
    const acceptBatch = vi.fn().mockResolvedValue({
      kind: 'EvidenceSequenceGap',
      expectedStartingSequence: 4,
      receivedStartingSequence: 0,
    });
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    const conversations = conversation();
    await server.register(evidenceRoutes(configuration({ ...conversations, acceptBatch })));

    const response = await server.inject({
      method: 'PUT',
      url: `/api/runs/${runId}/evidence-batches/${body.batch.d}`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: body,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'EvidenceConflict',
      reason: 'SequenceGap',
      expectedStartingSequence: 4,
      receivedStartingSequence: 0,
    });
    expect(acceptBatch).toHaveBeenCalledWith({
      ownerAid,
      parameters: { runId, batchSaid: body.batch.d },
      body,
      receivedAt: '2026-09-24T20:01:00.000Z',
    });
    await server.close();
  });

  it('rejects a SAID-bound evidence event whose resource contains its authorized bearer', async () => {
    const body = batchBody(`file://${bearer}`);
    const acceptBatch = vi.fn<EvidenceConversation['acceptBatch']>().mockResolvedValue({
      kind: 'EvidenceRunNotFound',
    });
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await server.register(evidenceRoutes(configuration({ ...conversation(), acceptBatch })));

    const response = await server.inject({
      method: 'PUT',
      url: `/api/runs/${runId}/evidence-batches/${body.batch.d}`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: body,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'EvidenceRejected', reason: 'SecretDetected' });
    expect(acceptBatch).not.toHaveBeenCalled();
    await server.close();
  });

  it('decodes bounded timeline query values and authorizes the exact read scope', async () => {
    const inspectTimeline = vi.fn().mockResolvedValue({
      kind: 'EvidenceTimelineFound',
      page: {
        version: 1,
        stream: {
          version: 1,
          runId,
          evidenceStreamId,
          cursor: { kind: 'Empty' },
          checkpoint: { kind: 'Absent' },
          seal: { kind: 'Unsealed' },
        },
        events: [],
        nextCursor: null,
      },
    });
    const access = {
      authorize: vi.fn().mockResolvedValue({ kind: 'EvidenceAccessAuthorized', ownerAid }),
    };
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    const conversations = conversation();
    await server.register(
      evidenceRoutes({
        ...configuration({ ...conversations, inspectTimeline }),
        access,
      }),
    );

    const response = await server.inject({
      method: 'GET',
      url: `/api/runs/${runId}/timeline?limit=7&cursor=opaque.cursor`,
      headers: { authorization: `Bearer ${bearer}` },
    });

    expect(response.statusCode).toBe(200);
    expect(access.authorize).toHaveBeenCalledWith({
      bearerSecret: bearer,
      scope: 'run:read',
      observedAt: '2026-09-24T20:01:00.000Z',
    });
    expect(inspectTimeline).toHaveBeenCalledWith({
      ownerAid,
      runId,
      query: { limit: 7, cursor: 'opaque.cursor' },
    });
    await server.close();
  });

  it('reports a pending personal-agent seal without marking the stream sealed', async () => {
    const sealExchangeSaid = `E${'s'.repeat(43)}`;
    const stream = pendingSealStream();
    const reconcileSeal = vi.fn().mockResolvedValue({
      kind: 'EvidenceSealPending',
      sealExchangeSaid,
      stream,
    });
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    const conversations = conversation();
    await server.register(evidenceRoutes(configuration({ ...conversations, reconcileSeal })));

    const response = await server.inject({
      method: 'PUT',
      url: `/api/runs/${runId}/evidence-seal`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      payload: { version: 1, sealExchangeSaid },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      runId,
      seal: { kind: 'SealExchangePending', sealExchangeSaid },
    });
    expect(reconcileSeal).toHaveBeenCalledWith({
      ownerAid,
      runId,
      sealExchangeSaid,
      observedAt: '2026-09-24T20:01:00.000Z',
    });
    await server.close();
  });

  it('rejects an oversized raw artifact before persistence', async () => {
    const bytes = new Uint8Array(512 * 1_024 + 1);
    const admitArtifact = vi.fn<EvidenceConversation['admitArtifact']>().mockResolvedValue({
      kind: 'EvidenceRunNotFound',
    });
    const conversations = { ...conversation(), admitArtifact };
    const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
    await server.register(evidenceRoutes(configuration(conversations)));

    const response = await server.inject({
      method: 'PUT',
      url: `/api/runs/${runId}/artifacts/E${'z'.repeat(43)}`,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/octet-stream',
      },
      payload: Buffer.from(bytes),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      code: 'EvidenceQuotaExceeded',
      reason: 'RequestBodyTooLarge',
    });
    expect(admitArtifact).not.toHaveBeenCalled();
    await server.close();
  });
});
