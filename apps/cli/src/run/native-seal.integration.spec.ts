import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { taskBudgetCeilings } from '@devrandom/domain';
import {
  connectSignifyController,
  decodeEvidenceSealExchangeEvidence,
  issuerAid,
  personalAgentAid,
  signifyIssuerEvidenceSealExchange,
} from '@devrandom/identity';
import {
  decodeEvidenceEvent,
  decodeEvidenceArtifact,
  decodeEvidenceStreamProjection,
  evidenceSealExchangeRoute,
  taskSourceCommandSchema,
  type EvidenceEvent,
  type EvidenceSealPayload,
  type EvidenceStreamProjection,
} from '@devrandom/protocol';
import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { materializeCesrReceiptFixture } from '../../../../tooling/cesr-receipt-fixture.js';

const describeLiveSeal =
  process.env.DEVRANDOM_NATIVE_SEAL_INTEGRATION === '1' ? describe : describe.skip;
// Permit one lawful Run plus bounded Task setup, evidence settlement, and fresh status admission.
const nativeSealJourneyTimeoutMilliseconds =
  (taskBudgetCeilings.runWallTimeSeconds + 15 * 60) * 1_000;

interface CliExecution {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function executeCli(
  arguments_: readonly string[],
  workingDirectory: string,
  serverOrigin?: string,
  interruptAfterOutput?: string,
): Promise<CliExecution> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), 'apps', 'cli', 'dist', 'main.js'), ...arguments_],
      {
        cwd: workingDirectory,
        env:
          serverOrigin === undefined
            ? process.env
            : { ...process.env, DEVRANDOM_ISSUER_URL: serverOrigin },
      },
    );
    let stdout = '';
    let stderr = '';
    let interrupted = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (part: string) => {
      stdout += part;
      if (
        !interrupted &&
        interruptAfterOutput !== undefined &&
        stdout.includes(interruptAfterOutput)
      ) {
        interrupted = true;
        child.kill('SIGINT');
      }
    });
    child.stderr.on('data', (part: string) => {
      stderr += part;
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      if (exitCode === null) {
        reject(new Error(`CLI terminated by ${signal ?? 'an unknown signal'}`));
      } else {
        resolve({ exitCode, stdout, stderr });
      }
    });
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function runWithLostHostedSealReply(workingDirectory: string): Promise<{
  readonly run: CliExecution;
  readonly lostCommittedReply: boolean;
  readonly exactRetry: boolean;
}> {
  const hostedOrigin = new URL(requiredEnvironment('DEVRANDOM_ISSUER_URL'));
  const sealPath = /^\/api\/runs\/[^/]+\/evidence-seal$/u;
  const sealRequests: { readonly path: string; readonly body: string; readonly bearer: string }[] =
    [];
  let droppedIndex: number | undefined;
  const proxy = createServer((incoming, outgoing) => {
    const path = incoming.url ?? '/';
    const target = new URL(path, hostedOrigin);
    const isSeal = incoming.method === 'PUT' && sealPath.test(target.pathname);
    const parts: Buffer[] = [];
    const upstream = request(
      target,
      {
        method: incoming.method,
        headers: { ...incoming.headers, host: hostedOrigin.host },
      },
      (received) => {
        if (isSeal && received.statusCode === 200 && droppedIndex === undefined) {
          droppedIndex = sealRequests.length - 1;
          received.resume();
          received.once('end', () => {
            outgoing.destroy();
          });
          return;
        }
        outgoing.writeHead(received.statusCode ?? 502, received.headers);
        received.pipe(outgoing);
      },
    );
    upstream.once('error', () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502);
        outgoing.end();
      } else {
        outgoing.destroy();
      }
    });
    incoming.on('data', (part: Buffer) => {
      if (isSeal) parts.push(part);
      upstream.write(part);
    });
    incoming.once('end', () => {
      if (isSeal) {
        sealRequests.push({
          path,
          body: Buffer.concat(parts).toString('utf8'),
          bearer: incoming.headers.authorization ?? '',
        });
      }
      upstream.end();
    });
    incoming.once('error', () => {
      upstream.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const address = proxy.address();
  if (address === null || typeof address === 'string') {
    proxy.close();
    throw new Error('seal reply proxy did not bind localhost');
  }
  try {
    const run = await executeCli(
      ['task', 'run', 'cesr-compat'],
      workingDirectory,
      `http://127.0.0.1:${String(address.port)}`,
    );
    const lost = droppedIndex === undefined ? undefined : sealRequests[droppedIndex];
    const retry = droppedIndex === undefined ? undefined : sealRequests[droppedIndex + 1];
    return {
      run,
      lostCommittedReply: lost !== undefined,
      exactRetry:
        lost !== undefined &&
        retry !== undefined &&
        lost.path === retry.path &&
        lost.body === retry.body &&
        lost.bearer.length > 0 &&
        lost.bearer === retry.bearer,
    };
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
}

function localSeal(
  state: string,
  runId: string,
): {
  readonly firstEvent: EvidenceEvent;
  readonly lastEvent: EvidenceEvent;
  readonly eventCount: number;
  readonly events: readonly EvidenceEvent[];
  readonly projection: EvidenceStreamProjection;
} {
  const outbox = new DatabaseSync(join(state, 'runs', runId, 'outbox.sqlite'), {
    readOnly: true,
  });
  try {
    const first: unknown = outbox
      .prepare('SELECT encoded_event FROM evidence_events ORDER BY sequence ASC LIMIT 1')
      .get();
    if (typeof first !== 'object' || first === null || !('encoded_event' in first)) {
      throw new Error('local first evidence event is absent');
    }
    const encodedEvent = Reflect.get(first, 'encoded_event');
    if (typeof encodedEvent !== 'string') throw new Error('local first evidence event is invalid');
    const decoded = decodeEvidenceEvent(JSON.parse(encodedEvent) as unknown);
    if (decoded.kind !== 'Accepted') throw new Error('local first evidence event does not decode');
    const last: unknown = outbox
      .prepare('SELECT encoded_event FROM evidence_events ORDER BY sequence DESC LIMIT 1')
      .get();
    if (typeof last !== 'object' || last === null || !('encoded_event' in last)) {
      throw new Error('local last evidence event is absent');
    }
    const encodedLastEvent = Reflect.get(last, 'encoded_event');
    if (typeof encodedLastEvent !== 'string')
      throw new Error('local last evidence event is invalid');
    const decodedLast = decodeEvidenceEvent(JSON.parse(encodedLastEvent) as unknown);
    if (decodedLast.kind !== 'Accepted')
      throw new Error('local last evidence event does not decode');
    const count: unknown = outbox.prepare('SELECT COUNT(*) AS count FROM evidence_events').get();
    if (typeof count !== 'object' || count === null || !('count' in count)) {
      throw new Error('local evidence event count is absent');
    }
    const eventCount = Reflect.get(count, 'count');
    if (typeof eventCount !== 'number' || !Number.isSafeInteger(eventCount)) {
      throw new Error('local evidence event count is invalid');
    }
    const acknowledgement: unknown = outbox
      .prepare('SELECT encoded_projection FROM evidence_seal_acknowledgement WHERE singleton = 1')
      .get();
    if (
      typeof acknowledgement !== 'object' ||
      acknowledgement === null ||
      !('encoded_projection' in acknowledgement)
    ) {
      throw new Error('local durable seal acknowledgement is absent');
    }
    const encodedProjection = Reflect.get(acknowledgement, 'encoded_projection');
    if (typeof encodedProjection !== 'string') {
      throw new Error('local seal acknowledgement is invalid');
    }
    const projection = decodeEvidenceStreamProjection(JSON.parse(encodedProjection) as unknown);
    if (projection.kind !== 'Accepted') {
      throw new Error(`local seal acknowledgement is ${projection.reason}`);
    }
    const events = outbox
      .prepare('SELECT encoded_event FROM evidence_events ORDER BY sequence')
      .all()
      .map((row) => {
        if (typeof row.encoded_event !== 'string') throw new Error('event encoding unavailable');
        const event = decodeEvidenceEvent(JSON.parse(row.encoded_event) as unknown);
        if (event.kind !== 'Accepted') throw new Error('sealed event failed verification');
        return event.event;
      });
    return {
      firstEvent: decoded.event,
      lastEvent: decodedLast.event,
      eventCount,
      events,
      projection: projection.projection,
    };
  } finally {
    outbox.close();
  }
}

// Test-only transport fault: preserve the first hosted commit, withhold the next
// batch, and kill the actual CLI while its durable outbox still has pending data.
async function killDuringEvidenceDelivery(workingDirectory: string, label: string) {
  const hostedOrigin = new URL(requiredEnvironment('DEVRANDOM_ISSUER_URL'));
  let runId: string | undefined;
  let acknowledgedBatches = 0;
  const proxy = createServer((incoming, outgoing) => {
    const path = incoming.url ?? '/';
    const batch = /^\/api\/runs\/([0-9a-f-]{36})\/evidence-batches\/[^/]+$/u.exec(path);
    if (incoming.method === 'PUT' && batch !== null && acknowledgedBatches > 0) {
      runId = batch[1];
      incoming.resume();
      incoming.once('end', () => {
        child.kill('SIGKILL');
        outgoing.destroy();
      });
      return;
    }
    const upstream = request(
      new URL(path, hostedOrigin),
      { method: incoming.method, headers: { ...incoming.headers, host: hostedOrigin.host } },
      (received) => {
        if (batch !== null && (received.statusCode === 200 || received.statusCode === 201)) {
          acknowledgedBatches += 1;
        }
        outgoing.writeHead(received.statusCode ?? 502, received.headers);
        received.pipe(outgoing);
      },
    );
    upstream.once('error', () => outgoing.destroy());
    incoming.once('error', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const address = proxy.address();
  if (address === null || typeof address === 'string') throw new Error('proxy failed to listen');
  const child = spawn(
    process.execPath,
    [join(process.cwd(), 'apps/cli/dist/main.js'), 'task', 'run', label],
    {
      cwd: workingDirectory,
      env: { ...process.env, DEVRANDOM_ISSUER_URL: `http://127.0.0.1:${String(address.port)}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let diagnostics = '';
  child.stdout.on('data', (part: Buffer) => {
    diagnostics += part.toString();
  });
  child.stderr.on('data', (part: Buffer) => {
    diagnostics += part.toString();
  });
  const completion = new Promise<NodeJS.Signals | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (_code, signal) => {
      resolve(signal);
    });
  });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 300_000);
  try {
    const signal = await completion;
    expect(signal, diagnostics).toBe('SIGKILL');
    expect(acknowledgedBatches).toBe(1);
    if (runId === undefined) throw new Error('CLI did not reach the pending second batch');
    return runId;
  } finally {
    clearTimeout(deadline);
    proxy.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      proxy.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
}

async function inspectInterruptedEvidence(state: string, runId: string) {
  const directory = join(state, 'runs', runId);
  const database = new DatabaseSync(join(directory, 'outbox.sqlite'), { readOnly: true });
  try {
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    const stream = database.prepare('SELECT * FROM stream_state').get();
    if (
      stream === undefined ||
      typeof stream.next_sequence !== 'number' ||
      typeof stream.next_delivery_sequence !== 'number'
    ) {
      throw new Error('interrupted stream counters are unavailable');
    }
    expect(stream.next_delivery_sequence).toBeGreaterThan(0);
    expect(stream.next_sequence).toBeGreaterThan(stream.next_delivery_sequence);
    const events: EvidenceEvent[] = [];
    for (const row of database
      .prepare('SELECT encoded_event FROM evidence_events ORDER BY sequence')
      .all()) {
      if (typeof row.encoded_event !== 'string') throw new Error('event encoding unavailable');
      const decoded = decodeEvidenceEvent(JSON.parse(row.encoded_event) as unknown);
      if (decoded.kind !== 'Accepted') throw new Error('interrupted event does not verify');
      expect(decoded.event.sequence).toBe(events.length);
      const previous = events.at(-1);
      expect(decoded.event.predecessor).toEqual(
        previous === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: previous.d },
      );
      events.push(decoded.event);
    }
    expect(events).toHaveLength(stream.next_sequence);
    for (const row of database
      .prepare('SELECT artifact_said, encoded_artifact FROM evidence_artifacts')
      .all()) {
      if (typeof row.artifact_said !== 'string' || typeof row.encoded_artifact !== 'string') {
        throw new Error('artifact encoding unavailable');
      }
      const bytes = await readFile(join(directory, 'artifacts', row.artifact_said));
      expect(decodeEvidenceArtifact(JSON.parse(row.encoded_artifact) as unknown, bytes).kind).toBe(
        'Accepted',
      );
    }
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM evidence_seal_acknowledgement').get(),
    ).toEqual({ count: 0 });
    return { eventSaids: events.map(({ d }) => d), delivered: stream.next_delivery_sequence };
  } finally {
    database.close();
  }
}

describeLiveSeal('native signed evidence seal', () => {
  it.skipIf(process.env.DEVRANDOM_NATIVE_PROCESS_LOSS_INTEGRATION === '1')(
    'binds the accepted CLI/server cursor to the exact KERIA exchange and local acknowledgement',
    async () => {
      const userState = requiredEnvironment('DEVRANDOM_USER_STATE_DIR');
      const materialized = await materializeCesrReceiptFixture({
        templateRoot: join(process.cwd(), 'fixtures', 'cesr-receipt-service'),
        taskTemplate: join(process.cwd(), 'fixtures', 'cesr-compat.task.json'),
        destination: join(userState, 'native-seal-repository'),
      });
      const taskSource: unknown = JSON.parse(await readFile(materialized.taskFile, 'utf8'));
      if (!Value.Check(taskSourceCommandSchema, taskSource)) {
        throw new Error('materialized Task contract is invalid');
      }
      await writeFile(
        materialized.taskFile,
        `${JSON.stringify(
          {
            ...taskSource,
            expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString(),
          },
          null,
          2,
        )}\n`,
      );

      const created = await executeCli(
        ['task', 'create', materialized.taskFile],
        materialized.worktree,
      );
      expect(created, created.stderr).toMatchObject({ exitCode: 0, stderr: '' });
      const lostReply = await runWithLostHostedSealReply(materialized.worktree);
      const run = lostReply.run;
      const runDisposition = `${run.stdout}\n${run.stderr}`
        .split('\n')
        .filter((line) =>
          /^(Calibration Run |Completed calibration attempt:|Run supervision:|Run stop cause:|Run state:|Checkpoint SAID:)/u.test(
            line,
          ),
        );
      expect([0, 6], run.stderr).toContain(run.exitCode);
      expect(run.stdout + run.stderr).toContain('Run ID: ');
      const runId = (run.stdout + run.stderr).match(/Run ID: ([0-9a-f-]{36})/u)?.[1];
      if (runId === undefined) throw new Error('CLI Run ID is absent');
      const status = await executeCli(['task', 'status', 'cesr-compat'], materialized.worktree);
      expect(status, status.stderr).toMatchObject({ exitCode: 0, stderr: '' });
      expect(status.stdout).toContain(`Run ID: ${runId}`);
      const watch = await executeCli(['task', 'watch', 'cesr-compat'], materialized.worktree);
      expect(watch, watch.stderr).toMatchObject({ exitCode: 0, stderr: '' });
      expect(
        lostReply.lostCommittedReply,
        `CLI exit ${String(run.exitCode)} before hosted seal reply: ${runDisposition.join('; ')}`,
      ).toBe(true);
      expect(lostReply.exactRetry).toBe(true);
      const local = localSeal(userState, runId);
      expect(
        local.events.some(
          ({ event }) =>
            event.kind === 'ModelMessageCompleted' &&
            event.disposition === 'Completed' &&
            event.usage.inputTokens + event.usage.cacheReadTokens + event.usage.cacheWriteTokens >
              0 &&
            event.usage.outputTokens > 0,
        ),
      ).toBe(true);
      const completedEffect = local.events.find(({ event }) => event.kind === 'EffectCompleted');
      if (completedEffect?.event.kind !== 'EffectCompleted')
        throw new Error('no real effect recorded');
      const effect = completedEffect.event;
      expect(
        local.events.some(
          ({ event, sequence }) =>
            event.kind === 'ToolAuthorized' &&
            event.toolCallId === effect.toolCallId &&
            event.modelTurnId === effect.modelTurnId &&
            sequence < completedEffect.sequence,
        ),
      ).toBe(true);
      expect(local.firstEvent.runId).toBe(runId);
      expect(local.firstEvent.sequence).toBe(0);
      expect(local.projection.runId).toBe(runId);
      expect(local.projection.cursor.kind).toBe('Accepted');
      expect(local.projection.seal.kind).toBe('Sealed');
      if (local.projection.cursor.kind !== 'Accepted' || local.projection.seal.kind !== 'Sealed') {
        throw new Error('CLI Run lacks an acknowledged accepted evidence seal');
      }
      const exchangeSaid = local.projection.seal.sealExchangeSaid;
      const eventCount = local.projection.cursor.eventCount;
      const finalSequence = local.projection.cursor.acceptedThroughSequence;
      expect(eventCount).toBe(finalSequence + 1);
      expect(eventCount).toBe(local.eventCount);
      expect([...watch.stdout.matchAll(/^(\d+)\t/gmu)].map((match) => Number(match[1]))).toEqual(
        Array.from({ length: eventCount }, (_, sequence) => sequence),
      );
      expect(local.lastEvent.sequence).toBe(finalSequence);
      expect(local.lastEvent.d).toBe(local.projection.cursor.chainHeadSaid);
      const payload: EvidenceSealPayload = {
        version: 1,
        kind: 'EvidenceStreamSeal',
        runId,
        evidenceStreamId: local.projection.evidenceStreamId,
        eventCount,
        finalSequence,
        chainHeadSaid: local.projection.cursor.chainHeadSaid,
        harnessRevisionSaid: local.firstEvent.harnessRevisionSaid,
        taskMandateSaid: local.firstEvent.taskMandateSaid,
      };
      const sourceAid = personalAgentAid(local.firstEvent.personalAgentAid);
      const recipientAid = issuerAid(requiredEnvironment('DEVRANDOM_ISSUER_AID'));
      const connected = await connectSignifyController({
        adminUrl: requiredEnvironment('DEVRANDOM_KERIA_ADMIN_URL'),
        bootUrl: requiredEnvironment('DEVRANDOM_KERIA_BOOT_URL'),
        bran: requiredEnvironment('DEVRANDOM_ISSUER_BRAN'),
        securityTier: 'low',
      });
      const seals = signifyIssuerEvidenceSealExchange(connected.client);
      const expected = { exchangeSaid, sourceAid, recipientAid, payload };
      const materializedExchange = await connected.client.exchanges().get(exchangeSaid);
      const evidence = decodeEvidenceSealExchangeEvidence(materializedExchange.exn);
      expect(evidence).toMatchObject({
        d: exchangeSaid,
        i: sourceAid,
        rp: recipientAid,
        r: evidenceSealExchangeRoute,
        a: { i: recipientAid, ...payload },
      });
      await expect(seals.inspect(expected)).resolves.toEqual({
        kind: 'Verified',
        exchangeSaid,
        sourceAid,
        payload,
      });
      expect(sourceAid).not.toBe(recipientAid);
      expect(local.firstEvent.d).not.toBe(payload.chainHeadSaid);
      expect(payload.harnessRevisionSaid).not.toBe(payload.taskMandateSaid);
      await expect(
        seals.inspect({ ...expected, sourceAid: personalAgentAid(recipientAid) }),
      ).resolves.toEqual({ kind: 'Rejected', reason: 'SealExchangeSourceMismatch' });
      await expect(
        seals.inspect({ ...expected, recipientAid: issuerAid(sourceAid) }),
      ).resolves.toEqual({ kind: 'Rejected', reason: 'SealExchangeRecipientMismatch' });
      for (const changed of [
        { ...payload, eventCount: eventCount + 1, finalSequence: finalSequence + 1 },
        { ...payload, chainHeadSaid: local.firstEvent.d },
        { ...payload, harnessRevisionSaid: payload.taskMandateSaid },
        { ...payload, taskMandateSaid: payload.harnessRevisionSaid },
      ]) {
        await expect(seals.inspect({ ...expected, payload: changed })).resolves.toEqual({
          kind: 'Rejected',
          reason: 'SealExchangePayloadMismatch',
        });
      }

      expect(local.projection).toMatchObject({
        runId,
        evidenceStreamId: payload.evidenceStreamId,
        cursor: {
          kind: 'Accepted',
          eventCount,
          acceptedThroughSequence: finalSequence,
          chainHeadSaid: payload.chainHeadSaid,
        },
        seal: {
          kind: 'Sealed',
          sealExchangeSaid: exchangeSaid,
          eventCount,
          finalSequence,
          chainHeadSaid: payload.chainHeadSaid,
        },
      });

      if (local.projection.checkpoint.kind !== 'Accepted') {
        throw new Error('CLI Run lacks an accepted checkpoint');
      }
      for (const line of [
        `Evidence event count: ${String(eventCount)}`,
        `Evidence accepted through sequence: ${String(finalSequence)}`,
        `Evidence chain head SAID: ${payload.chainHeadSaid}`,
        `Checkpoint SAID: ${local.projection.checkpoint.checkpointSaid}`,
        `Evidence seal exchange SAID: ${exchangeSaid}`,
        'Evidence seal: Sealed',
      ]) {
        expect(status.stdout).toContain(line);
        expect(watch.stdout).toContain(line);
      }
    },
    nativeSealJourneyTimeoutMilliseconds,
  );

  it.runIf(process.env.DEVRANDOM_NATIVE_PROCESS_LOSS_INTEGRATION === '1')(
    'preserves acknowledged and pending evidence after SIGKILL and refuses execution recovery',
    async () => {
      const state = requiredEnvironment('DEVRANDOM_USER_STATE_DIR');
      const label = 'runtime-interruption';
      const materialized = await materializeCesrReceiptFixture({
        templateRoot: join(process.cwd(), 'fixtures/cesr-receipt-service'),
        taskTemplate: join(process.cwd(), 'fixtures/cesr-compat.task.json'),
        destination: join(state, 'process-loss-repository'),
      });
      const source: unknown = JSON.parse(await readFile(materialized.taskFile, 'utf8'));
      if (!Value.Check(taskSourceCommandSchema, source)) throw new Error('invalid Task fixture');
      await writeFile(
        materialized.taskFile,
        JSON.stringify({
          ...source,
          label,
          expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString(),
        }),
      );
      const created = await executeCli(
        ['task', 'create', materialized.taskFile],
        materialized.worktree,
      );
      expect(created, created.stderr).toMatchObject({ exitCode: 0, stderr: '' });
      const runId = await killDuringEvidenceDelivery(materialized.worktree, label);
      const before = await inspectInterruptedEvidence(state, runId);
      const status = await executeCli(['task', 'status', label], materialized.worktree);
      expect(status, status.stderr).toMatchObject({ exitCode: 0, stderr: '' });
      expect(status.stdout).toContain(`Run ID: ${runId}`);
      expect(status.stdout).toContain(`Evidence event count: ${String(before.delivered)}`);
      expect(status.stdout).toContain('Evidence seal: Unsealed');
      const watch = await executeCli(
        ['task', 'watch', label],
        materialized.worktree,
        undefined,
        'Timeline events:',
      );
      expect(watch, watch.stderr).toMatchObject({ exitCode: 130 });
      expect(watch.stdout).toContain(`Run ID: ${runId}`);
      expect(watch.stderr).toContain('Task Run watch stopped on user interruption.');
      const refused = await executeCli(['task', 'run', label], materialized.worktree);
      expect(refused, refused.stderr).toMatchObject({ exitCode: 6 });
      expect(refused.stderr).toContain('PRD 02 cannot restore an earlier execution process.');
      expect(await inspectInterruptedEvidence(state, runId)).toEqual(before);
    },
    nativeSealJourneyTimeoutMilliseconds,
  );
});
