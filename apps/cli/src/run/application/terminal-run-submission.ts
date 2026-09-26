import type {
  SubmittedResultVerification,
  RetainedSubmittedVerification,
} from './public-task-verification.js';
import type {
  RunSubmissionVerification,
  SubmittedVerificationCustody,
  SubmittedVerificationTransfer,
} from './run-submissions.js';

export interface ImmutableRunSubmission {
  freeze(
    signal: AbortSignal,
  ): Promise<
    { readonly kind: 'Frozen'; readonly sourceSaid: string } | { readonly kind: 'Rejected' }
  >;
  unchanged(sourceSaid: string, signal: AbortSignal): Promise<boolean>;
}
export interface TerminalRunVerification {
  assess(
    sourceSaid: string,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly kind: 'Assessed';
        readonly verdict: 'Pass' | 'Fail';
        readonly receiptArtifactSaid: string;
      }
    | { readonly kind: 'Unavailable' }
  >;
}

/** One immutable submission and one terminal verdict; protected failure never re-enters coding. */
export interface TerminalRunSubmissionDependencies {
  readonly source: ImmutableRunSubmission;
  readonly publicVerification: SubmittedResultVerification;
  readonly terminalVerification: TerminalRunVerification;
}
export class TerminalRunSubmission
  implements RunSubmissionVerification, SubmittedVerificationCustody
{
  readonly #dependencies: TerminalRunSubmissionDependencies;
  #used = false;
  #transferred = false;
  #retained: RetainedSubmittedVerification | undefined;
  constructor(dependencies: TerminalRunSubmissionDependencies) {
    this.#dependencies = dependencies;
  }
  async verify(
    input: Parameters<RunSubmissionVerification['verify']>[0],
    signal: AbortSignal,
  ): ReturnType<RunSubmissionVerification['verify']> {
    if (this.#used || signal.aborted) return { kind: 'EvidenceIntegrityFailure' };
    this.#used = true;
    const frozen = await this.#dependencies.source.freeze(signal);
    if (frozen.kind !== 'Frozen') return { kind: 'EvidenceIntegrityFailure' };
    const publicProof = await this.#dependencies.publicVerification.verify(
      { artifactSaids: [...new Set([frozen.sourceSaid, ...input.artifactSaids])] },
      signal,
    );
    if (publicProof.kind !== 'Accepted') {
      if (publicProof.kind === 'Rejected' || publicProof.kind === 'Blocked')
        this.#retained = publicProof;
      return { kind: 'DependencyUnavailable' };
    }
    this.#retained = {
      kind: 'Blocked',
      reason: 'EffectAborted',
      receipts: publicProof.receipts,
      outputArtifactSaids: [...new Set([...publicProof.outputArtifactSaids, frozen.sourceSaid])],
    };
    if (!(await this.#dependencies.source.unchanged(frozen.sourceSaid, signal)))
      return { kind: 'EvidenceIntegrityFailure' };
    const terminal = await this.#dependencies.terminalVerification.assess(
      frozen.sourceSaid,
      signal,
    );
    if (terminal.kind !== 'Assessed') return { kind: 'DependencyUnavailable' };
    const outputArtifactSaids = [
      ...new Set([
        ...publicProof.outputArtifactSaids,
        frozen.sourceSaid,
        terminal.receiptArtifactSaid,
      ]),
    ];
    if (outputArtifactSaids.length > 64) return { kind: 'EvidenceIntegrityFailure' };
    if (terminal.verdict === 'Fail') {
      this.#retained = {
        kind: 'Blocked',
        reason: 'EffectAborted',
        receipts: publicProof.receipts,
        outputArtifactSaids,
      };
      return { kind: 'DependencyUnavailable' };
    }
    this.#retained = { kind: 'Accepted', receipts: publicProof.receipts, outputArtifactSaids };
    return this.#retained;
  }
  transferSubmittedVerification(): SubmittedVerificationTransfer {
    if (this.#transferred) return { kind: 'AlreadyTransferred' };
    this.#transferred = true;
    return this.#retained === undefined
      ? { kind: 'NoSubmission' }
      : { kind: 'Transferred', verification: this.#retained };
  }
}
