import type { Run } from '@devrandom/domain';
import {
  bindEvaluationVerifierBundle,
  prepareEvidenceArtifact,
  type EvaluationManifest,
  type EvaluationVerifierBundle,
} from '@devrandom/protocol';
import {
  assessProtectedCesrCase,
  observedPublicCase,
  type EvaluationRawArtifacts,
  type ProtectedCaseCustody,
  type ReceiptObservation,
  type TaskArtifactConstruction,
  type RunResourceBudget,
} from '@devrandom/runtime';
import type { TerminalRunVerification } from './terminal-run-submission.js';

export interface CommittedTerminalCaseCustody {
  acquire(): Promise<
    | {
        readonly kind: 'Acquired';
        readonly manifest: EvaluationManifest;
        readonly bundle: EvaluationVerifierBundle;
        readonly construction: TaskArtifactConstruction;
        readonly observation: ReceiptObservation;
        readonly cases: ProtectedCaseCustody;
        close(): void;
      }
    | { readonly kind: 'Unavailable' }
  >;
}
export interface TerminalSourceVerificationDependencies {
  readonly run: Run;
  readonly expectedManifestSaid: string;
  readonly profileSaid: string;
  readonly wallTimeSeconds: number;
  readonly custody: CommittedTerminalCaseCustody;
  readonly artifacts: EvaluationRawArtifacts;
  readonly budget: RunResourceBudget;
  monotonicNow(): number;
}

