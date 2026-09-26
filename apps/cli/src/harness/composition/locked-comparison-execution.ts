import {
  FinalizationNativeGrading,
  type FinalizationNativeMeasurement,
} from '../application/finalization-native-grading.js';
import Value from 'typebox/value';
import { evaluationClosureCommandSchema, prepareEvidenceArtifact } from '@devrandom/protocol';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  comparisonSlots,
  evaluationConsumables,
  assessEvaluationLease,
  selectTaskSearchArtifact,
  type EvaluationExecutionBinding,
  type EvaluationLeaseReceipt,
  type ComparisonSlot,
  type ProtectedCredentials,
} from '@devrandom/domain';
import {
  decodeBaselineHarnessRevision,
  decodeEvaluationManifest,
  decodeEvaluationVerifierBundleBytes,
  bindEvaluationVerifierBundle,
  prepareEvaluationEvidenceEvent,
  prepareEvaluationClosureEvidenceIndex,
  prepareEvaluationClosure,
  type EvaluationManifest,
  type EvaluationEvidenceEvent,
  type EvidenceArtifact,
  type BaselineHarnessRevision,
  type EvaluationClosureSealClaim,
} from '@devrandom/protocol';
import {
  measureFinalizationElapsed,
  type CodingElapsedInterval,
  AcceptedParentTrialUsage,
  AcceptedConcentrateProviderUsage,
  AcceptedProposalCapacity,
  AuthorizedEvaluationTools,
  ParentConcentrateEvaluationInference,
  DockerContainedTrialExecution,
  DockerTaskArtifactConstruction,
  DockerReceiptObservation,
  ExecutableCustody,
  C2OriginalPublicVerification,
  ProvisionalSubmissionAuthorization,
  observePublicTrialArtifact,
  gradePublicTrialArtifact,
  prepareMeasuredTrialObservation,
  prepareComparisonMeasurements,
  prepareEvaluationBudgetCoverage,
  type ToolName,
  type EvaluationLease,
  type CurrentToolMandate,
  type EvaluationCaseInventory,
  type ProtectedCaseCustody,
  type ReviewedReceiptOracle,
  type PublicTrialArtifactObservation,
  type ProtectedTrialInput,
  type SourceCustody,
  type EvaluationMeasurementReceipts,
} from '@devrandom/runtime';
import type {
  LocalEvaluationClosureSealExchange,
  PersonalAgentAid,
  IssuerAid,
} from '@devrandom/identity';
import { type ServerEvaluationHttp } from '../infrastructure/server-evaluation-http.js';
import { type SqliteEvaluationEvidenceOutbox } from '../infrastructure/sqlite-evaluation-evidence-outbox.js';
import { SqliteHostedEvaluationEvidence } from '../infrastructure/sqlite-hosted-evaluation-evidence.js';
import { HostedEvaluationEvidenceReading } from '../infrastructure/hosted-evaluation-evidence-reading.js';
import { HostedEvaluationManifestLock } from '../infrastructure/hosted-evaluation-manifest-lock.js';
import { HostedEvaluationProtectedArtifacts } from '../infrastructure/hosted-evaluation-protected-artifacts.js';
import { HostedEvaluationProviderCustody } from '../infrastructure/hosted-evaluation-provider-custody.js';
import { SqliteEvaluationProviderAllowance } from '../infrastructure/sqlite-evaluation-provider-allowance.js';
import { DockerEvaluationToolEffects } from '../infrastructure/docker-evaluation-tool-effects.js';
import { ManagedWorktreeResources } from '../../run/infrastructure/managed-worktree-tools.js';
import {
  prepareParentAuditOperation,
  type ParentAuditOperationInput,
} from '../../promotion/application/parent-audit-operation.js';
import { prepareParentEvaluationAudit } from '../../promotion/application/prepare-parent-evaluation-audit.js';
import { regradeProtectedCesrObservation } from '../../promotion/application/regrade-protected-cesr-observation.js';
import { PromotionEvidenceFile } from '../../promotion/infrastructure/promotion-evidence-file.js';

type Configuration = ConstructorParameters<typeof DockerContainedTrialExecution>[0];
type InferenceOpening = ConstructorParameters<
  typeof ParentConcentrateEvaluationInference
>[0]['opened'];
type Public = Extract<PublicTrialArtifactObservation, { kind: 'PublicObserved' }>;
type Head = { readonly sequence: number; readonly headSaid: string };
export interface LockedComparisonInput {
  readonly researchPreparation?: {
    readonly receiptArtifactSaid: string;
    readonly finishedMonotonicMicroseconds: number;
  };
  readonly stateRoot: string;
  readonly manifest: EvaluationManifest;
  readonly binding: EvaluationExecutionBinding;
  readonly admittedCommandId: string;
  readonly cleanSourceSaid: string;
  readonly source: SourceCustody;
  readonly baseline: BaselineHarnessRevision;
  readonly protectedPaths: readonly string[];
  readonly readOnlyPaths: readonly string[];
  readonly profile: Configuration['profile'];
  readonly image: string;
  readonly openedModel: InferenceOpening;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly workerMounts: Configuration['workerMounts'];
  readonly workerProgram: string;
  readonly candidates: {
    readonly C1: NonNullable<Configuration['c1Treatment']>;
    readonly C2: Omit<NonNullable<Configuration['c2Workflow']>, 'submission' | 'verification'>;
    readonly C3: NonNullable<Configuration['c3Selection']>;
  };
  readonly hosted: ServerEvaluationHttp;
  readonly outbox: SqliteEvaluationEvidenceOutbox;
  readonly mandate: CurrentToolMandate;
  readonly cases: EvaluationCaseInventory;
  readonly custody: ProtectedCaseCustody;
  readonly oracle: ReviewedReceiptOracle;
  readonly credentials: ProtectedCredentials;
  readonly signing: {
    readonly exchange: LocalEvaluationClosureSealExchange;
    readonly senderAlias: string;
    readonly sourceAid: PersonalAgentAid;
    readonly recipientAid: IssuerAid;
  };
  readonly signal: AbortSignal;
}
export type LockedComparisonOutcome =
  | { readonly kind: 'Closed'; readonly closureSaid: string }
  | { readonly kind: 'RecoveryRequired'; readonly evaluationId: string }
  | { readonly kind: 'Incomplete'; readonly frontier: string };
