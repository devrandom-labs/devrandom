import { validateExecutionBinding } from '@devrandom/domain';
import {
  bindEvaluationVerifierBundle,
  decodeEvaluationManifest,
  decodeEvaluationVerifierBundleBytes,
  prepareEvidenceArtifact,
} from '@devrandom/protocol';

import type { C2StoppedSubmissionVerification } from './c2-workflow-transition.js';
import type { ReceiptObservation, TaskArtifactConstruction } from './evaluation-conversations.js';
import {
  observedPublicCase,
  type EvaluationCaseInventory,
  type ReviewedReceiptOracle,
} from './observe-protected-trial-artifact.js';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const interrupted = (signal: AbortSignal): boolean => signal.aborted;

export interface C2OriginalPublicVerificationDependencies {
  readonly cases: EvaluationCaseInventory;
  readonly oracle: ReviewedReceiptOracle;
  readonly construction: TaskArtifactConstruction;
  readonly observation: ReceiptObservation;
}

/** The trusted parent reruns the original public verifier against frozen source.
 * Protected stimuli and oracle feedback never enter this conversation. */
export class C2OriginalPublicVerification implements C2StoppedSubmissionVerification {
  readonly #dependencies: C2OriginalPublicVerificationDependencies;

  constructor(dependencies: C2OriginalPublicVerificationDependencies) {
    this.#dependencies = dependencies;
  }

  async verify(
    input: Parameters<C2StoppedSubmissionVerification['verify']>[0],
  ): ReturnType<C2StoppedSubmissionVerification['verify']> {
    const phase = input.binding.phase;
    if (
      input.signal.aborted ||
      validateExecutionBinding(input.binding).kind !== 'Accepted' ||
      decodeEvaluationManifest(input.manifest).kind !== 'Accepted' ||
      phase.kind !== 'Trial' ||
      phase.manifestSaid !== input.manifest.d ||
      phase.arm !== 'C2' ||
      input.slot.arm !== 'C2' ||
      phase.repetition !== input.slot.repetition ||
      phase.attempt !== input.slot.attempt ||
      input.binding.evaluationId !== input.manifest.evaluationId ||
      input.binding.taskId !== input.manifest.taskId ||
      input.binding.taskRevisionSaid !== input.manifest.taskRevisionSaid ||
      input.binding.originRunId !== input.manifest.originRunId ||
      input.binding.personalAgentAid !== input.manifest.personalAgentAid ||
      input.binding.taskMandateSaid !== input.manifest.taskMandateSaid ||
      input.binding.harnessRevisionSaid !== input.successorRevisionSaid ||
      input.manifest.revisions.C2 !== input.successorRevisionSaid ||
      !said.test(input.proposalEventSaid) ||
      !said.test(input.capturedSourceSaid) ||
      input.proposedArtifactSaids.some((artifact) => !said.test(artifact))
    )
      return { kind: 'Unavailable' };
    try {
      const opened = await this.#dependencies.cases.open(input.manifest);
      if (opened.kind !== 'Opened') return { kind: 'Unavailable' };
      const decoded = decodeEvaluationVerifierBundleBytes(opened.bytes);
      if (
        decoded.kind !== 'Accepted' ||
        bindEvaluationVerifierBundle(decoded.bundle, input.manifest).kind !== 'Bound'
      )
        return { kind: 'Unavailable' };
      const bundle = decoded.bundle;
      const oracle = await this.#dependencies.oracle.inspect();
      if (oracle.kind !== 'Reviewed' || oracle.digest !== bundle.oracleAdapterDigest)
        return { kind: 'Unavailable' };
      const built = await this.#dependencies.construction.build({
        capturedSourceSaid: input.capturedSourceSaid,
        reviewedRecipeSaid: bundle.reviewedRecipeSaid,
        toolchainSaid: bundle.toolchainSaid,
        containerProfileSaid: input.manifest.executionProfileSaid,
        signal: input.signal,
      });
      if (built.kind === 'Invalid') return { kind: 'Unavailable' };
      if (
        !said.test(built.buildReceiptSaid) ||
        !said.test(built.cleanupReceiptSaid) ||
        (built.kind === 'Frozen' &&
          (built.sourceSaid !== input.capturedSourceSaid || !said.test(built.executableSaid)))
      )
        return { kind: 'Unavailable' };
      const observations: {
        readonly conditionId: string;
        readonly verdict: 'Pass' | 'Fail';
        readonly rawObservationSaid: string;
        readonly cleanupReceiptSaid: string;
      }[] = [];
      if (built.kind === 'Frozen') {
        for (const condition of bundle.publicConditions) {
          if (interrupted(input.signal)) return { kind: 'Unavailable' };
          const stimulus = Buffer.from(condition.stimulusBase64Url, 'base64url');
          const stimulusArtifact = prepareEvidenceArtifact(stimulus, 'text/plain; charset=utf-8');
          if (stimulusArtifact.kind !== 'Prepared') return { kind: 'Unavailable' };
          const observed = await this.#dependencies.observation.observe({
            executableSaid: built.executableSaid,
            stimulus,
            stimulusSaid: stimulusArtifact.artifact.d,
            caseScope: 'Public',
            signal: input.signal,
          });
          if (
            observed.kind !== 'Observed' ||
            observed.executableSaid !== built.executableSaid ||
            observed.protectedObservation !== undefined ||
            !said.test(observed.rawObservationSaid) ||
            !said.test(observed.cleanupReceiptSaid)
          )
            return { kind: 'Unavailable' };
          const passed = observedPublicCase(condition.expected, observed.observation);
          if (passed === undefined) return { kind: 'Unavailable' };
          observations.push({
            conditionId: condition.id,
            verdict: passed ? 'Pass' : 'Fail',
            rawObservationSaid: observed.rawObservationSaid,
            cleanupReceiptSaid: observed.cleanupReceiptSaid,
          });
        }
      }
      if (interrupted(input.signal)) return { kind: 'Unavailable' };
      const decision =
        built.kind === 'Frozen' && observations.every((item) => item.verdict === 'Pass')
          ? 'Verified'
          : 'Failed';
      const receiptBytes = Buffer.from(
        JSON.stringify({
          version: 1,
          kind: 'C2OriginalPublicGate',
          decision,
          evaluationId: input.binding.evaluationId,
          manifestSaid: input.manifest.d,
          successorRevisionSaid: input.successorRevisionSaid,
          capturedSourceSaid: input.capturedSourceSaid,
          proposalEventSaid: input.proposalEventSaid,
          proposedArtifactSaids: input.proposedArtifactSaids,
          verifierBundleSaid: bundle.d,
          oracleAdapterDigest: bundle.oracleAdapterDigest,
          buildDisposition: built.kind,
          buildReceiptSaid: built.buildReceiptSaid,
          buildCleanupReceiptSaid: built.cleanupReceiptSaid,
          ...(built.kind === 'Frozen' ? { executableSaid: built.executableSaid } : {}),
          observations,
        }),
        'utf8',
      );
      const receipt = prepareEvidenceArtifact(receiptBytes, 'application/json');
      if (receipt.kind !== 'Prepared' || receiptBytes.byteLength > 64 * 1024)
        return { kind: 'Unavailable' };
      return {
        kind: decision,
        capturedSourceSaid: input.capturedSourceSaid,
        proposalEventSaid: input.proposalEventSaid,
        publicVerifierReceiptSaid: receipt.artifact.d,
        receiptBytes,
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
