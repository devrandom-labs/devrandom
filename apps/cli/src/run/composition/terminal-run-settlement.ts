import { TerminalSourceVerification } from '../application/terminal-source-verification.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareEvidenceArtifact, type EvidenceArtifactMediaType } from '@devrandom/protocol';
import {
  SourceCustody,
  ExecutableCustody,
  DockerTaskArtifactConstruction,
  DockerReceiptObservation,
  type EvaluationRawArtifacts,
} from '@devrandom/runtime';
import type { LinuxRunBinding } from './linux-run-supervisor.js';
import type { SuccessorRunSettlementProvision } from './baseline-run-supervisor.js';
import { TerminalRunSubmission } from '../application/terminal-run-submission.js';
import { RetainedRunSettlement } from '../application/retained-run-settlement.js';
import {
  PreparedCompatibilityClassifier,
  preparedCompatibilityVerifierReadOnlyPaths,
} from '../application/prepared-compatibility.js';
import { PreparedCompatibilityCalibration } from '../application/prepared-compatibility-calibration.js';
import { PreparedCompatibilityCalibrationFile } from '../infrastructure/prepared-compatibility-calibration-file.js';
import { GitWorktreeChanges } from '../infrastructure/git-worktree-changes.js';
import { EvaluationManifestCommandFile } from '../../harness/infrastructure/evaluation-manifest-command-file.js';
import { SqliteProtectedCaseKeyCustody } from '../../harness/infrastructure/sqlite-protected-case-key-custody.js';

export interface TerminalRunSettlementOptions {
  readonly stateRoot: string;
  readonly evaluationId: string;
  readonly expectedManifestSaid: string;
  readonly linux: LinuxRunBinding;
  now(): string;
}
const interrupted = (signal: AbortSignal) => signal.aborted;