const fingerprint = (value: unknown) =>
  `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/** Concrete trusted CLI composition: actual contained Pi trials, public-only search
 * selection, protected native grading, semantic audit, agent seal and hosted closure. */
export async function executeLockedComparison(
  input: LockedComparisonInput,
): Promise<LockedComparisonOutcome> {
  const { manifest, binding, hosted, outbox } = input;
  if (
    decodeBaselineHarnessRevision(input.baseline).kind !== 'Accepted' ||
    decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
    manifest.evaluationId !== binding.evaluationId ||
    manifest.revisions.H1 !== input.baseline.d ||
    manifest.executionProfileSaid !== input.profile.d
  )
    return { kind: 'Incomplete', frontier: 'Manifest' };
  const comparisonStarted =
    input.researchPreparation?.finishedMonotonicMicroseconds ??
    Math.floor(performance.now() * 1000);
  if (
    !Number.isSafeInteger(comparisonStarted) ||
    comparisonStarted < 0 ||
    comparisonStarted > Math.floor(performance.now() * 1000)
  )
    return { kind: 'Incomplete', frontier: 'ResearchHandoff' };
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const evidence = new SqliteHostedEvaluationEvidence(outbox, hosted);
  const reading = new HostedEvaluationEvidenceReading(hosted);
  const head = (): Head => {
    const position = outbox.position();
    if (
      position.kind !== 'Position' ||
      position.acknowledgedHeadSaid === null ||
      position.acknowledgedSequence !== position.nextSequence - 1
    )
      throw new Error('UnacknowledgedEvidence');
    return { sequence: position.acknowledgedSequence, headSaid: position.acknowledgedHeadSaid };
  };
  const phaseBinding = (slot: ComparisonSlot): EvaluationExecutionBinding => ({
    ...binding,
    harnessRevisionSaid: manifest.revisions[slot.arm === 'H1TaskSearch' ? 'H1' : slot.arm],
    phase: { kind: 'Trial', manifestSaid: manifest.d, ...slot },
  });
  let activeBinding = binding;
  let lease: EvaluationLeaseReceipt | undefined;
  let requestStartedAt = 0;
  let refreshing: Promise<boolean> | undefined;
  const refresh = (): Promise<boolean> => {
    if (refreshing !== undefined) return refreshing;
    refreshing = (async () => {
      const started = Date.now();
      const current = await hosted.readPosition(binding.evaluationId);
      if (
        current.kind !== 'Read' ||
        current.position.lease.leaseId !== binding.evaluationLeaseId ||
        current.position.ownerAid !== manifest.ownerAid
      )
        return false;
      const previousLease = lease;
      lease = current.position.lease;
      if (previousLease?.version !== lease.version)
        requestStartedAt = started - Math.max(0, Date.now() - Date.parse(lease.serverTime));
      if (Date.parse(lease.expiresAt) - Date.now() <= 15000) {
        const command = {
          version: 1 as const,
          commandId: randomUUID(),
          fingerprint: fingerprint([binding.evaluationId, lease.leaseId, current.position.version]),
          evaluationId: binding.evaluationId,
          leaseId: lease.leaseId,
          expectedEvaluationVersion: current.position.version,
        };
        const renewedAt = Date.now();
        const renewed = await hosted.renewLease(command, signal);
        if (
          (renewed.kind !== 'Renewed' && renewed.kind !== 'AlreadyRenewed') ||
          !('lease' in renewed.receipt)
        )
          return false;
        lease = renewed.receipt.lease;
        requestStartedAt = renewedAt;
      }
      return (
        assessEvaluationLease(
          lease,
          binding.evaluationId,
          binding.evaluationLeaseId,
          requestStartedAt,
          Date.now(),
        ).kind === 'Held'
      );
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  const leaseInspection: EvaluationLease = {
    inspect: async (candidate) =>
      candidate.evaluationId !== binding.evaluationId ||
      candidate.evaluationLeaseId !== binding.evaluationLeaseId ||
      !(await refresh()) ||
      lease === undefined
        ? { kind: 'Lost' }
        : {
            kind: 'Held',
            expiresAt: new Date(
              requestStartedAt + Date.parse(lease.expiresAt) - Date.parse(lease.serverTime) - 5000,
            ).toISOString(),
          },
  };
  const pulse = setInterval(() => {
    void refresh()
      .then((held) => {
        if (!held) controller.abort();
      })
      .catch(() => {
        controller.abort();
      });
  }, 5000);
  let directory: string | undefined;
  const append = async (
    detail: EvaluationEvidenceEvent['detail'],
    selected = activeBinding,
  ): Promise<EvaluationEvidenceEvent> => {
    const current = head();
    const prepared = prepareEvaluationEvidenceEvent({
      evaluationId: selected.evaluationId,
      streamId: selected.evidenceStreamId,
      originRunId: selected.originRunId,
      taskId: selected.taskId,
      taskRevisionSaid: selected.taskRevisionSaid,
      personalAgentAid: selected.personalAgentAid,
      taskMandateSaid: selected.taskMandateSaid,
      harnessRevisionSaid: selected.harnessRevisionSaid,
      phase: selected.phase,
      sequence: current.sequence + 1,
      previous: { kind: 'Previous', eventSaid: current.headSaid },
      occurredAt: new Date().toISOString(),
      detail,
    });
    if (prepared.kind !== 'Prepared') throw new Error('EventInvalid');
    const recorded = await evidence.record(prepared.event);
    if (recorded.kind !== 'Recorded') throw new Error(`Evidence:${recorded.kind}`);
    return prepared.event;
  };
  const capture = async (
    raw: { readonly artifact: EvidenceArtifact; readonly bytes: Uint8Array },
    selected = activeBinding,
  ) => {
    const retained = await evidence.rawArtifacts.record({
      bytes: raw.bytes,
      mediaType: raw.artifact.mediaType,
    });
    if (retained.kind !== 'Stored' || retained.artifact.d !== raw.artifact.d)
      throw new Error('ArtifactCustody');
    return append(
      { kind: 'ArtifactCaptured', artifactSaid: raw.artifact.d, custody: 'Public' },
      selected,
    );
  };
  const capturePending = async (selected = activeBinding) => {
    const pending = outbox.unstagedPublicArtifacts();
    if (pending.kind !== 'Found') throw new Error('ArtifactCustody');
    for (const raw of pending.artifacts) await capture(raw, selected);
  };
  const readPrefix = async () => {
    const cursor = head();
    const last = await hosted.readEvidencePage({
      evaluationId: binding.evaluationId,
      afterSequence: cursor.sequence - 1,
      throughSequence: cursor.sequence,
      throughHeadSaid: cursor.headSaid,
    });
    if (last.kind !== 'Read' || last.page.events[0] === undefined)
      throw new Error('AcceptedPrefix');
    const event = last.page.events[0];
    const prefix = await reading.openPrefix({
      binding: { ...binding, harnessRevisionSaid: event.harnessRevisionSaid, phase: event.phase },
      throughSequence: cursor.sequence,
      headSaid: cursor.headSaid,
    });
    if (prefix.kind !== 'Acknowledged') throw new Error('AcceptedPrefix');
    return prefix;
  };
  const accepted = { open: async () => readPrefix() };
  const receipts: EvaluationMeasurementReceipts = {
    openPublic: (request) => reading.openPublic(request),
    verifyProviderUsage: async (request) => {
      const prefix = await readPrefix();
      const event = prefix.events.find((item) => item.d === request.usageEventSaid);
      if (event === undefined) return { kind: 'Missing' };
      return new AcceptedConcentrateProviderUsage({
        binding: { ...binding, harnessRevisionSaid: event.harnessRevisionSaid, phase: event.phase },
        accepted: { open: () => Promise.resolve(prefix) },
        openPublic: (query) => reading.openPublic(query),
      }).verifyProviderUsage(request);
    },
  };
  const measure = new AcceptedParentTrialUsage({
    accepted: reading,
    receipts,
    commands: [...input.baseline.completionCommands, ...(input.baseline.toolCommands ?? [])],
  });
  const operations: string[] = [];
  const operation = async (
    scope: ParentAuditOperationInput['scope'],
    opened: Head,
    details: ParentAuditOperationInput['operation'],
  ) => {
    const prepared = prepareParentAuditOperation({
      evaluationId: binding.evaluationId,
      manifestSaid: manifest.d,
      scope,
      opened,
      closed: head(),
      operation: details,
    });
    if (prepared.kind !== 'Prepared') throw new Error('AuditSource');
    await capture(prepared);
    operations.push(prepared.artifact.d);
  };
  try {
    const pending = outbox.unstagedPublicArtifacts();
    if (pending.kind !== 'Found') throw new Error('ClosureCustody');
    const retry = await retryRetainedComparisonClosure({
      stateRoot: input.stateRoot,
      evaluationId: binding.evaluationId,
      manifestSaid: manifest.d,
      artifacts: pending.artifacts,
      hosted,
      signal,
    });
    if (retry.kind !== 'Absent') return retry;
    if (
      (await evidence.flush()).kind !== 'Acknowledged' ||
      !(await refresh()) ||
      lease === undefined
    )
      return { kind: 'Incomplete', frontier: 'LeaseOrEvidence' };
    const previous = await readPrefix();
    if (previous.events.some((event) => event.phase.kind === 'Trial'))
      return { kind: 'RecoveryRequired', evaluationId: binding.evaluationId };
    const openedCases = await input.cases.open(manifest);
    if (openedCases.kind !== 'Opened') throw new Error('ProtectedCases');
    const decoded = decodeEvaluationVerifierBundleBytes(openedCases.bytes);
    if (
      decoded.kind !== 'Accepted' ||
      bindEvaluationVerifierBundle(decoded.bundle, manifest).kind !== 'Bound'
    )
      throw new Error('ProtectedCases');
    const verifier = decoded.bundle;
    const oracle = await input.oracle.inspect();
    if (oracle.kind !== 'Reviewed' || oracle.digest !== verifier.oracleAdapterDigest)
      throw new Error('OracleIdentity');
    directory = await mkdtemp(join(tmpdir(), 'devrandom-comparison-resources-'));
    const resourceRoot = join(directory, 'source');
    await mkdir(resourceRoot, { mode: 0o700 });
    const clean = await input.source.open(input.cleanSourceSaid);
    if (clean === undefined) throw new Error('CleanSource');
    for (const file of clean.files) {
      await mkdir(dirname(join(resourceRoot, file.path)), { recursive: true, mode: 0o700 });
      await writeFile(join(resourceRoot, file.path), file.bytes, { mode: 0o600 });
    }
    const rules = {
      protectedPaths: input.protectedPaths,
      readOnlyPaths: input.readOnlyPaths,
      completionCommands: input.baseline.completionCommands,
      toolCommands: input.baseline.toolCommands ?? [],
    };
    const resources = new ManagedWorktreeResources({ ...rules, worktree: resourceRoot });
    const executables = new ExecutableCustody(
      join(input.stateRoot, 'evaluations', binding.evaluationId, 'executables'),
    );
    const construction = new DockerTaskArtifactConstruction({
      source: input.source,
      executables,
      profile: input.profile,
      image: input.image,
      recipeSaid: verifier.reviewedRecipeSaid,
      toolchainSaid: verifier.toolchainSaid,
      artifacts: evidence.rawArtifacts,
    });
    const observation = new DockerReceiptObservation({
      executables,
      profile: input.profile,
      image: input.image,
      artifacts: evidence.rawArtifacts,
      protectedCases: input.custody,
    });
    const pendingGradingMeasurements: FinalizationNativeMeasurement[] = [];
    const recordGrading = async (receipt: FinalizationNativeMeasurement) => {
      await capturePending();
      const cleanup = await reading.openPublic({
        evaluationId: binding.evaluationId,
        artifactSaid: receipt.cleanupReceiptSaid,
      });
      if (cleanup.kind !== 'Opened') return false;
      if (receipt.operation !== 'ProtectedObservation') {
        const raw = await reading.openPublic({
          evaluationId: binding.evaluationId,
          artifactSaid: receipt.rawReceiptSaid,
        });
        if (raw.kind !== 'Opened') return false;
        await capture(raw);
      }
      const source = await capture(cleanup);
      const bytes = Buffer.from(JSON.stringify(receipt));
      const prepared = prepareEvidenceArtifact(bytes, 'application/json');
      if (prepared.kind !== 'Prepared') return false;
      await capture({ artifact: prepared.artifact, bytes });
      const prior = (await readPrefix()).events
        .filter(
          (event) =>
            event.detail.kind === 'EvaluationBudgetDebited' &&
            event.detail.budget === 'aggregateChildCommandTimeSeconds',
        )
        .at(-1);
      if (prior !== undefined && prior.detail.kind !== 'EvaluationBudgetDebited') return false;
      await append({
        kind: 'EvaluationBudgetDebited',
        budget: 'aggregateChildCommandTimeSeconds',
        amount: receipt.childCommandDebitedSeconds,
        consumed:
          (prior?.detail.kind === 'EvaluationBudgetDebited' ? prior.detail.consumed : 0) +
          receipt.childCommandDebitedSeconds,
        receiptArtifactSaid: prepared.artifact.d,
        sourceEventSaid: source.d,
      });
      return true;
    };
    const grading = new FinalizationNativeGrading({
      maximumSeconds: manifest.allocation.finalization.aggregateChildCommandTimeSeconds,
      construction,
      observation,
      nowMicroseconds: () => Math.floor(performance.now() * 1000),
      record: async (receipt) => {
        // The stopped trial prefix permits only public captures before ciphertext ACK.
        // Retain every native receipt immediately and charge the in-memory F allowance,
        // but append grading debits only after that exact protected acknowledgement.
        const stored = await evidence.rawArtifacts.record({
          bytes: Buffer.from(JSON.stringify(receipt)),
          mediaType: 'application/json',
        });
        if (stored.kind !== 'Stored') return false;
        pendingGradingMeasurements.push(receipt);
        return true;
      },
    });
    const protectedArtifacts = new HostedEvaluationProtectedArtifacts(hosted, input.cases, outbox);
    const lock = new HostedEvaluationManifestLock(hosted, evidence.rawArtifacts);
    const observed: {
      slot: ComparisonSlot;
      public: Public;
      input: ProtectedTrialInput;
      execution: DockerContainedTrialExecution;
    }[] = [];
    const records: Extract<
      Awaited<ReturnType<typeof prepareMeasuredTrialObservation>>,
      { kind: 'Prepared' }
    >[] = [];
    const grade = async (item: (typeof observed)[number]) => {
      activeBinding = phaseBinding(item.slot);
      if (!(await refresh()) || lease === undefined) throw new Error('LeaseLost');
      const opened = head();
      const actual = {
        ...item.input,
        lease,
        leaseRequestStartedAt: requestStartedAt,
        now: Date.now(),
        publicObservation: item.public,
        expectedHeadSaid: opened.headSaid,
      };
      const retained = await gradePublicTrialArtifact(actual, {
        lock,
        cases: input.cases,
        oracle: input.oracle,
        execution: item.execution,
        construction: grading,
        observation: grading,
        custody: input.custody,
        protectedArtifacts: {
          retain: async (request) => {
            if (!(await refresh()) || lease === undefined) return { kind: 'LeaseLost' };
            return protectedArtifacts.retain({ ...request, lease });
          },
        },
      });
      if (retained.kind !== 'Retained') throw new Error(`ProtectedGrading:${retained.frontier}`);
      for (const measurement of pendingGradingMeasurements.splice(0)) {
        if (!(await recordGrading(measurement))) throw new Error('ProtectedGradingAccounting');
      }
      await capturePending();
      await operation(item.slot.arm, opened, {
        kind: 'ProtectedGrading',
        slot: item.slot,
        taskArtifactSaid: retained.frozenArtifact.executableSaid,
        buildReceiptSaid: retained.frozenArtifact.buildReceiptSaid,
        buildCleanupReceiptSaid: retained.frozenArtifact.cleanupReceiptSaid,
        publicCleanupReceiptSaids: retained.publicCases.map((item) => item.cleanupReceiptSaid),
        protectedObservationSaid: retained.protectedObservationSaid,
        cleanupReceiptSaid: retained.protectedCleanupReceiptSaid,
      });
      const prepared = await prepareMeasuredTrialObservation(
        { binding: activeBinding, manifest, verifier, retained },
        { measure: (request) => measure.measure(request) },
      );
      if (prepared.kind !== 'Prepared') throw new Error(`TrialMeasurement:${prepared.reason}`);
      await capture(prepared);
      records.push(prepared);
    };
    for (const slot of comparisonSlots()) {
      signal.throwIfAborted();
      activeBinding = phaseBinding(slot);
      if (!(await refresh())) throw new Error('LeaseLost');
      const opened = head();
      const prefix = await readPrefix();
      const consumed = {
        providerRequests: 0,
        providerInputTokens: 0,
        providerOutputTokens: 0,
        providerSpendMicroUsd: 0,
        runWallTimeSeconds: 0,
        toolProposals: 0,
        aggregateChildCommandTimeSeconds: 0,
        changedFiles: 0,
        changedWorktreeBytes: 0,
      };
      for (const event of prefix.events)
        if (event.detail.kind === 'EvaluationBudgetDebited')
          consumed[event.detail.budget] = event.detail.consumed;
      const capacity = new AcceptedProposalCapacity({ manifest, accepted });
      const authority = {
        manifest,
        activeTools: input.baseline.activeTools.map((tool) => ({
          name: tool.identity as ToolName,
          requiredCapability: tool.requiredCapability,
        })),
        resources,
        mandate: input.mandate,
        lease: leaseInspection,
        capacity,
      };
      const allowance = await SqliteEvaluationProviderAllowance.open(
        input.stateRoot,
        activeBinding,
        new HostedEvaluationProviderCustody({
          http: hosted,
          reading,
          ownerAid: manifest.ownerAid,
          admittedCommandId: input.admittedCommandId,
          manifest,
        }),
      );
      if (allowance.kind !== 'Opened') throw new Error('ProviderAllowance');
      const inference = new ParentConcentrateEvaluationInference({
        profile: input.profile,
        opened: input.openedModel,
        lease: leaseInspection,
        allowance: allowance.allowance,
      });
      const budget = { ...manifest.allocation.perEntry };
      if (slot.arm === 'H1TaskSearch')
        for (const dimension of evaluationConsumables)
          budget[dimension] = Math.floor(budget[dimension] / 2);
      const execution = new DockerContainedTrialExecution({
        profile: input.profile,
        image: input.image,
        model: input.openedModel.model,
        modelProfileSaid: input.profile.d,
        systemPrompt: input.systemPrompt,
        prompt: input.prompt,
        ...(slot.arm === 'C1' ? { c1Treatment: input.candidates.C1 } : {}),
        ...(slot.arm === 'C2'
          ? {
              c2Workflow: {
                ...input.candidates.C2,
                submission: new ProvisionalSubmissionAuthorization(authority),
                verification: new C2OriginalPublicVerification({
                  cases: input.cases,
                  oracle: input.oracle,
                  construction,
                  observation,
                }),
              },
            }
          : {}),
        ...(slot.arm === 'C3' ? { c3Selection: input.candidates.C3 } : {}),
        enabledTools: input.baseline.activeTools.map((tool) => tool.identity as ToolName),
        maximumPrompts: budget.providerRequests,
        workerMounts: input.workerMounts,
        workerProgram: input.workerProgram,
        source: input.source,
        modelInference: inference,
        rawArtifacts: evidence.rawArtifacts,
        evidence,
        cursor: { nextSequence: opened.sequence + 1, previousEventSaid: opened.headSaid, consumed },
        gatewayFor: (worker) =>
          new AuthorizedEvaluationTools({
            ...authority,
            effects: new DockerEvaluationToolEffects({
              worker,
              profile: input.profile,
              image: input.image,
              source: input.source,
              cleanSourceSaid: input.cleanSourceSaid,
              resources,
              resourceRules: rules,
              budget,
              artifacts: evidence.rawArtifacts,
              credentials: input.credentials,
              manifest,
              verifier,
              construction,
              observation,
            }),
            now: Date.now,
          }),
        now: () => new Date().toISOString(),
      });
      const trialInput: ProtectedTrialInput = {
        manifest,
        binding: activeBinding,
        lease,
        leaseRequestStartedAt: requestStartedAt,
        now: Date.now(),
        cleanSourceSaid: input.cleanSourceSaid,
        reviewedBehaviorSaid: activeBinding.harnessRevisionSaid,
        modelProfileSaid: input.profile.d,
        containerProfileSaid: input.profile.d,
        signal,
      };
      const publicObserved = await observePublicTrialArtifact(trialInput, {
        lock,
        cases: input.cases,
        oracle: input.oracle,
        execution,
        construction: grading,
        observation: grading,
        custody: input.custody,
        protectedArtifacts,
      });
      allowance.allowance.close();
      if (publicObserved.kind !== 'PublicObserved')
        throw new Error(`Trial:${publicObserved.frontier}`);
      await capturePending();
      await operation(slot.arm, opened, {
        kind: 'TrialExecution',
        slot,
        sourceSaid: publicObserved.capturedSourceSaid,
        trialStoppedEventSaid: publicObserved.trialEvidenceHeadSaid,
        cleanupReceiptSaid: publicObserved.trialCleanupReceiptSaid,
      });
      const item = { slot, public: publicObserved, input: trialInput, execution };
      observed.push(item);
      if (slot.arm !== 'H1TaskSearch') await grade(item);
      else if (slot.attempt === 2) {
        const first = observed.at(-2);
        if (first === undefined || first.slot.arm !== 'H1TaskSearch')
          throw new Error('SearchSchedule');
        const selected = selectTaskSearchArtifact(manifest.publicConditionIds, [
          {
            artifactSaid: first.public.frozenArtifact.executableSaid,
            acceptedConditionIds: first.public.publicCases
              .filter((item) => item.verdict === 'Pass')
              .map((item) => item.id),
          },
          {
            artifactSaid: item.public.frozenArtifact.executableSaid,
            acceptedConditionIds: item.public.publicCases
              .filter((item) => item.verdict === 'Pass')
              .map((item) => item.id),
          },
        ]);
        if (selected.kind !== 'Selected') throw new Error('PublicSelection');
        const selectionHead = head();
        await operation('H1TaskSearch', selectionHead, {
          kind: 'PublicSearchSelection',
          repetition: slot.repetition,
          firstArtifactSaid: first.public.frozenArtifact.executableSaid,
          secondArtifactSaid: item.public.frozenArtifact.executableSaid,
          selectedArtifactSaid: selected.artifactSaid,
        });
        await grade(first);
        await grade(item);
      }
    }
    const measurementStart = head();
    const prepared = prepareComparisonMeasurements({ manifest, verifier, observations: records });
    if (prepared.kind !== 'Prepared') throw new Error(`Comparison:${prepared.reason}`);
    for (const raw of prepared.measurements) await capture(raw);
    await operation('Shared', measurementStart, {
      kind: 'MeasurementDerivation',
      observationArtifactSaids: records.map((item) => item.artifact.d),
      measurementArtifactSaids: prepared.measurements.map((item) => item.artifact.d),
    });
    const recordingEnd = head();
    const recordingPrefix = await readPrefix();
    const recordingPrevious = recordingPrefix.events[recordingEnd.sequence]?.previous;
    const previousBatch = outbox.following(
      recordingPrevious?.kind === 'Previous' ? recordingPrevious.eventSaid : null,
    );
    if (previousBatch.kind !== 'Found' || previousBatch.acknowledgement === null)
      throw new Error('RecordingAcknowledgement');
    const predecessor = previousBatch.upload.events[0]?.previous;
    if (predecessor?.kind !== 'Previous') throw new Error('RecordingAnchor');
    await operation(
      'Shared',
      {
        sequence: previousBatch.upload.batch.startingSequence - 1,
        headSaid: predecessor.eventSaid,
      },
      {
        kind: 'EvidenceRecording',
        batchSaid: previousBatch.upload.batch.d,
        acceptedThroughSequence: previousBatch.acknowledgement.acceptedThroughSequence,
        chainHeadSaid: previousBatch.acknowledgement.chainHeadSaid,
      },
    );
    const propagationStart = head();
    const propagated = await readPrefix();
    const allArtifacts = [
      ...records.map((item) => item.artifact.d),
      ...prepared.measurements.map((item) => item.artifact.d),
    ];
    for (const artifactSaid of allArtifacts)
      if (
        (await reading.openPublic({ evaluationId: binding.evaluationId, artifactSaid })).kind !==
        'Opened'
      )
        throw new Error('EvidencePropagation');
    await operation('Shared', propagationStart, {
      kind: 'EvidencePropagation',
      throughSequence: propagated.throughSequence,
      headSaid: propagated.headSaid,
      artifactSaids: allArtifacts,
    });
    const prefix = await readPrefix();
    const audits = await prepareParentEvaluationAudit(
      {
        manifest,
        verifier,
        acceptedEvents: prefix.events,
        observationArtifactSaids: records.map((item) => item.artifact.d),
        measurementArtifactSaids: prepared.measurements.map((item) => item.artifact.d),
        operationArtifactSaids: operations,
      },
      {
        reading,
        regrading: {
          regrade: ({ manifest: m, trial }) =>
            regradeProtectedCesrObservation(
              { manifest: m, verifier, trial },
              { custody: input.custody, ciphertext: outbox },
            ),
        },
        usage: {
          remeasure: async (trial) => {
            const custodyEvent = prefix.events.find(
              (event) =>
                event.detail.kind === 'ArtifactCaptured' &&
                event.detail.custody === 'ProtectedCiphertext' &&
                event.detail.artifactSaid === trial.protectedObservationSaid,
            );
            if (custodyEvent === undefined) return { kind: 'Incomplete' };
            const replayed = await measure.measure({
              binding: phaseBinding(trial.observation.slot),
              trialEvidenceHeadSaid: trial.trialEvidenceHeadSaid,
              providerUsageEventSaids: trial.providerUsageEventSaids,
              protectedObservationSaid: trial.protectedObservationSaid,
              custodyEvidenceHeadSaid: custodyEvent.d,
              custodyEvidenceSequence: custodyEvent.sequence,
            });
            return replayed.kind === 'Verified'
              ? { kind: 'Verified', usage: replayed.usage }
              : { kind: 'Incomplete' };
          },
        },
      },
    );
    if (audits.kind !== 'Prepared') throw new Error('TamperAudit');
    for (const raw of audits.artifacts) await capture(raw);
    const finalizationAnchor = head();
    const beforeFinalization = await readPrefix();
    const codingWall = beforeFinalization.events.filter(
      (event) =>
        event.phase.kind === 'Trial' &&
        event.detail.kind === 'EvaluationBudgetDebited' &&
        event.detail.budget === 'runWallTimeSeconds',
    );
    const intervals: CodingElapsedInterval[] = [];
    for (const event of codingWall) {
      if (event.detail.kind !== 'EvaluationBudgetDebited') throw new Error('FinalizationIntervals');
      const raw = await reading.openPublic({
        evaluationId: binding.evaluationId,
        artifactSaid: event.detail.receiptArtifactSaid,
      });
      if (raw.kind !== 'Opened') throw new Error('FinalizationIntervals');
      const value: unknown = JSON.parse(Buffer.from(raw.bytes).toString('utf8'));
      if (
        typeof value !== 'object' ||
        value === null ||
        !('kind' in value) ||
        value.kind !== 'EvaluationWallElapsed' ||
        !('startedMonotonicMicroseconds' in value) ||
        typeof value.startedMonotonicMicroseconds !== 'number' ||
        !('finishedMonotonicMicroseconds' in value) ||
        typeof value.finishedMonotonicMicroseconds !== 'number'
      )
        throw new Error('FinalizationIntervals');
      intervals.push({
        artifactSaid: raw.artifact.d,
        startedMonotonicMicroseconds: value.startedMonotonicMicroseconds,
        finishedMonotonicMicroseconds: value.finishedMonotonicMicroseconds,
      });
    }
    const comparisonFinished = Math.floor(performance.now() * 1000);
    const elapsed = measureFinalizationElapsed(comparisonStarted, comparisonFinished, intervals);
    if (elapsed.kind !== 'Measured') throw new Error('FinalizationIntervals');
    const finalizationSeconds = Math.max(1, Math.ceil(elapsed.elapsedMilliseconds / 1000));
    if (finalizationSeconds > manifest.allocation.finalization.runWallTimeSeconds)
      throw new Error('FinalizationBudget');
    const finalizationDeadlineMilliseconds =
      comparisonFinished / 1000 +
      manifest.allocation.finalization.runWallTimeSeconds * 1000 -
      elapsed.elapsedMilliseconds;
    const withinFinalization = <T>(effect: () => Promise<T>) =>
      withinFinalizationWall(finalizationDeadlineMilliseconds, effect);
    const finalizationRaw = await withinFinalization(() =>
      evidence.rawArtifacts.record({
        mediaType: 'application/json',
        bytes: Buffer.from(
          JSON.stringify({
            version: 1,
            kind: 'EvaluationFinalizationElapsed',
            ...(input.researchPreparation === undefined
              ? {}
              : { researchPreparationReceiptSaid: input.researchPreparation.receiptArtifactSaid }),
            method: 'ParentMonotonicComparisonLessCodingIntervals',
            startedMonotonicMicroseconds: comparisonStarted,
            finishedMonotonicMicroseconds: comparisonFinished,
            codingWallReceiptSaids: intervals.map((item) => item.artifactSaid),
            elapsedMilliseconds: elapsed.elapsedMilliseconds,
            debitedSeconds: finalizationSeconds,
            throughSequence: finalizationAnchor.sequence,
            throughHeadSaid: finalizationAnchor.headSaid,
          }),
        ),
      }),
    );
    if (finalizationRaw.kind !== 'Stored') throw new Error('FinalizationReceipt');
    await withinFinalization(() =>
      append({
        kind: 'ArtifactCaptured',
        artifactSaid: finalizationRaw.artifact.d,
        custody: 'Public',
      }),
    );
    const priorWall = [...beforeFinalization.events]
      .reverse()
      .find(
        (event) =>
          event.detail.kind === 'EvaluationBudgetDebited' &&
          event.detail.budget === 'runWallTimeSeconds',
      );
    if (priorWall?.detail.kind !== 'EvaluationBudgetDebited')
      throw new Error('FinalizationReceipt');
    const priorWallConsumed = priorWall.detail.consumed;
    await withinFinalization(() =>
      append({
        kind: 'EvaluationBudgetDebited',
        budget: 'runWallTimeSeconds',
        amount: finalizationSeconds,
        consumed: priorWallConsumed + finalizationSeconds,
        receiptArtifactSaid: finalizationRaw.artifact.d,
        sourceEventSaid: finalizationAnchor.headSaid,
      }),
    );
    const coveredPrefix = await withinFinalization(readPrefix);
    const reserved = { ...manifest.allocation.diagnosis };
    for (const dimension of evaluationConsumables)
      reserved[dimension] +=
        15 * manifest.allocation.perEntry[dimension] + manifest.allocation.finalization[dimension];
    const coverage = await withinFinalization(() =>
      prepareEvaluationBudgetCoverage(
        { binding: activeBinding, reserved, occurredAt: new Date().toISOString() },
        { accepted, receipts },
      ),
    );
    if (coverage.kind !== 'Prepared' || coverage.event.detail.kind !== 'EvaluationBudgetCovered')
      throw new Error('BudgetCoverage');
    if ((await withinFinalization(() => evidence.record(coverage.event))).kind !== 'Recorded')
      throw new Error('BudgetAcknowledgement');
    if (!(await withinFinalization(refresh))) throw new Error('LeaseLost');
    clearInterval(pulse);
    if (refreshing !== undefined)
      await withinFinalization(() => refreshing ?? Promise.resolve(false));
    const index = prepareEvaluationClosureEvidenceIndex({
      version: 1,
      kind: 'EvaluationClosureEvidenceIndex',
      evaluationId: binding.evaluationId,
      manifestSaid: manifest.d,
      sourceInventorySaid: manifest.sourceInventorySaid,
      hypothesisSaid: manifest.hypothesisSaid,
      lease: { leaseId: lease.leaseId, version: lease.version },
      observations: records.map((item) => ({
        slot: item.evidence.observation.slot,
        artifactSaid: item.artifact.d,
      })),
      measurements: prepared.measurements.map((item) => ({
        slot: item.evidence.measurement.slot,
        artifactSaid: item.artifact.d,
      })),
      audits: audits.audits,
      budget: {
        coverageEventSaid: coverage.event.d,
        totals: coverage.event.detail.totals,
        anchors: Object.keys(coverage.event.detail.totals).map((dimension) => {
          const last = [...coveredPrefix.events]
            .reverse()
            .find(
              (event) =>
                event.detail.kind === 'EvaluationBudgetDebited' &&
                event.detail.budget === dimension,
            );
          if (
            last?.detail.kind !== 'EvaluationBudgetDebited' ||
            last.detail.sourceEventSaid === undefined
          )
            throw new Error('BudgetAnchor');
          return {
            dimension,
            finalDebitEventSaid: last.d,
            receiptArtifactSaid: last.detail.receiptArtifactSaid,
            sourceEventSaid: last.detail.sourceEventSaid,
          };
        }),
      },
    });
    if (index.kind !== 'Prepared') throw new Error(`ClosureIndex:${index.reason}`);
    const finalHead = head();
    const shared = audits.audits.find((item) => item.scope === 'Shared');
    const auditSaid = (arm: 'H1' | 'C1' | 'C2' | 'C3' | 'H1TaskSearch') => {
      const found = audits.audits.find((item) => item.scope === arm);
      if (found === undefined) throw new Error('AuditScope');
      return found.assessmentArtifactSaid;
    };
    const last = records.at(-1);
    if (shared === undefined || last === undefined) throw new Error('ClosureSet');
    const claim: EvaluationClosureSealClaim = {
      evaluationId: binding.evaluationId,
      evidenceStreamId: binding.evidenceStreamId,
      originRunId: binding.originRunId,
      manifestSaid: manifest.d,
      evidenceIndexSaid: index.artifact.d,
      acceptedEventCount: finalHead.sequence + 1,
      acceptedHeadSaid: finalHead.headSaid,
      observationSaids: records.map((item) => item.artifact.d),
      measurementSaids: prepared.measurements.map((item) => item.artifact.d),
      sharedAuditSaid: shared.assessmentArtifactSaid,
      armAuditSaids: {
        H1: auditSaid('H1'),
        C1: auditSaid('C1'),
        C2: auditSaid('C2'),
        C3: auditSaid('C3'),
        H1TaskSearch: auditSaid('H1TaskSearch'),
      },
      protectedCustodySaid: last.evidence.protectedObservationSaid,
    };
    const signing = {
      senderAlias: input.signing.senderAlias,
      sourceAid: input.signing.sourceAid,
      recipientAid: input.signing.recipientAid,
      payload: { version: 1 as const, kind: 'EvaluationClosureSeal' as const, claim },
      preparedAt: Date.now(),
    };
    const signed = await withinFinalization(() => input.signing.exchange.prepare(signing));
    await withinFinalization(() => input.signing.exchange.deliver({ ...signing, ...signed }));
    const closed = prepareEvaluationClosure({ ...claim, agentSealSaid: signed.exchangeSaid });
    if (closed.kind !== 'Prepared') throw new Error('ClosureSeal');
    const position = await withinFinalization(() => hosted.readPosition(binding.evaluationId));
    if (position.kind !== 'Read') throw new Error('ClosureVersion');
    const command = {
      version: 1 as const,
      commandId: randomUUID(),
      fingerprint: fingerprint(closed.closure),
      expectedEvaluationVersion: position.position.version,
      closure: closed.closure,
      evidenceIndex: {
        artifact: index.artifact,
        bytesBase64Url: Buffer.from(index.bytes).toString('base64url'),
      },
    };
    const staged = await withinFinalization(() =>
      new PromotionEvidenceFile(join(input.stateRoot, 'promotion-evidence')).stageClosure(command),
    );
    if (staged !== 'Staged') throw new Error('ClosureCustody');
    const commandBytes = Buffer.from(JSON.stringify(command));
    const commandArtifact = prepareEvidenceArtifact(commandBytes, 'application/json');
    if (
      commandArtifact.kind !== 'Prepared' ||
      outbox.retainPublicArtifact({ artifact: commandArtifact.artifact, bytes: commandBytes })
        .kind !== 'Stored'
    )
      throw new Error('ClosureCommandCustody');
    const delivered = await withinFinalization(() =>
      hosted.closeEvidence(
        command,
        AbortSignal.any([
          signal,
          AbortSignal.timeout(
            Math.max(0, Math.ceil(finalizationDeadlineMilliseconds - performance.now())),
          ),
        ]),
      ),
    );
    return delivered.kind === 'Closed' || delivered.kind === 'AlreadyClosed'
      ? { kind: 'Closed', closureSaid: delivered.closureSaid }
      : { kind: 'Incomplete', frontier: `Closure:${delivered.kind}` };
  } catch (cause) {
    return {
      kind: 'Incomplete',
      frontier: cause instanceof Error ? cause.message : 'ComparisonUnavailable',
    };
  } finally {
    clearInterval(pulse);
    controller.abort();
    if (refreshing !== undefined) await refreshing.catch(() => false);
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
}

/** Closure authority remains bounded while slow control-plane effects finish. */
export async function withinFinalizationWall<T>(
  deadlineMilliseconds: number,
  effect: () => Promise<T>,
  now: () => number = () => performance.now(),
): Promise<T> {
  if (!Number.isFinite(deadlineMilliseconds) || now() >= deadlineMilliseconds)
    throw new Error('FinalizationBudget');
  const outcome = await effect();
  if (now() >= deadlineMilliseconds) throw new Error('FinalizationBudget');
  return outcome;
}

/** Retries only a previously sealed exact command; never starts a worker or requests inference. */
export async function retryRetainedComparisonClosure(input: {
  readonly stateRoot: string;
  readonly evaluationId: string;
  readonly manifestSaid: string;
  readonly artifacts: readonly {
    readonly artifact: EvidenceArtifact;
    readonly bytes: Uint8Array;
  }[];
  readonly hosted: Pick<ServerEvaluationHttp, 'closeEvidence'>;
  readonly signal: AbortSignal;
}): Promise<LockedComparisonOutcome | { readonly kind: 'Absent' }> {
  const commands = [];
  for (const raw of input.artifacts) {
    if (raw.artifact.mediaType !== 'application/json') continue;
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(raw.bytes).toString('utf8'));
    } catch {
      continue;
    }
    if (
      Value.Check(evaluationClosureCommandSchema, value) &&
      value.closure.evaluationId === input.evaluationId
    ) {
      if (value.closure.manifestSaid !== input.manifestSaid)
        return { kind: 'Incomplete', frontier: 'ClosureManifest' };
      commands.push(value);
    }
  }
  if (commands.length === 0) return { kind: 'Absent' };
  const command = commands[0];
  if (commands.length !== 1 || command === undefined)
    return { kind: 'Incomplete', frontier: 'ClosureConflict' };
  const custody = new PromotionEvidenceFile(join(input.stateRoot, 'promotion-evidence'));
  const staged = await custody.stageClosure(command);
  if (staged !== 'Staged') return { kind: 'Incomplete', frontier: 'ClosureCustody' };
  const delivered = await input.hosted.closeEvidence(command, input.signal);
  return delivered.kind === 'Closed' || delivered.kind === 'AlreadyClosed'
    ? { kind: 'Closed', closureSaid: delivered.closureSaid }
    : { kind: 'Incomplete', frontier: `Closure:${delivered.kind}` };
}
