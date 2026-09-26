/** Native driver smoke with synthetic provider/hosted authority fixtures.
 * It deliberately stops at ciphertext acknowledgement; this is not Q or an 18-rollout acceptance. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Value from 'typebox/value';
import { ProtectedCredentials, evaluationConsumables } from '@devrandom/domain';
import {
  evaluationEvidenceUploadSchema,
  prepareEvidenceArtifact,
  prepareEvaluationEvidenceEvent,
  type EvaluationEvidenceEvent,
  type EvidenceArtifact,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';
import { digestEvaluationRuntimeMounts } from '../../../../../packages/runtime/src/evaluation/infrastructure/runtime-mount-digest.js';
import {
  nativeComparisonFixture,
  nativeSaid,
} from '../../../test/locked-comparison-native-fixture.js';
import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { ServerEvaluationHttp } from '../infrastructure/server-evaluation-http.js';
import { SqliteEvaluationEvidenceOutbox } from '../infrastructure/sqlite-evaluation-evidence-outbox.js';
import { SqliteHostedEvaluationEvidence } from '../infrastructure/sqlite-hosted-evaluation-evidence.js';
import {
  executeLockedComparison,
  type LockedComparisonInput,
} from './locked-comparison-execution.js';

describe.skipIf(process.env.DEVRANDOM_EVAL_IMAGE === undefined)(
  'concrete locked comparison native smoke (fixtures)',
  () => {
    it('retains a real H1 edit, denied protected read and native observations, then blocks on missing ciphertext acknowledgement without rerunning', async () => {
      const root = await mkdtemp(join(await realpath(tmpdir()), 'independent-locked-comparison-'));
      const server = createServer();
      let outbox: SqliteEvaluationEvidenceOutbox | undefined;
      try {
        const workerMounts = [
          {
            hostPath: resolve('packages/runtime/dist'),
            containerPath: '/app/packages/runtime/dist',
            writable: false,
          },
          {
            hostPath: resolve('packages/runtime/package.json'),
            containerPath: '/app/packages/runtime/package.json',
            writable: false,
          },
          {
            hostPath: resolve('packages/runtime/node_modules'),
            containerPath: '/app/packages/runtime/node_modules',
            writable: false,
          },
          {
            hostPath: process.env.DEVRANDOM_EVAL_PNPM_DIRECTORY ?? resolve('node_modules/.pnpm'),
            containerPath: '/app/node_modules/.pnpm',
            writable: false,
          },
        ];
        const fixture = await nativeComparisonFixture(
          root,
          process.env.DEVRANDOM_EVAL_IMAGE ?? '',
          await digestEvaluationRuntimeMounts(workerMounts),
        );
        const { manifest } = fixture;
        const binding: LockedComparisonInput['binding'] = {
          kind: 'Evaluation',
          evaluationId: manifest.evaluationId,
          evidenceStreamId: randomUUID(),
          originRunId: manifest.originRunId,
          taskId: manifest.taskId,
          taskRevisionSaid: manifest.taskRevisionSaid,
          personalAgentAid: manifest.personalAgentAid,
          taskMandateSaid: manifest.taskMandateSaid,
          harnessRevisionSaid: manifest.revisions.H1,
          evaluationLeaseId: randomUUID(),
          phase: { kind: 'Research', policySaid: manifest.policySaid, role: 'DiagnosticRefiner' },
        };
        const commandId = randomUUID();
        const reservation = prepareEvidenceArtifact(
          Buffer.from(
            JSON.stringify({
              evaluationId: manifest.evaluationId,
              ownerAid: manifest.ownerAid,
              commandId,
              originRunId: manifest.originRunId,
              reserved: Object.fromEntries(
                evaluationConsumables.map((name) => [
                  name,
                  manifest.allocation.diagnosis[name] +
                    15 * manifest.allocation.perEntry[name] +
                    manifest.allocation.finalization[name],
                ]),
              ),
            }),
          ),
          'application/json',
        );
        if (reservation.kind !== 'Prepared') throw new Error('fixture reservation');
        const leaseStarted = Date.now() - 30000;
        let renewals = 0;
        let aggregateVersion = 2;
        let raced = false;
        let lease = {
          evaluationId: manifest.evaluationId,
          leaseId: binding.evaluationLeaseId,
          version: 1,
          serverTime: new Date(leaseStarted).toISOString(),
          expiresAt: new Date(leaseStarted + 45000).toISOString(),
        };
        const events: EvaluationEvidenceEvent[] = [];
        const artifacts = new Map<string, { artifact: EvidenceArtifact; bytesBase64Url: string }>();
        let rejectCiphertext = true;
        let ciphertextAttempts = 0;
        // Fixture HTTP receiver acknowledges exact batches and serves their immutable bytes.
        // No MongoDB, Work Access, native signatures or real authority are claimed here.
        server.on('request', (request, response) => {
          void (async () => {
            response.setHeader('cache-control', 'no-store');
            response.setHeader('content-type', 'application/json');
            const reply = (body: unknown, status = 200) => {
              response.statusCode = status;
              response.end(JSON.stringify(body));
            };
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            if (url.pathname.endsWith('/batches')) {
              const chunks: Buffer[] = [];
              for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
              const upload: unknown = JSON.parse(Buffer.concat(chunks).toString());
              if (!Value.Check(evaluationEvidenceUploadSchema, upload))
                throw new Error('fixture upload schema');
              if (upload.protectedArtifacts.length > 0) {
                ciphertextAttempts++;
                if (rejectCiphertext) {
                  reply(
                    {
                      code: 'FixtureUnavailable',
                      correlationId: randomUUID(),
                      status: 503,
                      title: 'Synthetic custody outage',
                      type: 'about:blank',
                    },
                    503,
                  );
                  return;
                }
              }
              const previous = events.at(-1);
              if (
                upload.batch.startingSequence !== events.length ||
                (previous === undefined
                  ? upload.events[0]?.previous.kind !== 'Genesis'
                  : upload.events[0]?.previous.kind !== 'Previous' ||
                    upload.events[0].previous.eventSaid !== previous.d)
              )
                throw new Error('fixture evidence gap');
              events.push(...upload.events);
              aggregateVersion++;
              for (const artifact of upload.publicArtifacts)
                artifacts.set(artifact.artifact.d, artifact);
              reply(
                {
                  version: 1,
                  disposition: 'Accepted',
                  evaluationId: manifest.evaluationId,
                  streamId: binding.evidenceStreamId,
                  batchSaid: upload.batch.d,
                  acceptedThroughSequence: upload.batch.endingSequence,
                  chainHeadSaid: events.at(-1)?.d,
                },
                201,
              );
            } else if (url.pathname.endsWith('/position')) {
              reply({
                version: 1,
                currentEvaluationVersion: aggregateVersion,
                evaluationId: manifest.evaluationId,
                ownerAid: manifest.ownerAid,
                commandId,
                originRunId: manifest.originRunId,
                streamId: binding.evidenceStreamId,
                reservationSaid: reservation.artifact.d,
                lease,
                acceptedThroughSequence: events.length - 1,
                chainHeadSaid: events.at(-1)?.d ?? null,
              });
            } else if (url.pathname.includes('/manifest/')) {
              reply({
                kind: 'Locked',
                evaluationId: manifest.evaluationId,
                manifestSaid: manifest.d,
                ownerAid: manifest.ownerAid,
                policySaid: manifest.policySaid,
                leaseId: binding.evaluationLeaseId,
                lockedAtLeaseVersion: 1,
                lockedAtEvaluationVersion: 2,
                currentLeaseVersion: lease.version,
                currentEvaluationVersion: aggregateVersion,
              });
            } else if (url.pathname.endsWith('/evidence')) {
              const after = Number(url.searchParams.get('after'));
              const through = Number(url.searchParams.get('through'));
              reply({
                version: 1,
                evaluationId: manifest.evaluationId,
                streamId: binding.evidenceStreamId,
                afterSequence: after,
                throughSequence: through,
                throughHeadSaid: url.searchParams.get('head'),
                events: events.slice(after + 1, Math.min(through + 1, after + 33)),
              });
            } else if (url.pathname.includes('/artifacts/')) {
              const artifact = artifacts.get(url.pathname.split('/').at(-1) ?? '');
              if (artifact === undefined) throw new Error('fixture missing artifact');
              reply({ version: 1, evaluationId: manifest.evaluationId, ...artifact });
            } else if (url.pathname.endsWith('/lease')) {
              const chunks: Buffer[] = [];
              for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
              const renewal = JSON.parse(Buffer.concat(chunks).toString()) as {
                expectedEvaluationVersion: number;
              };
              expect(renewal.expectedEvaluationVersion).toBe(aggregateVersion);
              if (!raced) {
                raced = true;
                aggregateVersion++;
                reply(
                  {
                    code: 'EvaluationVersionConflict',
                    title: 'EvaluationVersionConflict',
                    type: 'https://devrandom.example/problems/evaluationversionconflict',
                    status: 409,
                    correlationId: randomUUID(),
                  },
                  409,
                );
                return;
              }
              aggregateVersion++;
              renewals++;
              const renewedAt = Date.now();
              lease = {
                ...lease,
                version: lease.version + 1,
                serverTime: new Date(renewedAt).toISOString(),
                expiresAt: new Date(renewedAt + 20000).toISOString(),
              };
              reply({
                kind: 'Renewed',
                evaluationId: manifest.evaluationId,
                version: aggregateVersion,
                lease,
              });
            } else throw new Error('unexpected fixture HTTP route');
          })().catch(() => {
            response.statusCode = 500;
            response.end('{}');
          });
        });
        await new Promise<void>((resolveListening) =>
          server.listen(0, '127.0.0.1', resolveListening),
        );
        const address = server.address();
        if (address === null || typeof address === 'string') throw new Error('fixture HTTP listen');
        const origin = decodeDevrandomServerOrigin(`http://127.0.0.1:${String(address.port)}`);
        if (origin.kind !== 'Accepted') throw new Error('fixture origin');
        const hosted = new ServerEvaluationHttp(origin.origin, 'f'.repeat(43), fetch);
        const opened = SqliteEvaluationEvidenceOutbox.open(root, {
          ...binding,
          ownerAid: manifest.ownerAid,
          streamId: binding.evidenceStreamId,
        });
        if (opened.kind !== 'Opened') throw new Error('fixture outbox');
        outbox = opened.outbox;
        const evidence = new SqliteHostedEvaluationEvidence(outbox, hosted);
        const initial = await evidence.rawArtifacts.record({
          bytes: Buffer.from('Synthetic native driver fixture; not qualified live evidence.'),
          mediaType: 'text/plain; charset=utf-8',
        });
        if (initial.kind !== 'Stored') throw new Error('fixture genesis artifact');
        const genesis = prepareEvaluationEvidenceEvent({
          evaluationId: binding.evaluationId,
          originRunId: binding.originRunId,
          taskId: binding.taskId,
          taskRevisionSaid: binding.taskRevisionSaid,
          personalAgentAid: binding.personalAgentAid,
          taskMandateSaid: binding.taskMandateSaid,
          harnessRevisionSaid: binding.harnessRevisionSaid,
          phase: binding.phase,
          streamId: binding.evidenceStreamId,
          sequence: 0,
          previous: { kind: 'Genesis' },
          occurredAt: new Date().toISOString(),
          detail: { kind: 'ArtifactCaptured', artifactSaid: initial.artifact.d, custody: 'Public' },
        });
        if (genesis.kind !== 'Prepared') throw new Error('fixture genesis');
        expect(await evidence.record(genesis.event)).toMatchObject({ kind: 'Recorded' });
        const original = await readFile(join(fixture.sourceDirectory, 'src/lib.rs'), 'utf8');
        const model: LockedComparisonInput['openedModel']['model'] = {
          id: fixture.profile.modelId,
          name: 'Synthetic fixture, no paid provider',
          provider: 'concentrate',
          api: 'openai-responses',
          baseUrl: 'http://127.0.0.1/fixture-never-fetched',
          reasoning: true,
          input: ['text'],
          cost: { input: 0.08, output: 0.18, cacheRead: 0.02, cacheWrite: 0 },
          contextWindow: 131072,
          maxTokens: 512,
        };
        const fixturePatch = original
          .replace(
            'let payload = if let Some(payload) = body.strip_prefix("-_AAACAA") {',
            'let legacy = body.starts_with("-_AAABAA");\n        let payload = if let Some(payload) = body.strip_prefix("-_AAABAA").or_else(|| body.strip_prefix("-_AAACAA")) {',
          )
          .replace(
            'version: ReceiptVersion::Current,',
            'version: if legacy { ReceiptVersion::Legacy } else { ReceiptVersion::Current },',
          );
        const calls = [
          { name: 'read_file', arguments: { path: 'src/private/canary.txt' } },
          {
            name: 'write_file',
            arguments: {
              path: 'src/lib.rs',
              content: `${fixturePatch}\n// Synthetic native comparison fixture edit.\n`,
            },
          },
          { name: 'run_tests', arguments: { commandId: 'fixture-native-test' } },
          { name: 'submit_result', arguments: { artifactSaids: [] } },
        ];
        const contexts: string[] = [];
        let ordinal = 0;
        const completeSimple = vi.fn((_model, context) => {
          contexts.push(JSON.stringify(context));
          const index = ordinal++;
          const call = calls[index];
          return Promise.resolve({
            role: 'assistant' as const,
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            responseId: `fixture-response-${String(index)}`,
            content:
              call === undefined
                ? [{ type: 'text' as const, text: 'Synthetic fixture stopped.' }]
                : [{ type: 'toolCall' as const, id: `fixture-call-${String(index)}`, ...call }],
            stopReason: call === undefined ? ('stop' as const) : ('toolUse' as const),
            usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 },
          });
        });
        const signing = vi.fn(() => {
          throw new Error('incomplete native smoke must never sign');
        });
        const input: LockedComparisonInput = {
          ...fixture,
          stateRoot: root,
          binding,
          admittedCommandId: commandId,
          protectedPaths: ['src/private'],
          readOnlyPaths: ['tests', 'Cargo.toml', 'Cargo.lock'],
          hosted,
          appendEvidence: (upload, signal, sequence) =>
            sequence(() => hosted.appendEvidence(upload, signal)),
          outbox,
          workerMounts,
          workerProgram: '/app/packages/runtime/dist/pi/evaluation/contained-pi-worker.js',
          systemPrompt: 'Synthetic test fixture. Use only mediated tools.',
          prompt: 'Perform the fixture calls then stop.',
          // Only the parent provider response is synthetic. The contained worker uses the real Pi SDK.
          openedModel: {
            kind: 'Opened',
            model,
            runtime: {
              completeSimple,
            } as unknown as LockedComparisonInput['openedModel']['runtime'],
            consumeUsage: () => ({ kind: 'Unavailable' }),
            consumeProviderReport: (message) => ({
              kind: 'Verified',
              spendMicroUsd: 7,
              providerReportBytes: Buffer.from(
                JSON.stringify({
                  type: 'response.completed',
                  response: {
                    id: message.responseId,
                    cost: { total: 0.000007 },
                    usage: {
                      input_tokens: 100,
                      output_tokens: 10,
                      total_tokens: 110,
                      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                    },
                  },
                }),
              ),
            }),
          },
          mandate: {
            inspect: () =>
              Promise.resolve({
                kind: 'Current',
                mandateSaid: manifest.taskMandateSaid,
                allowedCapabilities: [
                  'ReadRepository',
                  'EditRepository',
                  'RunTests',
                  'SubmitResult',
                ],
              }),
          },
          credentials: new ProtectedCredentials(),
          // Fail at the first H1 protected acknowledgement; candidate and signing construction is forbidden.
          candidates: {
            get C1(): never {
              throw new Error('unexpected candidate');
            },
            get C2(): never {
              throw new Error('unexpected candidate');
            },
            get C3(): never {
              throw new Error('unexpected candidate');
            },
          },
          signing: {
            exchange: { prepare: signing, deliver: signing },
            senderAlias: 'fixture-only',
            sourceAid: manifest.personalAgentAid as LockedComparisonInput['signing']['sourceAid'],
            recipientAid: nativeSaid('O') as LockedComparisonInput['signing']['recipientAid'],
          },
          signal: new AbortController().signal,
        };
        expect(await hosted.readPosition(manifest.evaluationId)).toMatchObject({ kind: 'Read' });
        expect(await executeLockedComparison(input)).toEqual({
          kind: 'Incomplete',
          frontier: 'ProtectedGrading:ProtectedCustody',
        });
        expect(completeSimple).toHaveBeenCalledTimes(4);
        expect(ciphertextAttempts).toBe(1);
        expect(signing).not.toHaveBeenCalled();
        expect(contexts.join('\n')).not.toContain('fixture-private-canary');
        expect(contexts.join('\n')).not.toContain(nativeSaid('q'));
        expect(events).toContainEqual(
          expect.objectContaining({
            detail: expect.objectContaining({
              kind: 'ToolAuthorization',
              disposition: 'Denied',
            }) as unknown,
          }),
        );
        expect(events).toContainEqual(
          expect.objectContaining({ detail: { kind: 'TrialStopped', reason: 'Completed' } }),
        );
        const raw = [...artifacts.values()].map((item) =>
          Buffer.from(item.bytesBase64Url, 'base64url').toString(),
        );
        expect(raw.join('\n')).toContain('Synthetic native comparison fixture edit.');
        expect(raw.join('\n')).toContain('native fixture command');
        expect(raw.join('\n')).toContain('Original public cases passed.');
        expect(await readFile(join(fixture.sourceDirectory, 'src/lib.rs'), 'utf8')).toBe(original);
        expect(outbox.pending()).toMatchObject({
          kind: 'Pending',
          upload: {
            protectedArtifacts: [expect.objectContaining({ purpose: 'OracleObservation' })],
          },
        });
        const pendingRaw = outbox.unstagedPublicArtifacts();
        expect(pendingRaw.kind).toBe('Found');
        if (pendingRaw.kind !== 'Found') throw new Error('pending accounting raw missing');
        expect(
          pendingRaw.artifacts.some((item) => {
            const text = Buffer.from(item.bytes).toString('utf8');
            return (
              text.includes('"kind":"EvaluationFinalizationNativeElapsed"') &&
              text.includes('"operation":"ProtectedObservation"')
            );
          }),
        ).toBe(true);
        expect(raw.some((text) => text.includes('"operation":"ProtectedObservation"'))).toBe(false);
        const stopped = events.findLastIndex((event) => event.detail.kind === 'TrialStopped');
        expect(stopped).toBeGreaterThan(0);
        // Native F receipts are retained while the stopped prefix stays immutable:
        // no build/public/protected grading debit precedes the exact ciphertext ACK.
        expect(
          events
            .slice(stopped + 1)
            .every(
              (event) =>
                event.detail.kind === 'ArtifactCaptured' && event.detail.custody === 'Public',
            ),
        ).toBe(true);
        expect(renewals).toBeGreaterThanOrEqual(2);
        rejectCiphertext = false;
        expect(await executeLockedComparison(input)).toEqual({
          kind: 'RecoveryRequired',
          evaluationId: manifest.evaluationId,
        });
        expect(completeSimple).toHaveBeenCalledTimes(4);
        expect(signing).not.toHaveBeenCalled();
        expect(outbox.pending()).toEqual({ kind: 'Empty' });
      } finally {
        outbox?.close();
        await new Promise<void>((resolveClosed) =>
          server.close(() => {
            resolveClosed();
          }),
        );
        await rm(root, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