/** Protected verifier owns exact-source native build, original API cases, and the reserved TerminalCase. */
export class TerminalSourceVerification implements TerminalRunVerification {
  readonly #dependencies: TerminalSourceVerificationDependencies;
  constructor(dependencies: TerminalSourceVerificationDependencies) {
    this.#dependencies = dependencies;
  }
  async assess(
    sourceSaid: string,
    signal: AbortSignal,
  ): ReturnType<TerminalRunVerification['assess']> {
    const dependencies = this.#dependencies;
    const run = dependencies.run;
    const acquired = await dependencies.custody.acquire();
    if (acquired.kind !== 'Acquired') return { kind: 'Unavailable' };
    try {
      const { manifest, bundle, construction, observation, cases } = acquired;
      if (
        run.lifecycle.kind !== 'Active' ||
        run.lifecycle.phase.kind !== 'Running' ||
        run.binding.purpose.kind !== 'Retained' ||
        run.currentExecution === undefined ||
        manifest.d !== dependencies.expectedManifestSaid ||
        manifest.originRunId !== run.binding.runId ||
        manifest.ownerAid !== run.binding.ownerAid ||
        manifest.taskId !== run.binding.taskId ||
        manifest.taskRevisionSaid !== run.binding.taskRevisionSaid ||
        manifest.personalAgentAid !== run.binding.personalAgentAid ||
        manifest.taskMandateSaid !== run.binding.taskMandateSaid ||
        manifest.revisions.H1 !== run.binding.initialHarnessRevisionSaid ||
        ![manifest.revisions.C1, manifest.revisions.C2, manifest.revisions.C3].includes(
          run.currentExecution.harnessRevisionSaid,
        ) ||
        manifest.executionProfileSaid !== dependencies.profileSaid ||
        bundle.executionProfileSaid !== dependencies.profileSaid ||
        bindEvaluationVerifierBundle(bundle, manifest).kind !== 'Bound' ||
        bundle.terminalCase.stimulus.purpose !== 'TerminalCase' ||
        bundle.terminalCase.stimulus.d !== manifest.finalCaseArtifactSaid
      )
        return { kind: 'Unavailable' };
      const built = await this.#native(
        (nativeSignal) =>
          construction.build({
            capturedSourceSaid: sourceSaid,
            reviewedRecipeSaid: bundle.reviewedRecipeSaid,
            toolchainSaid: bundle.toolchainSaid,
            containerProfileSaid: dependencies.profileSaid,
            signal: nativeSignal,
          }),
        signal,
      );
      if (built?.kind !== 'Frozen' || built.sourceSaid !== sourceSaid)
        return { kind: 'Unavailable' };
      const publicCases: {
        conditionId: string;
        verdict: 'Pass' | 'Fail';
        rawObservationSaid: string;
        cleanupReceiptSaid: string;
      }[] = [];
      for (const condition of bundle.publicConditions) {
        const stimulus = Buffer.from(condition.stimulusBase64Url, 'base64url');
        const stimulusArtifact = prepareEvidenceArtifact(stimulus, 'text/plain; charset=utf-8');
        if (stimulusArtifact.kind !== 'Prepared') return { kind: 'Unavailable' };
        const observed = await this.#native(
          (nativeSignal) =>
            observation.observe({
              executableSaid: built.executableSaid,
              stimulus,
              stimulusSaid: stimulusArtifact.artifact.d,
              caseScope: 'Public',
              signal: nativeSignal,
            }),
          signal,
        );
        if (
          observed?.kind !== 'Observed' ||
          observed.executableSaid !== built.executableSaid ||
          observed.protectedObservation !== undefined
        )
          return { kind: 'Unavailable' };
        const passed = observedPublicCase(condition.expected, observed.observation);
        if (passed === undefined) return { kind: 'Unavailable' };
        publicCases.push({
          conditionId: condition.id,
          verdict: passed ? 'Pass' : 'Fail',
          rawObservationSaid: observed.rawObservationSaid,
          cleanupReceiptSaid: observed.cleanupReceiptSaid,
        });
      }
      const terminal = await this.#native(
        (nativeSignal) =>
          assessProtectedCesrCase(
            {
              evaluationId: manifest.evaluationId,
              objectSaid: bundle.terminalCase.objectSaid,
              segment: bundle.terminalCase.stimulus.segment,
              executableSaid: built.executableSaid,
              stimulusArtifact: bundle.terminalCase.stimulus,
              expectedArtifact: bundle.terminalCase.expected,
              signal: nativeSignal,
            },
            cases,
            observation,
          ),
        signal,
      );
      if (terminal?.kind !== 'Assessed') return { kind: 'Unavailable' };
      const encrypted = await dependencies.artifacts.record({
        bytes: Buffer.from(JSON.stringify(terminal.observationArtifact), 'utf8'),
        mediaType: 'application/json',
      });
      if (encrypted.kind !== 'Stored') return { kind: 'Unavailable' };
      const verdict =
        terminal.verdict === 'Pass' &&
        publicCases.every((condition) => condition.verdict === 'Pass')
          ? ('Pass' as const)
          : ('Fail' as const);
      const receipt = await dependencies.artifacts.record({
        bytes: Buffer.from(
          JSON.stringify({
            version: 1,
            kind: 'RunTerminalVerification',
            runId: run.binding.runId,
            taskRevisionSaid: run.binding.taskRevisionSaid,
            harnessRevisionSaid: run.currentExecution.harnessRevisionSaid,
            segmentSaid: run.currentExecution.segmentSaid,
            evaluationId: manifest.evaluationId,
            manifestSaid: manifest.d,
            submittedSourceSaid: sourceSaid,
            verificationSourceSaid: built.sourceSaid,
            executableSaid: built.executableSaid,
            buildReceiptSaid: built.buildReceiptSaid,
            buildCleanupReceiptSaid: built.cleanupReceiptSaid,
            publicCases,
            terminalCaseArtifactSaid: manifest.finalCaseArtifactSaid,
            encryptedObservationSaid: encrypted.artifact.d,
            terminalCleanupReceiptSaid: terminal.cleanupReceiptSaid,
            terminalVerdict: terminal.verdict,
            verdict,
          }),
          'utf8',
        ),
        mediaType: 'application/json',
      });
      return receipt.kind === 'Stored'
        ? { kind: 'Assessed', verdict, receiptArtifactSaid: receipt.artifact.d }
        : { kind: 'Unavailable' };
    } catch {
      return { kind: 'Unavailable' };
    } finally {
      acquired.close();
    }
  }
  async #native<Value>(
    effect: (signal: AbortSignal) => Promise<Value>,
    signal: AbortSignal,
  ): Promise<Value | undefined> {
    const { wallTimeSeconds, budget } = this.#dependencies;
    const monotonicNow = () => this.#dependencies.monotonicNow();
    const reservation = budget.reserve([
      { budget: 'aggregateChildCommandTimeSeconds', amount: wallTimeSeconds + 2 },
      { budget: 'oneChildCommandTimeSeconds', amount: wallTimeSeconds },
    ]);
    if (reservation.kind !== 'Reserved') return undefined;
    const started = monotonicNow();
    let value: Value | undefined;
    try {
      value = await effect(AbortSignal.any([signal, AbortSignal.timeout(wallTimeSeconds * 1000)]));
    } finally {
      const committed = budget.commit(reservation.reservation, {
        producer: { kind: 'ProtectedTaskVerifier' },
        actual: [
          {
            budget: 'aggregateChildCommandTimeSeconds',
            amount: Math.ceil((monotonicNow() - started) / 1000),
          },
        ],
      });
      if (committed.kind !== 'Committed') value = undefined;
    }
    return value;
  }
}
