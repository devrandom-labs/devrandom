import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import {
  assessTamperAuditScope,
  closeComparison,
  createRun,
  comparisonSlots,
  tamperAuditObligations,
  tamperLifecycleRoles,
  type ComparisonSlot,
  type TrialObservation,
} from '@devrandom/domain';
import {
  encodeEvaluationVerifierBundle,
  harnessCommandFingerprint,
  prepareComparisonMeasurementEvidence,
  prepareEvaluationClosure,
  prepareEvaluationClosureEvidenceIndex,
  prepareEvaluationEvidenceEvent,
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  prepareEvidenceArtifact,
  prepareProtectedEvaluationArtifact,
  prepareTrialObservationEvidence,
  prepareEvaluationAuditAssessmentArtifact,
  type EvaluationEvidenceEvent,
  type EvidenceArtifact,
  type ProtectedEvaluationArtifact,
} from '@devrandom/protocol';
import Fastify from 'fastify';
import { Binary, MongoClient, type Document } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  evidenceCollectionNames,
  evidenceUsageDocumentId,
} from '../../evidence/infrastructure/evidence-storage-contract.js';
import { encodeHarnessDocument } from '../../harness/infrastructure/harness-document.js';
import { harnessRevisionsCollectionName } from '../../harness/infrastructure/mongo-harness-revisions.js';
import {
  baselineHarnessCommandFixture,
  harnessTask,
} from '../../harness/test/harness-command-fixture.js';
import { encodeRunDocument } from '../../run/infrastructure/run-document.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import { closeEvaluation } from '../application/close-evaluation.js';
import { evaluationRoutes } from '../route/evaluation-routes.js';
import { MongoEvaluationBootstrap } from './mongo-evaluation-bootstrap.js';
import { MongoEvaluationEvidence } from './mongo-evaluation-evidence.js';
import {
  evaluationCollectionNames,
  type EvaluationDocument,
} from './mongo-evaluation-reservations.js';

const mongoUri = process.env.DEVRANDOM_MONGODB_URI;
const describeMongo = mongoUri === undefined ? describe.skip : describe;
const said = (character: string): string => `E${character.repeat(43)}`;
const ownerAid = harnessTask.ownerAid;
const allocation = {
  providerRequests: 8,
  providerInputTokens: 1_000,
  providerOutputTokens: 1_000,
  providerSpendMicroUsd: 50_000,
  runWallTimeSeconds: 1_000,
  toolProposals: 100,
  aggregateChildCommandTimeSeconds: 1_000,
  changedFiles: 100,
  changedWorktreeBytes: 100_000,
  evidencePlusArtifactsPerRunBytes: 8 * 1_024 * 1_024,
};

