import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { ProtectedCredentials } from '@devrandom/domain';
import type {
  EvaluationExecutionProfile,
  EvaluationManifest,
  EvaluationVerifierBundle,
} from '@devrandom/protocol';
import {
  DockerEvaluationCompartment,
  type SourceCustody,
  measureEvaluationSourceChanges,
  observeContainedCommand,
  observePublicSourceArtifact,
  type AuthorizedToolEffect,
  type ToolEffects,
  type ToolEffectOutcome,
  type EvaluationRawArtifacts,
  type EvaluationRepositoryEffectReceipt,
  type TaskArtifactConstruction,
  type ReceiptObservation,
} from '@devrandom/runtime';
import {
  ManagedWorktreeResources,
  type ManagedWorktreeResourceOptions,
} from '../../run/infrastructure/managed-worktree-tools.js';

type Files = readonly { readonly path: string; readonly bytes: Uint8Array }[];
interface Options {
  readonly worker: DockerEvaluationCompartment;
  readonly profile: EvaluationExecutionProfile;
  readonly image: string;
  readonly source: SourceCustody;
  readonly cleanSourceSaid: string;
  readonly resources: ManagedWorktreeResources;
  readonly resourceRules: Omit<ManagedWorktreeResourceOptions, 'worktree'>;
  readonly budget: {
    readonly changedFiles: number;
    readonly changedWorktreeBytes: number;
    readonly aggregateChildCommandTimeSeconds: number;
  };
  readonly artifacts: EvaluationRawArtifacts;
  readonly credentials: ProtectedCredentials;
  readonly manifest: EvaluationManifest;
  readonly verifier: EvaluationVerifierBundle;
  readonly construction: TaskArtifactConstruction;
  readonly observation: ReceiptObservation;
}
const interrupted = (signal: AbortSignal) => signal.aborted;
/** Only parent file operations touch host snapshots. Repository executables run in
 * a separate disposable compartment with no worker relay, credentials, or network. */
