import { randomUUID } from 'node:crypto';

import { type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import Fastify from 'fastify';
import { Binary, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { acquireFirstRunLease } from '@devrandom/domain';
import { prepareEvidenceArtifact } from '@devrandom/protocol';

import { runCommandFingerprint, runFixture, runOwnerAid } from '../../run/test/run-fixture.js';
import { MongoRunBootstrap } from '../../run/infrastructure/mongo-run-bootstrap.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { encodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import { evidenceRoutes } from '../route/evidence-routes.js';
import { evidenceCollectionNames } from './evidence-storage-contract.js';
import { MongoEvidenceArtifacts } from './mongo-evidence-artifacts.js';
import { MongoEvidenceBootstrap } from './mongo-evidence-bootstrap.js';
import { MongoRunArtifactReading } from './mongo-run-artifact-reading.js';

const uri = process.env.DEVRANDOM_MONGODB_URI;
const describeMongo = uri === undefined ? describe.skip : describe;
const ownerBearer = `A${'s'.repeat(42)}`;
const foreignBearer = `A${'x'.repeat(42)}`;
const foreignOwnerAid = `E${'z'.repeat(43)}`;
const rawBytes = new TextEncoder().encode('raw qualification receipt\n');

describeMongo('listening Run artifact exact-read boundary', () => {
  const client = new MongoClient(uri ?? 'mongodb://127.0.0.1:27017');
  const database = client.db(`devrandom_run_artifact_read_${randomUUID().replaceAll('-', '')}`);
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  let address: string;

  beforeAll(async () => {
    await client.connect();
    await new MongoRunBootstrap(database).bootstrap();
    await new MongoEvidenceBootstrap(database).bootstrap();
    const acquired = acquireFirstRunLease(runFixture(), {
      incarnationId: randomUUID(),
      expectedRunVersion: 0,
      serverTime: '2026-09-24T20:00:00.000Z',
    });
    if (acquired.kind !== 'Acquired') throw new Error('Run lease fixture failed');
    await database
      .collection<RunDocument>(runsCollectionName)
      .insertOne(encodeRunDocument(acquired.run, runCommandFingerprint));
    const artifacts = new MongoEvidenceArtifacts(client, database);
    const reading = new MongoRunArtifactReading(database);
    await server.register(
      evidenceRoutes({
        access: {
          authorize: ({ bearerSecret }) =>
            Promise.resolve(
              bearerSecret === ownerBearer
                ? { kind: 'EvidenceAccessAuthorized' as const, ownerAid: runOwnerAid }
                : bearerSecret === foreignBearer
                  ? { kind: 'EvidenceAccessAuthorized' as const, ownerAid: foreignOwnerAid }
                  : { kind: 'EvidenceAccessInvalid' as const },
            ),
        },
        conversation: {
          admitArtifact: (input) => artifacts.admit(input),
          readArtifact: (input) => reading.read(input),
          acceptBatch: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
          reconcileSeal: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
          inspectTimeline: () => Promise.resolve({ kind: 'EvidenceRunNotFound' }),
        },
        now: () => '2026-09-24T20:00:01.000Z',
        newCorrelationId: randomUUID,
      }),
    );
    address = await server.listen({ host: '127.0.0.1', port: 0 });
  });

  afterAll(async () => {
    await server.close();
    await database.dropDatabase();
    await client.close();
  });

  it('reads exact uploaded bytes and bounded retries, conceals other owners, and detects corrupt custody', async () => {
    const prepared = prepareEvidenceArtifact(rawBytes, 'text/plain; charset=utf-8');
    if (prepared.kind !== 'Prepared') throw new Error('artifact fixture failed');
    const url = `${address}/api/runs/${runFixture().binding.runId}/artifacts/${prepared.artifact.d}`;
    const upload = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ownerBearer}`,
        'content-type': prepared.artifact.mediaType,
      },
      body: rawBytes,
    });
    expect(upload.status).toBe(201);

    const exact = await fetch(url, { headers: { authorization: `Bearer ${ownerBearer}` } });
    expect(exact.status).toBe(200);
    expect(new Uint8Array(await exact.arrayBuffer())).toEqual(rawBytes);
    expect(exact.headers.get('content-type')).toBe('application/octet-stream');
    expect(exact.headers.get('x-devrandom-artifact-media-type')).toBe(prepared.artifact.mediaType);
    expect(exact.headers.get('cache-control')).toBe('no-store');

    const rangeHeaders = { authorization: `Bearer ${ownerBearer}`, range: 'bytes=4-12' };
    const first = await fetch(url, { headers: rangeHeaders });
    const retry = await fetch(url, { headers: rangeHeaders });
    expect(first.status).toBe(206);
    expect(retry.status).toBe(206);
    expect(first.headers.get('content-range')).toBe(`bytes 4-12/${String(rawBytes.byteLength)}`);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(rawBytes.slice(4, 13));
    expect(new Uint8Array(await retry.arrayBuffer())).toEqual(rawBytes.slice(4, 13));

    const foreign = await fetch(`${url}?ownerAid=${runOwnerAid}`, {
      headers: { authorization: `Bearer ${foreignBearer}` },
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.text()).not.toContain('qualification receipt');
    const absent = await fetch(
      `${address}/api/runs/${runFixture().binding.runId}/artifacts/E${'x'.repeat(43)}`,
      {
        headers: { authorization: `Bearer ${ownerBearer}` },
      },
    );
    expect(absent.status).toBe(404);

    await database
      .collection(evidenceCollectionNames.artifacts)
      .updateOne(
        { runId: runFixture().binding.runId, 'artifact.d': prepared.artifact.d },
        { $set: { bytes: new Binary(new TextEncoder().encode('tampered')) } },
      );
    const corrupt = await fetch(url, { headers: { authorization: `Bearer ${ownerBearer}` } });
    expect(corrupt.status).toBe(503);
    expect(await corrupt.text()).not.toContain('tampered');
  });
});