/** Original public contract and the separately reserved terminal case verify the frozen retained H2 source. */
export class TerminalRunSettlementComposition implements SuccessorRunSettlementProvision {
  readonly #options: TerminalRunSettlementOptions;
  constructor(options: TerminalRunSettlementOptions) {
    this.#options = options;
  }
  provision(
    input: Parameters<SuccessorRunSettlementProvision['provision']>[0],
  ): ReturnType<SuccessorRunSettlementProvision['provision']> {
    const options = this.#options;
    const run = input.run;
    const task = input.preparation.task;
    const harness = input.preparation.harness.projection.revision;
    const directory = join(options.stateRoot, 'runs', run.binding.runId, 'terminal-verification');
    const source = new SourceCustody(join(directory, 'sources'), {
      maximumFiles: 512,
      maximumBytes: 8 * 1024 * 1024,
      maximumPathBytes: 1024,
    });
    const executables = new ExecutableCustody(join(directory, 'executables'));
    const store = (bytes: Uint8Array, mediaType: EvidenceArtifactMediaType): string | undefined => {
      const stored = input.evidence.storeArtifact({ bytes, mediaType });
      if (stored.kind !== 'Stored' && stored.kind !== 'AlreadyStored') return undefined;
      if (
        input.evidence.record({
          occurredAt: options.now(),
          producer: { kind: 'ProtectedTaskVerifier' },
          event: { kind: 'Observation', source: 'Verifier', artifactSaid: stored.artifact.d },
        }).kind !== 'Recorded'
      )
        return undefined;
      return stored.artifact.d;
    };
    const artifacts: EvaluationRawArtifacts = {
      record: ({ bytes, mediaType }) => {
        const said = store(bytes, mediaType);
        if (said === undefined) return Promise.resolve({ kind: 'Unavailable' });
        const prepared = prepareEvidenceArtifact(bytes, mediaType);
        return Promise.resolve(
          prepared.kind === 'Prepared'
            ? { kind: 'Stored', artifact: prepared.artifact }
            : { kind: 'Unavailable' },
        );
      },
    };
    const freeze = async (signal: AbortSignal) => {
      if (!input.sourceCustody.writersStopped() || interrupted(signal))
        return { kind: 'Rejected' as const };
      const repository = await new GitWorktreeChanges(
        input.preparation.protectedCredentials,
      ).capture(
        input.worktree,
        {
          changedFiles: run.binding.budget.changedFiles,
          changedWorktreeBytes: run.binding.budget.changedWorktreeBytes,
        },
        signal,
      );
      const protectedPaths = [
        ...task.revision.constraints.protectedPaths,
        ...preparedCompatibilityVerifierReadOnlyPaths(task),
      ];
      if (
        repository.kind !== 'Captured' ||
        repository.repository.changedFiles.some((file) =>
          protectedPaths.some((path) => file.path === path || file.path.startsWith(`${path}/`)),
        )
      )
        return { kind: 'Rejected' as const };
      const captured = await source.capture(input.worktree.directory, () =>
        Promise.resolve(!input.sourceCustody.writersStopped()),
      );
      if (captured.kind !== 'Captured' || interrupted(signal)) return { kind: 'Rejected' as const };
      const opened = await source.open(captured.sourceSaid);
      if (
        opened === undefined ||
        store(opened.manifestBytes, 'application/json') !== captured.sourceSaid
      )
        return { kind: 'Rejected' as const };
      for (const file of opened.files)
        if (store(file.bytes, 'application/octet-stream') === undefined)
          return { kind: 'Rejected' as const };
      return { kind: 'Frozen' as const, sourceSaid: captured.sourceSaid };
    };
    const submissions = new TerminalRunSubmission({
      source: {
        freeze,
        unchanged: async (sourceSaid, signal) => {
          if (interrupted(signal) || !input.sourceCustody.writersStopped()) return false;
          const captured = await source.capture(input.worktree.directory, () =>
            Promise.resolve(!input.sourceCustody.writersStopped()),
          );
          return captured.kind === 'Captured' && captured.sourceSaid === sourceSaid;
        },
      },
      publicVerification: input.verification,
      terminalVerification: new TerminalSourceVerification({
        run,
        expectedManifestSaid: options.expectedManifestSaid,
        profileSaid: options.linux.profile.d,
        wallTimeSeconds: options.linux.profile.limits.wallTimeSeconds,
        budget: input.budget,
        artifacts,
        monotonicNow: () => performance.now(),
        custody: {
          acquire: async () => {
            const staged = await new EvaluationManifestCommandFile(
              join(options.stateRoot, 'evaluation-manifests'),
              randomUUID,
            ).inspect(options.evaluationId);
            if (
              staged.kind !== 'Staged' ||
              staged.command.manifest.d !== options.expectedManifestSaid
            )
              return { kind: 'Unavailable' };
            const key = SqliteProtectedCaseKeyCustody.reopen(options.stateRoot, {
              ownerAid: run.binding.ownerAid,
              evaluationId: options.evaluationId,
              personalAgentAid: run.binding.personalAgentAid,
              taskId: task.taskId,
              taskMandateSaid: run.binding.taskMandateSaid,
            });
            if (key.kind !== 'Opened') return { kind: 'Unavailable' };
            const bundle = staged.command.verifierBundle;
            return {
              kind: 'Acquired',
              manifest: staged.command.manifest,
              bundle,
              cases: key.custody,
              construction: new DockerTaskArtifactConstruction({
                source,
                executables,
                profile: options.linux.profile,
                image: options.linux.image,
                recipeSaid: bundle.reviewedRecipeSaid,
                toolchainSaid: bundle.toolchainSaid,
                artifacts,
              }),
              observation: new DockerReceiptObservation({
                executables,
                profile: options.linux.profile,
                image: options.linux.image,
                artifacts,
                protectedCases: key.custody,
              }),
              close: () => {
                key.custody.close();
              },
            };
          },
        },
      }),
    });
    return {
      submissions,
      settlement: new RetainedRunSettlement({
        task,
        harness,
        evidence: input.evidence,
        custody: submissions,
        verification: input.verification,
        compatibility: new PreparedCompatibilityClassifier(),
        calibration: new PreparedCompatibilityCalibration(
          new PreparedCompatibilityCalibrationFile(
            join(options.stateRoot, 'calibration', task.taskId, harness.d),
          ),
        ),
        checkpointing: input.checkpointing,
        sealing: input.sealing,
        now: () => options.now(),
      }),
    };
  }
}