/** This fixture proves the hosted mechanism, not a live local E3 comparison or signature. */
describeMongo('EvidenceOnly closure over listening Fastify and replica Mongo', () => {
  const client = new MongoClient(mongoUri ?? 'mongodb://127.0.0.1:27017');
  const database = client.db(`devrandom_closure_${randomUUID().replaceAll('-', '')}`);
  const server = Fastify();
  const repository = new MongoEvaluationEvidence(client, database);
  let address: string;

  beforeAll(async () => {
    await client.connect();
    await new MongoEvaluationBootstrap(database).bootstrap();
    await database.collection<Document & { _id: string }>(evidenceCollectionNames.usage).insertOne({
      _id: evidenceUsageDocumentId,
      acceptedBytes: 0,
      version: 0,
    });
    server.register(
      evaluationRoutes({
        access: {
          authorize: ({ bearerSecret }) =>
            Promise.resolve(
              bearerSecret === 'b'.repeat(43)
                ? { kind: 'Authorized' as const, ownerAid }
                : { kind: 'Denied' as const },
            ),
        },
        preparation: { prepare: () => Promise.resolve('Unavailable') },
        admission: { admit: () => Promise.resolve({ kind: 'Unavailable' }) },
        leases: { renew: () => Promise.resolve({ kind: 'Unavailable' }) },
        manifest: {
          lock: () => Promise.resolve({ kind: 'Unavailable' }),
          inspect: () => Promise.resolve({ kind: 'Unavailable' }),
        },
        evidence: {
          accept: (request) => repository.accept(request),
          close: (request) =>
            closeEvaluation(request, {
              // The real KERIA authority has separate live signature tests.
              authority: { verify: () => Promise.resolve({ kind: 'Authorized' }) },
              closures: repository,
            }),
        },
        now: () => new Date().toISOString(),
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

  it('commits only a complete signed-index mechanism and atomically settles the Task debit', async () => {
    const harnessCommand = baselineHarnessCommandFixture();
    const revision = harnessCommand.revision;
    const calibrationRunId = randomUUID();
    const originRunId = randomUUID();
    const evaluationId = randomUUID();
    const evidenceStreamId = randomUUID();
    const leaseId = randomUUID();
    const now = new Date();
    const projection = {
      version: 1 as const,
      ownerAid,
      commandId: harnessCommand.commandId,
      acceptedAt: '2026-09-24T19:50:00.000Z',
      revision,
    };
    const harness = encodeHarnessDocument(projection, harnessCommandFingerprint(harnessCommand));
    await database
      .collection<Document & { _id: string }>(harnessRevisionsCollectionName)
      .insertOne({
        ...harness,
        activation: {
          kind: 'InitialSpecializationAccepted',
          harnessLineageId: revision.task.harnessLineageId,
          harnessRevisionSaid: revision.d,
          runId: calibrationRunId,
          acceptedAt: new Date('2026-09-24T19:55:00.000Z'),
        },
      });
    const created = createRun({
      runId: originRunId,
      ownerAid,
      taskId: harnessTask.taskId,
      taskRevisionSaid: harnessTask.revisionSaid,
      harnessLineageId: revision.task.harnessLineageId,
      personalAgentAid: revision.authority.personalAgentAid,
      taskMandateSaid: revision.authority.taskMandateSaid,
      governorAid: said('g'),
      promotionMandateSaid: said('p'),
      initialHarnessRevisionSaid: revision.d,
      purpose: { kind: 'Retained' },
      initialSpecialization: {
        kind: 'InitialSpecializationAccepted',
        harnessLineageId: revision.task.harnessLineageId,
        harnessRevisionSaid: revision.d,
        runId: calibrationRunId,
        acceptedAt: '2026-09-24T19:55:00.000Z',
      },
      repository: {
        objectFormat: revision.repository.objectFormat,
        commit: revision.repository.commit,
        tree: revision.repository.tree,
      },
      commandId: randomUUID(),
      admissionExchangeSaid: said('x'),
      evidenceStreamId: randomUUID(),
      budget: harnessTask.revision.budgets,
      acceptedAt: '2026-09-24T20:00:00.000Z',
    });
    if (created.kind !== 'Created') throw new Error(`retained Run invalid: ${created.reason}`);
    const blockedRun = {
      ...created.run,
      lifecycle: {
        kind: 'Active' as const,
        phase: {
          kind: 'Blocked' as const,
          reason: 'HarnessCompatibilityFailure' as const,
          checkpointSaid: said('c'),
        },
      },
    };
    await database
      .collection<Document & { _id: string }>(runsCollectionName)
      .insertOne(encodeRunDocument(blockedRun, `sha256:${'a'.repeat(64)}`));

    const protectedArtifact = (
      purpose: 'TrialHoldout' | 'TerminalCase' | 'OracleObservation',
      objectSaid: string,
      segment: number,
      byte: number,
    ) => {
      const prepared = prepareProtectedEvaluationArtifact({
        evaluationId,
        objectSaid,
        purpose,
        segment,
        nonce: Buffer.alloc(12, byte).toString('base64url'),
        tag: Buffer.alloc(16, byte).toString('base64url'),
        ciphertext: Buffer.from([byte]).toString('base64url'),
        plaintextByteCount: 1,
      });
      if (prepared.kind !== 'Prepared') throw new Error('protected fixture invalid');
      return prepared.artifact;
    };
    const trialObjectSaid = said('q');
    const terminalObjectSaid = said('r');
    const lockedProtected = [
      protectedArtifact('TrialHoldout', trialObjectSaid, 0, 1),
      protectedArtifact('OracleObservation', trialObjectSaid, 0, 2),
      protectedArtifact('TerminalCase', terminalObjectSaid, 1, 3),
      protectedArtifact('OracleObservation', terminalObjectSaid, 1, 4),
    ] as const;
    const publicConditions = ['cesr-current', 'cesr-tamper', 'cesr-legacy'] as const;
    const verifier = prepareEvaluationVerifierBundle({
      evaluationId,
      taskId: harnessTask.taskId,
      taskRevisionSaid: harnessTask.revisionSaid,
      ownerAid,
      personalAgentAid: revision.authority.personalAgentAid,
      policySaid: said('P'),
      executionProfileSaid: said('e'),
      oracleAdapterDigest: `sha256:${'d'.repeat(64)}`,
      reviewedRecipeSaid: said('w'),
      toolchainSaid: said('u'),
      publicConditions: publicConditions.map((id) => ({
        id,
        stimulusBase64Url: Buffer.from(`-AAL${said('z')}`).toString('base64url'),
        expected:
          id === 'cesr-tamper'
            ? { kind: 'Rejected' as const, error: 'AnyRejection' as const }
            : {
                kind: 'Parsed' as const,
                receipts: [{ version: 'Current' as const, payload: said('z') }],
              },
      })),
      protectedCase: {
        objectSaid: trialObjectSaid,
        stimulus: lockedProtected[0],
        expected: lockedProtected[1],
      },
      terminalCase: {
        objectSaid: terminalObjectSaid,
        stimulus: lockedProtected[2],
        expected: lockedProtected[3],
      },
    });
    if (verifier.kind !== 'Prepared') throw new Error('verifier fixture invalid');
    const encodedVerifier = encodeEvaluationVerifierBundle(verifier.bundle);
    if (encodedVerifier.kind !== 'Encoded') throw new Error('verifier bytes invalid');
    const manifest = prepareEvaluationManifest({
      evaluationId,
      taskId: harnessTask.taskId,
      taskRevisionSaid: harnessTask.revisionSaid,
      originRunId,
      ownerAid,
      personalAgentAid: revision.authority.personalAgentAid,
      taskMandateSaid: revision.authority.taskMandateSaid,
      retainedCheckpointSaid: said('c'),
      retainedSealSaid: said('s'),
      policySaid: said('P'),
      revisions: { H1: revision.d, C1: said('1'), C2: said('2'), C3: said('3') },
      executionProfileSaid: said('e'),
      sourceInventorySaid: said('i'),
      hypothesisSaid: said('H'),
      verifierSaid: verifier.bundle.d,
      protectedCaseArtifactSaid: lockedProtected[0].d,
      finalCaseArtifactSaid: lockedProtected[2].d,
      publicConditionIds: [...publicConditions],
      heldOutCaseCount: 1,
      allocation: { diagnosis: allocation, perEntry: allocation, finalization: allocation },
    });
    if (manifest.kind !== 'Prepared') throw new Error(`M invalid: ${manifest.reason}`);
    const command = {
      version: 1 as const,
      commandId: randomUUID(),
      fingerprint: `sha256:${'f'.repeat(64)}`,
      taskId: harnessTask.taskId,
      taskRevisionSaid: harnessTask.revisionSaid,
      originRunId,
      retainedCheckpointSaid: said('c'),
      retainedSealSaid: said('s'),
      expectedActiveRevisionSaid: revision.d,
      personalAgentAid: revision.authority.personalAgentAid,
      taskMandateSaid: revision.authority.taskMandateSaid,
      policySaid: said('P'),
      executionProfileSaid: said('e'),
      sourceInventorySaid: said('i'),
      allocation: manifest.manifest.allocation,
    };
    const evaluation: EvaluationDocument = {
      _id: evaluationId,
      ownerAid,
      command,
      reserved: allocation,
      reservationSaid: said('R'),
      evidenceStreamId,
      version: 2,
      lease: {
        evaluationId,
        leaseId,
        version: 1,
        serverTime: now.toISOString(),
        expiresAt: new Date(now.valueOf() + 300_000).toISOString(),
      },
      acceptedThroughSequence: -1,
      chainHeadSaid: null,
      acceptedBytes: 0,
      activeOwnerSlot: ownerAid,
      acceptedAt: now,
    };
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .insertOne(evaluation);
    await database
      .collection<Document & { _id: string }>(evaluationCollectionNames.manifests)
      .insertOne({
        _id: evaluationId,
        ownerAid,
        manifest: manifest.manifest,
        verifierBundle: verifier.bundle,
        verifierBytes: new Binary(encodedVerifier.bytes),
        protectedArtifactSaids: lockedProtected.map((artifact) => artifact.d),
        leaseId,
        lockedAtLeaseVersion: 1,
        lockedAtEvaluationVersion: 2,
        commandId: randomUUID(),
        fingerprint: `sha256:${'f'.repeat(64)}`,
        acceptedAt: now,
      });
    await database
      .collection<Document & { _id: string }>(evaluationCollectionNames.artifacts)
      .insertMany(
        lockedProtected.map((artifact) => ({
          _id: artifact.d,
          ownerAid,
          evaluationId,
          custody: 'ProtectedCiphertext',
          artifact,
          acceptedAt: now,
        })),
      );
    const events: EvaluationEvidenceEvent[] = [];
    const artifacts: {
      _id: string;
      ownerAid: string;
      evaluationId: string;
      custody: 'Public' | 'ProtectedCiphertext';
      artifact: EvidenceArtifact | ProtectedEvaluationArtifact;
      bytes?: Binary;
      acceptedAt: Date;
    }[] = [];
    type Phase = EvaluationEvidenceEvent['phase'];
    type Detail = EvaluationEvidenceEvent['detail'];
    const research: Phase = { kind: 'Research', policySaid: said('P'), role: 'DiagnosticRefiner' };
    const phaseFor = (slot: ComparisonSlot): Phase => ({
      kind: 'Trial',
      manifestSaid: manifest.manifest.d,
      arm: slot.arm,
      repetition: slot.repetition,
      attempt: slot.attempt,
    });
    const revisionFor = (slot: ComparisonSlot): string =>
      slot.arm === 'H1TaskSearch' ? revision.d : manifest.manifest.revisions[slot.arm];
    const emit = (detail: Detail, phase: Phase, harnessRevisionSaid = revision.d) => {
      const previous = events.at(-1);
      const prepared = prepareEvaluationEvidenceEvent({
        evaluationId,
        streamId: evidenceStreamId,
        originRunId,
        taskId: harnessTask.taskId,
        taskRevisionSaid: harnessTask.revisionSaid,
        personalAgentAid: revision.authority.personalAgentAid,
        taskMandateSaid: revision.authority.taskMandateSaid,
        harnessRevisionSaid,
        phase,
        sequence: events.length,
        previous:
          previous === undefined
            ? { kind: 'Genesis' }
            : { kind: 'Previous', eventSaid: previous.d },
        occurredAt: new Date().toISOString(),
        detail,
      });
      if (prepared.kind !== 'Prepared')
        throw new Error(`event fixture invalid: ${prepared.reason}`);
      events.push(prepared.event);
      return prepared.event;
    };
    const capturePublic = (label: string, phase: Phase, harnessRevisionSaid = revision.d) => {
      const bytes = Buffer.from(JSON.stringify({ label }));
      const prepared = prepareEvidenceArtifact(bytes, 'application/json');
      if (prepared.kind !== 'Prepared') throw new Error('public artifact fixture invalid');
      artifacts.push({
        _id: prepared.artifact.d,
        ownerAid,
        evaluationId,
        custody: 'Public',
        artifact: prepared.artifact,
        bytes: new Binary(bytes),
        acceptedAt: now,
      });
      emit(
        { kind: 'ArtifactCaptured', artifactSaid: prepared.artifact.d, custody: 'Public' },
        phase,
        harnessRevisionSaid,
      );
      return prepared.artifact.d;
    };
    const capturePrepared = (
      prepared: { artifact: EvidenceArtifact; bytes: Uint8Array },
      phase: Phase,
      harnessRevisionSaid = revision.d,
    ) => {
      artifacts.push({
        _id: prepared.artifact.d,
        ownerAid,
        evaluationId,
        custody: 'Public',
        artifact: prepared.artifact,
        bytes: new Binary(prepared.bytes),
        acceptedAt: now,
      });
      emit(
        { kind: 'ArtifactCaptured', artifactSaid: prepared.artifact.d, custody: 'Public' },
        phase,
        harnessRevisionSaid,
      );
      return prepared.artifact.d;
    };
    const observations: {
      slot: ComparisonSlot;
      artifactSaid: string;
    }[] = [];
    const observationValues: TrialObservation[] = [];
    const providerUsageSaid = said('U');
    for (const [position, slot] of comparisonSlots().entries()) {
      const phase = phaseFor(slot);
      const harnessRevisionSaid = revisionFor(slot);
      const sourceSaid = capturePublic(`source-${String(position)}`, phase, harnessRevisionSaid);
      const cleanupSaid = capturePublic(
        `trial-cleanup-${String(position)}`,
        phase,
        harnessRevisionSaid,
      );
      const publicObservations = publicConditions.map((conditionId) => ({
        conditionId,
        rawObservationSaid: capturePublic(
          `public-${conditionId}-${String(position)}`,
          phase,
          harnessRevisionSaid,
        ),
        verdict: 'Pass' as const,
      }));
      const protectedCleanupReceiptSaid = capturePublic(
        `protected-cleanup-${String(position)}`,
        phase,
        harnessRevisionSaid,
      );
      const protectedObservation = protectedArtifact(
        'OracleObservation',
        trialObjectSaid,
        0,
        position + 20,
      );
      artifacts.push({
        _id: protectedObservation.d,
        ownerAid,
        evaluationId,
        custody: 'ProtectedCiphertext',
        artifact: protectedObservation,
        acceptedAt: now,
      });
      emit(
        {
          kind: 'ArtifactCaptured',
          artifactSaid: protectedObservation.d,
          custody: 'ProtectedCiphertext',
        },
        phase,
        harnessRevisionSaid,
      );
      const trialHead = emit(
        { kind: 'TrialStopped', reason: 'Completed' },
        phase,
        harnessRevisionSaid,
      );
      const observation: TrialObservation = {
        slot,
        disposition: {
          kind: 'Measured',
          artifactSaid: sourceSaid,
          publicConditionIds: [...publicConditions],
          heldOutConditionIds: [trialObjectSaid],
          usage: {
            providerRequests: position === 0 ? 1 : 0,
            inputTokens: position === 0 ? 1 : 0,
            outputTokens: position === 0 ? 1 : 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            spendMicroUsd: position === 0 ? 1 : 0,
            elapsedMilliseconds: 1,
            repeatedFailures: 0,
            unsafeProposals: 0,
            unsafePrevented: 0,
            unsafeEffects: 0,
          },
        },
      };
      const wrapped = prepareTrialObservationEvidence({
        version: 1,
        kind: 'TrialObservationEvidence',
        evaluationId,
        manifestSaid: manifest.manifest.d,
        harnessRevisionSaid,
        observation,
        capturedSourceSaid: sourceSaid,
        trialEvidenceHeadSaid: trialHead.d,
        trialCleanupReceiptSaid: cleanupSaid,
        publicObservations,
        protectedObservationSaid: protectedObservation.d,
        protectedVerdict: 'Pass',
        protectedCleanupReceiptSaid,
        providerUsageEventSaids: position === 0 ? [providerUsageSaid] : [],
      });
      if (wrapped.kind !== 'Prepared') throw new Error(`observation invalid: ${wrapped.reason}`);
      capturePrepared(wrapped, phase, harnessRevisionSaid);
      observations.push({ slot, artifactSaid: wrapped.artifact.d });
      observationValues.push(observation);
    }
    const compared = closeComparison(
      { public: [...publicConditions], heldOut: [trialObjectSaid] },
      observationValues,
    );
    if (compared.kind !== 'EvidenceOnly') throw new Error(`comparison invalid: ${compared.kind}`);
    const measurements = compared.measurements.map((measurement) => {
      const slot = measurement.slot;
      const sourceObservationSaids = observations
        .filter((entry) => entry.slot.arm === slot.arm && entry.slot.repetition === slot.repetition)
        .map((entry) => entry.artifactSaid);
      const wrapped = prepareComparisonMeasurementEvidence({
        version: 1,
        kind: 'ComparisonMeasurementEvidence',
        evaluationId,
        manifestSaid: manifest.manifest.d,
        harnessRevisionSaid: revisionFor(slot),
        measurement,
        sourceObservationSaids,
      });
      if (wrapped.kind !== 'Prepared') throw new Error(`measurement invalid: ${wrapped.reason}`);
      capturePrepared(wrapped, phaseFor(slot), revisionFor(slot));
      return { slot, artifactSaid: wrapped.artifact.d };
    });
    const scopes = ['Shared', 'H1', 'C1', 'C2', 'C3', 'H1TaskSearch'] as const;
    const audits = scopes.map((scope) => {
      const proofs = tamperAuditObligations.map((obligation) => ({
        scope,
        obligation,
        proofSaid: capturePublic(`audit-${scope}-${obligation}`, research),
        finding: 'Pass' as const,
      }));
      const attemptCoverage = {
        scope,
        proofSaid: capturePublic(`attempt-coverage-${scope}`, research),
        complete: true,
        coveredRoles: [...tamperLifecycleRoles],
        attempts: [],
      };
      const assessed = assessTamperAuditScope({
        scope,
        proofs,
        attemptCoverage: [attemptCoverage],
      });
      const report = prepareEvaluationAuditAssessmentArtifact(assessed);
      if (report.kind !== 'Prepared') throw new Error('audit report invalid');
      capturePrepared(report, research);
      return {
        scope,
        assessmentArtifactSaid: report.artifact.d,
        proofs,
        attemptCoverage,
        obligations: assessed.obligations,
        verdict: assessed.verdict,
      };
    });
    const modelRawSaid = capturePublic('provider-usage-verified-fixture', research);
    const modelEvent = emit({ kind: 'ModelExchange', rawArtifactSaid: modelRawSaid }, research);
    const toolInputSaid = capturePublic('tool-proposal-input', research);
    const toolEvent = emit(
      {
        kind: 'ToolProposed',
        proposalIndex: 0,
        toolCallId: 'tool-1',
        inputArtifactSaid: toolInputSaid,
      },
      research,
    );
    const zeroSource = events.at(-1);
    if (zeroSource === undefined) throw new Error('source event missing');
    const dimensions = [
      'providerRequests',
      'providerInputTokens',
      'providerOutputTokens',
      'providerSpendMicroUsd',
      'runWallTimeSeconds',
      'toolProposals',
      'aggregateChildCommandTimeSeconds',
      'changedFiles',
      'changedWorktreeBytes',
    ] as const;
    const totals = Object.fromEntries(
      dimensions.map((dimension) => [
        dimension,
        dimension.startsWith('provider') || dimension === 'toolProposals' ? 1 : 0,
      ]),
    );
    const anchors = dimensions.map((dimension) => {
      const amount = totals[dimension] ?? 0;
      const sourceEventSaid = dimension.startsWith('provider')
        ? modelEvent.d
        : dimension === 'toolProposals'
          ? toolEvent.d
          : zeroSource.d;
      const receiptArtifactSaid = capturePublic(`budget-${dimension}-${String(amount)}`, research);
      const debit = emit(
        {
          kind: 'EvaluationBudgetDebited',
          budget: dimension,
          amount,
          consumed: amount,
          receiptArtifactSaid,
          sourceEventSaid,
        },
        research,
      );
      return { dimension, finalDebitEventSaid: debit.d, receiptArtifactSaid, sourceEventSaid };
    });
    const beforeCoverage = events.at(-1);
    if (beforeCoverage === undefined) throw new Error('coverage predecessor missing');
    const coverage = emit(
      {
        kind: 'EvaluationBudgetCovered',
        throughSequence: beforeCoverage.sequence,
        throughHeadSaid: beforeCoverage.d,
        totals: totals as Record<(typeof dimensions)[number], number>,
        providerUsageEventSaids: [providerUsageSaid],
      },
      research,
    );
    const indexed = prepareEvaluationClosureEvidenceIndex({
      version: 1,
      kind: 'EvaluationClosureEvidenceIndex',
      evaluationId,
      manifestSaid: manifest.manifest.d,
      sourceInventorySaid: manifest.manifest.sourceInventorySaid,
      hypothesisSaid: manifest.manifest.hypothesisSaid,
      lease: { leaseId, version: 1 },
      observations,
      measurements,
      audits,
      budget: { coverageEventSaid: coverage.d, totals, anchors },
    });
    if (indexed.kind !== 'Prepared') throw new Error(`index invalid: ${indexed.reason}`);
    const closure = prepareEvaluationClosure({
      evaluationId,
      evidenceStreamId,
      originRunId,
      manifestSaid: manifest.manifest.d,
      evidenceIndexSaid: indexed.artifact.d,
      acceptedEventCount: events.length,
      acceptedHeadSaid: coverage.d,
      observationSaids: observations.map((entry) => entry.artifactSaid),
      measurementSaids: measurements.map((entry) => entry.artifactSaid),
      sharedAuditSaid: audits[0]?.assessmentArtifactSaid,
      armAuditSaids: {
        H1: audits[1]?.assessmentArtifactSaid,
        C1: audits[2]?.assessmentArtifactSaid,
        C2: audits[3]?.assessmentArtifactSaid,
        C3: audits[4]?.assessmentArtifactSaid,
        H1TaskSearch: audits[5]?.assessmentArtifactSaid,
      },
      protectedCustodySaid:
        observations.at(-1) === undefined
          ? said('x')
          : artifacts.filter((artifact) => artifact.custody === 'ProtectedCiphertext').at(-1)?._id,
      agentSealSaid: said('S'),
    });
    if (closure.kind !== 'Prepared') throw new Error(`closure invalid: ${closure.reason}`);
    const acceptedBytes =
      events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0) +
      artifacts.reduce((sum, artifact) => sum + (artifact.bytes?.length() ?? 0), 0);
    await database
      .collection<Document & { _id: string }>(evaluationCollectionNames.events)
      .insertMany(
        events.map((event) => ({
          _id: event.d,
          ownerAid,
          evaluationId,
          streamId: evidenceStreamId,
          sequence: event.sequence,
          batchSaid: said('B'),
          event,
        })),
      );
    await database
      .collection<Document & { _id: string }>(evaluationCollectionNames.artifacts)
      .insertMany(artifacts);
    await database.collection<EvaluationDocument>(evaluationCollectionNames.evaluations).updateOne(
      { _id: evaluationId },
      {
        $set: {
          acceptedThroughSequence: coverage.sequence,
          chainHeadSaid: coverage.d,
          acceptedBytes,
          version: 3,
        },
      },
    );
    const body = {
      version: 1,
      commandId: randomUUID(),
      fingerprint: `sha256:${'f'.repeat(64)}`,
      expectedEvaluationVersion: 3,
      closure: closure.closure,
      evidenceIndex: {
        artifact: indexed.artifact,
        bytesBase64Url: Buffer.from(indexed.bytes).toString('base64url'),
      },
    };
    const endpoint = `${address}/api/evaluations/${evaluationId}/closure`;
    const headers = {
      authorization: `Bearer ${'b'.repeat(43)}`,
      'content-type': 'application/json',
    };
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .updateOne({ _id: evaluationId }, { $set: { 'lease.version': 2 } });
    const staleLease = await fetch(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    expect(staleLease.status).toBe(422);
    await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .updateOne({ _id: evaluationId }, { $set: { 'lease.version': 1 } });
    const firstObservation = artifacts.find(
      (artifact) => artifact._id === observations[0]?.artifactSaid,
    );
    if (firstObservation === undefined) throw new Error('first observation custody missing');
    await database
      .collection<Document & { _id: string }>(evaluationCollectionNames.artifacts)
      .deleteOne({ _id: firstObservation._id });
    const missingObservation = await fetch(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    expect(missingObservation.status).toBe(422);
    const retained = await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .findOne({ _id: evaluationId });
    expect(retained?.closure).toBeUndefined();
    expect(retained?.activeOwnerSlot).toBe(ownerAid);
    await database
      .collection<Document & { _id: string }>(evaluationCollectionNames.artifacts)
      .insertOne(firstObservation);
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status, await response.text()).toBe(201);
    const settled = await database
      .collection<EvaluationDocument>(evaluationCollectionNames.evaluations)
      .findOne({ _id: evaluationId });
    expect(settled?.closure).toEqual(closure.closure);
    expect(settled?.activeOwnerSlot).toBeUndefined();
    expect(settled).toHaveProperty(
      'settledDebit.consumed.evidencePlusArtifactsPerRunBytes',
      acceptedBytes,
    );
    expect(
      await repository.reconcile({
        ownerAid,
        closure: closure.closure,
        evidenceIndex: { artifact: indexed.artifact, bytes: indexed.bytes },
      }),
    ).toEqual({ kind: 'AlreadyClosed', closureSaid: closure.closure.d });
    const retry = await fetch(endpoint, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    expect(retry.status, await retry.text()).toBe(200);
  });
});
