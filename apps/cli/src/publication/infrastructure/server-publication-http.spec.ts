import { randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { expect, it } from 'vitest';
import {
  prepareEvidenceArtifact,
  prepareHarnessPackage,
  prepareSuccessorHarnessRevision,
  type PublicationAdmission,
  type PublishHarnessCommand,
} from '@devrandom/protocol';
import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { evaluatePortableBehavior } from '../application/evaluate-portable-behavior.js';
import { NodePortableBehaviorReference } from './node-portable-behavior-reference.js';
import { ServerPublicationHttp } from './server-publication-http.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
async function commandFixture(): Promise<PublishHarnessCommand> {
  const text = 'Run public verification before completion.';
  const bytes = Buffer.from(JSON.stringify({ version: 1, arm: 'C1', instructionText: text }));
  const configuration = prepareEvidenceArtifact(bytes, 'application/json');
  if (configuration.kind !== 'Prepared') throw new Error('configuration fixture');
  const revision = prepareSuccessorHarnessRevision({
    parentRevisionSaid: said('h'),
    h0Said: said('o'),
    taskRevisionSaid: said('t'),
    sourceInventorySaid: said('i'),
    executionProfileSaid: said('p'),
    configurationArtifactSaid: configuration.artifact.d,
    arm: 'C1',
    treatment: { kind: 'Instruction' },
  });
  if (revision.kind !== 'Prepared') throw new Error('revision fixture');
  const prepared = prepareHarnessPackage({
    publisherAid: said('a'),
    sourceRevisionSaid: revision.revision.d,
    behavior: { kind: 'Instruction', text },
  });
  if (prepared.kind !== 'Prepared') throw new Error('package fixture');
  const verified = await evaluatePortableBehavior(
    prepared.package,
    new NodePortableBehaviorReference(),
  );
  if (verified.kind !== 'Passed') throw new Error('portable reference');
  return {
    version: 1,
    commandId: randomUUID(),
    taskId: randomUUID(),
    activationReceiptSaid: said('r'),
    sourceRevision: revision.revision,
    configurationBase64: bytes.toString('base64'),
    published: {
      package: prepared.package,
      verification: verified.verification,
      // Transport fixture only; cryptographic signature verification belongs to the caller.
      signature: { exchange: {}, signatures: ['A'.repeat(88)], keyStateSaid: said('k') },
    },
  };
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture address');
  const decoded = decodeDevrandomServerOrigin(`http://127.0.0.1:${String(address.port)}`);
  if (decoded.kind !== 'Accepted') throw new Error('origin fixture');
  return decoded.origin;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    }),
  );
}
it.each(['Published', 'AlreadyPublished'] as const)(
  'binds a real HTTP %s receipt to the submitted package before reporting success',
  async (kind) => {
    const command = await commandFixture();
    let acknowledgement: PublicationAdmission = { kind, packageSaid: said('z') };
    let status = kind === 'Published' ? 201 : 200;
    const requests: { url: string | undefined; headers: IncomingHttpHeaders; body: unknown }[] = [];
    // Disposable peer fixture for the CLI adapter, not a second product HTTP service.
    const server = createServer((request, response) => {
      const receive = async () => {
        let text = '';
        request.setEncoding('utf8');
        for await (const chunk of request) text += String(chunk);
        requests.push({ url: request.url, headers: request.headers, body: JSON.parse(text) });
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(acknowledgement));
      };
      void receive().catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    try {
      const origin = await listen(server);
      const client = new ServerPublicationHttp(origin, fetch, 'transport-fixture');
      expect(await client.publish(command)).toEqual({ kind: 'Unavailable' });
      acknowledgement = { kind, packageSaid: command.published.package.d };
      expect(await client.publish(command)).toEqual(acknowledgement);
      status = 503;
      expect(await client.publish(command)).toEqual({ kind: 'Unavailable' });
      acknowledgement = { kind: 'Unavailable' };
      expect(await client.publish(command)).toEqual({ kind: 'Unavailable' });
      expect(await new ServerPublicationHttp(origin, fetch).publish(command)).toEqual({
        kind: 'Rejected',
      });
      expect(requests).toHaveLength(4);
      for (const request of requests) {
        expect(request.url).toBe(`/api/harness-packages/${command.published.package.d}`);
        expect(request.headers.authorization).toBe('Bearer transport-fixture');
        expect(request.body).toEqual(command);
      }
    } finally {
      await close(server);
    }
  },
);
it('fetches only the exact public package without forwarding publisher authorization', async () => {
  const command = await commandFixture();
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    headers.push(request.headers);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(command.published));
  });
  try {
    const origin = await listen(server);
    const client = new ServerPublicationHttp(origin, fetch, 'must-not-reach-public-read');
    expect(await client.fetch(command.published.package.d)).toEqual({
      kind: 'Fetched',
      published: command.published,
    });
    expect(await client.fetch(said('z'))).toEqual({ kind: 'Rejected' });
    expect(headers).toHaveLength(2);
    expect(headers.every((header) => header.authorization === undefined)).toBe(true);
  } finally {
    await close(server);
  }
});