export class DockerEvaluationToolEffects implements ToolEffects {
  readonly #options: Options;
  #commandMilliseconds = 0;
  constructor(options: Options) {
    this.#options = options;
  }
  async enact(effect: AuthorizedToolEffect, signal: AbortSignal): Promise<ToolEffectOutcome> {
    if (signal.aborted) return { kind: 'DependencyUnavailable' };
    const root = await mkdtemp(join(tmpdir(), 'devrandom-evaluation-effect-'));
    const path = join(root, 'source');
    const o = this.#options;
    let native: DockerEvaluationCompartment | undefined;
    try {
      await o.worker.copyDirectoryOut('/work/source', path);
      const before = await o.source.capture(path, () => Promise.resolve(false));
      if (before.kind !== 'Captured') return { kind: 'EvidenceIntegrityFailure' };
      const current = await o.source.open(before.sourceSaid);
      const clean = await o.source.open(o.cleanSourceSaid);
      if (current === undefined || clean === undefined) return { kind: 'EvidenceIntegrityFailure' };
      const previousChanges = measureEvaluationSourceChanges(clean.files, current.files);
      if (
        previousChanges === undefined ||
        previousChanges.paths.some(
          (file) =>
            o.resources.resolve({
              ...effect.proposal,
              input: { kind: 'WriteFile', path: file, content: '' },
            }).kind !== 'Resolved',
        )
      )
        return { kind: 'EvidenceIntegrityFailure' };
      const resources = new ManagedWorktreeResources({ ...o.resourceRules, worktree: path });
      const resolved = resources.resolve(effect.proposal);
      if (resolved.kind !== 'Resolved' || resolved.resource !== effect.resource)
        return { kind: 'EvidenceIntegrityFailure' };
      const input = effect.proposal.input;
      let after = before.sourceSaid;
      let summary = '';
      let success = true;
      let commandReceipt: EvaluationRepositoryEffectReceipt['command'];
      let publicConditions: EvaluationRepositoryEffectReceipt['publicConditions'];
      let extraArtifacts: string[] = [];
      switch (input.kind) {
        case 'ReadFile': {
          const found = current.files.find((file) => file.path === input.path);
          if (found === undefined || found.bytes.byteLength > 256 * 1024)
            return {
              kind: 'Failed',
              failure: 'FilesystemRejected',
              summary: 'Requested file is unavailable within the read bound.',
              outputArtifactSaids: [],
            };
          summary = new TextDecoder('utf-8', { fatal: true }).decode(found.bytes);
          break;
        }
        case 'ListFiles':
          summary = current.files
            .filter((file) => file.path === input.path || file.path.startsWith(`${input.path}/`))
            .filter(
              (file) =>
                resources.resolve({
                  ...effect.proposal,
                  input: { kind: 'ReadFile', path: file.path },
                }).kind === 'Resolved',
            )
            .map((file) => file.path)
            .join('\n');
          break;
        case 'SearchRepository':
          summary = current.files
            .filter((file) => file.path === input.path || file.path.startsWith(`${input.path}/`))
            .filter(
              (file) =>
                resources.resolve({
                  ...effect.proposal,
                  input: { kind: 'ReadFile', path: file.path },
                }).kind === 'Resolved',
            )
            .flatMap((file) =>
              new TextDecoder()
                .decode(file.bytes)
                .split('\n')
                .flatMap((line, index) =>
                  line.includes(input.query) ? [`${file.path}:${String(index + 1)}:${line}`] : [],
                ),
            )
            .slice(0, 200)
            .join('\n');
          break;
        case 'WriteFile':
        case 'ReplaceText': {
          let content: string;
          if (input.kind === 'WriteFile') content = input.content;
          else {
            const previous = current.files.find((file) => file.path === input.path);
            if (previous === undefined) return { kind: 'DependencyUnavailable' };
            const text = new TextDecoder('utf-8', { fatal: true }).decode(previous.bytes);
            if (
              input.oldText.length === 0 ||
              !Number.isSafeInteger(input.expectedOccurrences) ||
              input.expectedOccurrences < 1 ||
              text.split(input.oldText).length - 1 !== input.expectedOccurrences
            )
              return { kind: 'DependencyUnavailable' };
            content = text.split(input.oldText).join(input.newText);
          }
          const bytes = new TextEncoder().encode(content);
          if (bytes.byteLength > 512 * 1024) return { kind: 'BudgetExhausted' };
          if (o.credentials.inspect(bytes).kind !== 'Recordable') return { kind: 'SecretDetected' };
          const files = [
            ...current.files.filter((file) => file.path !== input.path),
            { path: input.path, bytes },
          ];
          if (!this.#within(clean.files, files)) return { kind: 'BudgetExhausted' };
          await mkdir(dirname(join(path, input.path)), { recursive: true, mode: 0o700 });
          await writeFile(join(path, input.path), bytes, { mode: 0o600 });
          const changed = await o.source.capture(path, () => Promise.resolve(false));
          if (changed.kind !== 'Captured') return { kind: 'EvidenceIntegrityFailure' };
          after = changed.sourceSaid;
          await o.worker.copyInto(path, '/work/source');
          summary = `Updated ${input.path}.`;
          break;
        }
        case 'RunTests':
        case 'RunFormatter':
        case 'RunStaticAnalysis': {
          const command = resources.commandFor(effect);
          if (command === undefined) return { kind: 'EvidenceIntegrityFailure' };
          const remaining =
            o.budget.aggregateChildCommandTimeSeconds * 1000 - this.#commandMilliseconds;
          if (remaining < (command.timeoutSeconds + 2) * 1000) return { kind: 'BudgetExhausted' };
          const started = performance.now();
          const commandSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(Math.min(remaining, command.timeoutSeconds * 1000)),
          ]);
          const opened = await DockerEvaluationCompartment.open({
            profile: o.profile,
            image: o.image,
            mounts: [],
            signal: commandSignal,
          });
          if (opened.kind !== 'Opened') return { kind: 'DependencyUnavailable' };
          native = opened.compartment;
          await native.copyInto(path, '/work/source');
          await native.prepareCopiedSource('/work/source');
          const result = await observeContainedCommand(
            native.executeAt(
              '/work/source',
              [command.executableRealpath, ...command.argv.slice(1)],
              { cargoTargetScratch: true },
            ),
            new Uint8Array(),
            Math.min(128 * 1024, o.profile.limits.outputBytes),
            commandSignal,
          );
          if (result === undefined || result.code === null)
            return { kind: 'DependencyUnavailable' };
          if (!(await native.stopWriters())) return { kind: 'EvidenceIntegrityFailure' };
          if (input.kind === 'RunFormatter') {
            const output = join(root, 'formatted', 'source');
            await native.copyDirectoryOut('/work/source', output);
            const captured = await o.source.capture(output, () => Promise.resolve(false));
            if (captured.kind !== 'Captured') return { kind: 'EvidenceIntegrityFailure' };
            const updated = await o.source.open(captured.sourceSaid);
            if (updated === undefined || !this.#within(clean.files, updated.files))
              return { kind: 'BudgetExhausted' };
            const changes = measureEvaluationSourceChanges(current.files, updated.files);
            if (changes === undefined) return { kind: 'EvidenceIntegrityFailure' };
            for (const file of changes.paths) {
              const checked = o.resources.resolve({
                ...effect.proposal,
                input: { kind: 'WriteFile', path: file, content: '' },
              });
              if (checked.kind !== 'Resolved') return { kind: 'EvidenceIntegrityFailure' };
            }
            for (const file of updated.files)
              if (o.credentials.inspect(file.bytes).kind !== 'Recordable')
                return { kind: 'SecretDetected' };
            const removed = await observeContainedCommand(
              o.worker.execute(['rm', '-rf', '/work/source']),
              new Uint8Array(),
              1024,
              signal,
            );
            if (removed?.code !== 0) return { kind: 'EvidenceIntegrityFailure' };
            await o.worker.copyInto(output, '/work/source');
            after = captured.sourceSaid;
          }
          if (!(await native.close())) return { kind: 'EvidenceIntegrityFailure' };
          native = undefined;
          this.#commandMilliseconds += Math.ceil(performance.now() - started);
          if (this.#commandMilliseconds > o.budget.aggregateChildCommandTimeSeconds * 1000)
            return { kind: 'BudgetExhausted' };
          commandReceipt = {
            identity: command.identity,
            contentSaid: command.contentSaid,
            argv: [...command.argv],
            expectedExitCode: command.expectedExitCode,
            exitCode: result.code,
            output: result.output,
            error: result.error,
            cleanupConfirmed: true,
          };
          success = result.code === command.expectedExitCode;
          summary = `${command.identity}: exit ${String(result.code)}\n${result.output}\n${result.error}`;
          break;
        }
        case 'SubmitResult': {
          const observed = await observePublicSourceArtifact(
            {
              manifest: o.manifest,
              bundle: o.verifier,
              capturedSourceSaid: before.sourceSaid,
              signal,
            },
            { construction: o.construction, observation: o.observation },
          );
          if (observed.kind !== 'PublicObserved') return { kind: 'DependencyUnavailable' };
          publicConditions = [...observed.publicCases];
          success = observed.publicCases.every((condition) => condition.verdict === 'Pass');
          extraArtifacts = [
            observed.frozenArtifact.buildReceiptSaid,
            observed.frozenArtifact.cleanupReceiptSaid,
            ...observed.publicCases.flatMap((condition) => [
              condition.rawObservationSaid,
              condition.cleanupReceiptSaid,
            ]),
          ];
          summary = success ? 'Original public cases passed.' : 'Original public cases failed.';
          break;
        }
      }
      if (interrupted(signal)) return { kind: 'DependencyUnavailable' };
      if (o.credentials.inspect(new TextEncoder().encode(summary)).kind !== 'Recordable')
        return { kind: 'SecretDetected' };
      const next = await o.source.open(after);
      if (next === undefined) return { kind: 'EvidenceIntegrityFailure' };
      const receipt: EvaluationRepositoryEffectReceipt = {
        version: 1,
        kind: 'EvaluationRepositoryEffect',
        toolCallId: effect.proposal.toolCallId,
        proposalIndex: effect.proposal.proposalIndex,
        inputKind: input.kind,
        sourceBeforeSaid: before.sourceSaid,
        sourceAfterSaid: after,
        ...(commandReceipt === undefined ? {} : { command: commandReceipt }),
        ...(publicConditions === undefined ? {} : { publicConditions }),
      };
      const outputs = await Promise.all([
        o.artifacts.record({ bytes: current.manifestBytes, mediaType: 'application/json' }),
        o.artifacts.record({ bytes: next.manifestBytes, mediaType: 'application/json' }),
        o.artifacts.record({
          bytes: Buffer.from(JSON.stringify(receipt)),
          mediaType: 'application/json',
        }),
      ]);
      if (outputs.some((output) => output.kind !== 'Stored'))
        return { kind: 'EvidenceIntegrityFailure' };
      const outputArtifactSaids = [
        ...new Set([
          ...outputs.flatMap((output) => (output.kind === 'Stored' ? [output.artifact.d] : [])),
          ...extraArtifacts,
        ]),
      ];
      return input.kind === 'SubmitResult'
        ? {
            kind: 'SubmissionVerified',
            disposition: success ? 'Accepted' : 'Rejected',
            summary,
            outputArtifactSaids,
          }
        : success
          ? { kind: 'Completed', summary, outputArtifactSaids }
          : { kind: 'Failed', failure: 'ExitCodeMismatch', summary, outputArtifactSaids };
    } catch {
      return { kind: 'DependencyUnavailable' };
    } finally {
      if (native !== undefined) await native.close();
      await rm(root, { recursive: true, force: true });
    }
  }
  #within(before: Files, after: Files): boolean {
    const changes = measureEvaluationSourceChanges(before, after);
    return (
      changes !== undefined &&
      changes.changedFiles <= this.#options.budget.changedFiles &&
      changes.changedWorktreeBytes <= this.#options.budget.changedWorktreeBytes
    );
  }
}
