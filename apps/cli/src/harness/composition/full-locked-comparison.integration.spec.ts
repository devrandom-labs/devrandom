import { isDeepStrictEqual } from 'node:util';
import { decodeParentAuditOperation } from '../../promotion/application/parent-audit-operation.js';
import { writeComparisonSimulationReport } from '../../../test/write-comparison-simulation-report.js';
/** Full comparison caller proof with explicitly synthetic provider and authority.
 * Real contained execution/grading; this never establishes live campaign qualification. */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Value from 'typebox/value';
import { digestRunRuntimePrompt } from '@devrandom/runtime';
import {
  nativeCandidateRepository,
  nativeComparisonCandidates,
} from '../../../test/locked-comparison-candidates-fixture.js';
import { ProtectedCredentials, evaluationConsumables } from '@devrandom/domain';
import {
  decodeComparisonMeasurementEvidence,
  decodeTrialObservationEvidence,
  taskEvaluationBudgetCeilings,
  evaluationEvidenceUploadSchema,
  evaluationClosureCommandSchema,
  evaluationLeaseRenewalCommandSchema,
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
  'full locked comparison native proof (fixtures)',
  () => {
    it('accounts for eighteen real contained rollouts and fifteen measurements before closure', async () => {
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
        const repository = await nativeCandidateRepository(root);
        const fixture = await nativeComparisonFixture(
          root,
          process.env.DEVRANDOM_EVAL_IMAGE ?? '',
          await digestEvaluationRuntimeMounts(workerMounts),
          {
            ...repository,
            taskBudgets: taskEvaluationBudgetCeilings,
            runtimePromptDigest: digestRunRuntimePrompt(
              'Synthetic test fixture. Use only mediated tools.',
              'Perform the fixture calls then stop.',
            ),
          },
        );
        const { manifest, candidates } = await nativeComparisonCandidates(fixture, repository);
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
        for (const name of evaluationConsumables)
          expect(
            manifest.allocation.diagnosis[name] +
              15 * manifest.allocation.perEntry[name] +
              manifest.allocation.finalization[name],
          ).toBeLessThanOrEqual(taskEvaluationBudgetCeilings[name]);
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
        const leaseStarted = Date.now();
        let lease = {
          evaluationId: manifest.evaluationId,
          leaseId: binding.evaluationLeaseId,
          version: 1,
          serverTime: new Date(leaseStarted).toISOString(),
          expiresAt: new Date(leaseStarted + 45000).toISOString(),
        };
        let aggregateVersion = 2;
        const events: EvaluationEvidenceEvent[] = [];
        const artifacts = new Map<string, { artifact: EvidenceArtifact; bytesBase64Url: string }>();
        let ciphertextAttempts = 0;
        let requestCount = 0;
        const httpOutcomes: Record<string, number> = {};
        const renewals: {
          expectedVersion: number;
          currentVersion: number;
          accepted: boolean;
          leaseRemainingMilliseconds: number;
        }[] = [];
        const slotStarts = new Map<string, { requests: number; started: number }>();
        const slotExecutions: {
          slot: EvaluationEvidenceEvent['phase'];
          httpRequests: number;
          wallMilliseconds: number;
        }[] = [];
        // Fixture HTTP receiver acknowledges exact batches and serves their immutable bytes.
        // No MongoDB, Work Access, native signatures or real authority are claimed here.
        server.on('request', (request, response) => {
          requestCount++;
          void (async () => {
            response.setHeader('cache-control', 'no-store');
            response.setHeader('content-type', 'application/json');
            const reply = (body: unknown, status = 200) => {
              httpOutcomes[String(status)] = (httpOutcomes[String(status)] ?? 0) + 1;
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
              for (const event of upload.events) {
                if (event.phase.kind !== 'Trial') continue;
                const key = JSON.stringify(event.phase);
                if (!slotStarts.has(key))
                  slotStarts.set(key, { requests: requestCount, started: performance.now() });
                const start = slotStarts.get(key);
                if (event.detail.kind === 'TrialStopped' && start !== undefined)
                  slotExecutions.push({
                    slot: event.phase,
                    httpRequests: requestCount - start.requests + 1,
                    wallMilliseconds: performance.now() - start.started,
                  });
              }
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
            } else if (url.pathname.endsWith('/closure')) {
              const chunks: Buffer[] = [];
              for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
              const command: unknown = JSON.parse(Buffer.concat(chunks).toString());
              if (!Value.Check(evaluationClosureCommandSchema, command))
                throw new Error('fixture closure schema');
              expect(command.expectedEvaluationVersion).toBe(aggregateVersion);
              reply({ kind: 'Closed', closureSaid: command.closure.d }, 201);
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
              const renewal: unknown = JSON.parse(Buffer.concat(chunks).toString());
              if (!Value.Check(evaluationLeaseRenewalCommandSchema, renewal))
                throw new Error('fixture lease command');
              renewals.push({
                expectedVersion: renewal.expectedEvaluationVersion,
                currentVersion: aggregateVersion,
                accepted: renewal.expectedEvaluationVersion === aggregateVersion,
                leaseRemainingMilliseconds: Date.parse(lease.expiresAt) - Date.now(),
              });
              if (renewal.expectedEvaluationVersion !== aggregateVersion) {
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
              const renewedAt = Date.now();
              lease = {
                ...lease,
                version: lease.version + 1,
                serverTime: new Date(renewedAt).toISOString(),
                expiresAt: new Date(renewedAt + 45000).toISOString(),
              };
              reply({
                kind: 'Renewed',
                evaluationId: manifest.evaluationId,
                version: aggregateVersion,
                lease,
              });
            } else throw new Error('unexpected fixture HTTP route');
          })().catch(() => {
            httpOutcomes['500'] = (httpOutcomes['500'] ?? 0) + 1;
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
          const call = calls[index % calls.length];
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
        const signing: LockedComparisonInput['signing']['exchange'] = {
          prepare: (input) => {
            const raw = prepareEvidenceArtifact(
              Buffer.from(
                JSON.stringify({ fixture: 'SyntheticClosureAuthority', payload: input.payload }),
              ),
              'application/json',
            );
            if (raw.kind !== 'Prepared') throw new Error('fixture closure seal');
            return Promise.resolve({ exchangeSaid: raw.artifact.d });
          },
          deliver: (input) => Promise.resolve({ exchangeSaid: input.exchangeSaid }),
        };
        const input: LockedComparisonInput = {
          ...fixture,
          stateRoot: root,
          manifest,
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
          candidates,
          signing: {
            exchange: signing,
            senderAlias: 'fixture-only',
            sourceAid: manifest.personalAgentAid as LockedComparisonInput['signing']['sourceAid'],
            recipientAid: nativeSaid('O') as LockedComparisonInput['signing']['recipientAid'],
          },
          signal: new AbortController().signal,
        };
        expect(await hosted.readPosition(manifest.evaluationId)).toMatchObject({ kind: 'Read' });
        const executionStarted = performance.now();
        const outcome = await executeLockedComparison(input);
        console.info(
          JSON.stringify({
            fixture: 'FullLockedComparison',
            requestCount,
            httpOutcomes,
            renewalCount: renewals.length,
            renewalConflicts: renewals.filter((renewal) => !renewal.accepted).length,
            rolloutCount: slotExecutions.length,
            executionMilliseconds: performance.now() - executionStarted,
            outcome,
          }),
        );
        if (process.env.DEVRANDOM_DEMO_REPORT_DIRECTORY !== undefined)
          await writeComparisonSimulationReport({
            directory: process.env.DEVRANDOM_DEMO_REPORT_DIRECTORY,
            manifest,
            outcome,
            events,
            artifacts,
            httpRequests: requestCount,
            httpOutcomes,
            renewals,
            slotExecutions,
            executionMilliseconds: performance.now() - executionStarted,
          });
        // Both public task-search attempts run before grading: each later ACK must
        // release only its own build/public/protected native accounting.
        const measuredCleanups = new Map<string, string>();
        for (const raw of artifacts.values()) {
          if (raw.artifact.mediaType !== 'application/json') continue;
          const bytes = Buffer.from(raw.bytesBase64Url, 'base64url');
          const value: unknown = JSON.parse(bytes.toString('utf8'));
          if (
            typeof value === 'object' &&
            value !== null &&
            'kind' in value &&
            value.kind === 'EvaluationFinalizationNativeElapsed' &&
            'cleanupReceiptSaid' in value &&
            typeof value.cleanupReceiptSaid === 'string'
          )
            measuredCleanups.set(raw.artifact.d, value.cleanupReceiptSaid);
        }
        for (const raw of artifacts.values()) {
          const operation = decodeParentAuditOperation(
            raw.artifact,
            Buffer.from(raw.bytesBase64Url, 'base64url'),
          );
          if (
            operation.kind !== 'Accepted' ||
            operation.receipt.operation.kind !== 'ProtectedGrading'
          )
            continue;
          const grade = operation.receipt.operation;
          const phase = { kind: 'Trial', manifestSaid: manifest.d, ...grade.slot };
          const debited = events
            .filter(
              (event) =>
                isDeepStrictEqual(event.phase, phase) &&
                event.detail.kind === 'EvaluationBudgetDebited' &&
                event.detail.budget === 'aggregateChildCommandTimeSeconds',
            )
            .flatMap((event) =>
              event.detail.kind === 'EvaluationBudgetDebited'
                ? [measuredCleanups.get(event.detail.receiptArtifactSaid)]
                : [],
            );
          for (const cleanup of [
            grade.buildCleanupReceiptSaid,
            ...grade.publicCleanupReceiptSaids,
            grade.cleanupReceiptSaid,
          ])
            expect(debited, `native accounting for ${JSON.stringify(grade.slot)}`).toContain(
              cleanup,
            );
        }
        expect(renewals.every((renewal) => renewal.accepted)).toBe(true);
        expect(outcome).toMatchObject({ kind: 'Closed' });
        expect(events.filter((event) => event.detail.kind === 'TrialStopped')).toHaveLength(18);
        expect(ciphertextAttempts).toBe(18);
        expect(
          [...artifacts.values()].filter(
            (raw) =>
              decodeTrialObservationEvidence(
                raw.artifact,
                Buffer.from(raw.bytesBase64Url, 'base64url'),
              ).kind === 'Accepted',
          ),
        ).toHaveLength(18);
        expect(
          [...artifacts.values()].filter(
            (raw) =>
              decodeComparisonMeasurementEvidence(
                raw.artifact,
                Buffer.from(raw.bytesBase64Url, 'base64url'),
              ).kind === 'Accepted',
          ),
        ).toHaveLength(15);
        expect(contexts.join('\n')).not.toContain('fixture-private-canary');
        expect(await readFile(join(fixture.sourceDirectory, 'src/lib.rs'), 'utf8')).toBe(original);
      } finally {
        outbox?.close();
        await new Promise<void>((resolveClosed) =>
          server.close(() => {
            resolveClosed();
          }),
        );
        await rm(root, { recursive: true, force: true });
      }
    }, 1_800_000);
  },
);
