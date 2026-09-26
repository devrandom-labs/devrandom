import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, opendir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import type { HarnessCommand, HarnessToolCommand, TaskToolCapability } from '@devrandom/domain';
import type { BaselineHarnessRevision, EvidenceArtifactMediaType } from '@devrandom/protocol';
import type {
  AuthorizedToolEffect,
  EvidenceArtifactRecording,
  ToolEffectOutcome,
  ToolEffects,
  ToolGatewayProposal,
  ToolResourceResolution,
  ToolResourceScope,
} from '@devrandom/runtime';

import type {
  ExactChildCommandOutcome,
  ExactChildCommands,
} from '../application/exact-child-command.js';
import type { ProcessOutputEvidence } from '../application/process-output-evidence.js';
import type { WorktreeWriteAdmission } from '../application/worktree-write-admission.js';
import type {
  RunSubmissionVerification,
  RunSubmissionVerificationOutcome,
} from '../application/run-submissions.js';

export const managedWorktreeCapabilities: readonly TaskToolCapability[] = Object.freeze([
  'ReadRepository',
  'EditRepository',
  'RunTests',
  'RunFormatter',
  'RunStaticAnalysis',
  'SubmitResult',
]);

export interface ManagedWorktreeResourceOptions {
  readonly worktree: string;
  readonly protectedPaths: readonly string[];
  readonly readOnlyPaths?: readonly string[];
  readonly completionCommands: BaselineHarnessRevision['completionCommands'];
  readonly toolCommands: readonly HarnessToolCommand[];
}

export interface ManagedToolArtifacts {
  storeArtifact(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: EvidenceArtifactMediaType;
  }): EvidenceArtifactRecording;
}

export interface ManagedWorktreeToolEffectOptions {
  readonly resources: ManagedWorktreeResources;
  readonly writeAdmission: WorktreeWriteAdmission;
  readonly commands: ExactChildCommands;
  readonly artifacts: ManagedToolArtifacts;
  readonly processOutput: ProcessOutputEvidence;
  readonly verification: RunSubmissionVerification;
}

const maximumReadBytes = 256 * 1_024;
const maximumListedFiles = 500;
const maximumTraversedEntries = 5_000;
const maximumSearchMatches = 200;
const maximumWriteBytes = 512 * 1_024;
const relativePathPattern = new RegExp(
  '^(?!/)(?!.*//)(?!.*(?:^|/)\\.\\.(?:/|$))(?!.*(?:^|/)\\.(?:/|$))[^/]+(?:/[^/]+)*$',
  'u',
);

function pathContainsForbiddenCharacter(path: string): boolean {
  for (const character of path) {
    const codePoint = character.codePointAt(0);
    if (
      character === '\\' ||
      codePoint === undefined ||
      codePoint <= 31 ||
      (codePoint >= 127 && codePoint <= 159)
    ) {
      return true;
    }
  }
  return false;
}

function pathIsInside(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return (
    remainder.length === 0 ||
    (!remainder.startsWith(`..${sep}`) && remainder !== '..' && !isAbsolute(remainder))
  );
}

function submissionResource(artifactSaids: readonly string[]): string {
  const digest = createHash('sha256').update(artifactSaids.join('\u0000')).digest('hex');
  return `submission://sha256:${digest}`;
}

export class ManagedWorktreeResources implements ToolResourceScope {
  readonly #root: string;
  readonly #protectedPaths: readonly string[];
  readonly #readOnlyPaths: readonly string[];
  readonly #commands: ReadonlyMap<
    string,
    HarnessCommand & { readonly capability: 'RunTests' | 'RunFormatter' | 'RunStaticAnalysis' }
  >;

  constructor(options: ManagedWorktreeResourceOptions) {
    this.#root = realpathSync(options.worktree);
    this.#protectedPaths = ['.git', '.devrandom', ...options.protectedPaths];
    this.#readOnlyPaths = options.readOnlyPaths ?? [];
    this.#commands = new Map(
      [
        ...options.completionCommands.map((command) => ({
          ...command,
          capability: 'RunTests' as const,
        })),
        ...options.toolCommands,
      ].map((command) => [command.identity, command]),
    );
  }

  resolve(proposal: ToolGatewayProposal): ToolResourceResolution {
    switch (proposal.input.kind) {
      case 'ReadFile':
      case 'ListFiles':
        return this.#repositoryResource(proposal.input.path, 'Read');
      case 'WriteFile':
      case 'ReplaceText':
        return this.#repositoryResource(proposal.input.path, 'Write');
      case 'SearchRepository':
        return proposal.input.query.length === 0
          ? { kind: 'Denied', reason: 'ArgumentsInvalid' }
          : this.#repositoryResource(proposal.input.path, 'Read');
      case 'RunFormatter':
      case 'RunStaticAnalysis':
      case 'RunTests': {
        const command = this.#commands.get(proposal.input.commandId);
        return command === undefined || command.capability !== proposal.input.kind
          ? { kind: 'Denied', reason: 'ArgumentsInvalid' }
          : { kind: 'Resolved', resource: `command://${command.identity}@${command.contentSaid}` };
      }
      case 'SubmitResult':
        return { kind: 'Resolved', resource: submissionResource(proposal.input.artifactSaids) };
    }
  }

  pathFor(effect: AuthorizedToolEffect): string | undefined {
    switch (effect.proposal.input.kind) {
      case 'ReadFile':
      case 'ListFiles':
      case 'SearchRepository':
      case 'WriteFile':
      case 'ReplaceText': {
        const access =
          effect.proposal.input.kind === 'WriteFile' || effect.proposal.input.kind === 'ReplaceText'
            ? 'Write'
            : 'Read';
        const resolved = this.#repositoryResource(effect.proposal.input.path, access);
        return resolved.kind === 'Resolved' && resolved.resource === effect.resource
          ? this.#resolveWorktreePath(effect.proposal.input.path, access)
          : undefined;
      }
      case 'RunFormatter':
      case 'RunStaticAnalysis':
      case 'RunTests':
      case 'SubmitResult':
        return undefined;
    }
  }

  commandFor(effect: AuthorizedToolEffect): HarnessCommand | undefined {
    if (
      effect.proposal.input.kind !== 'RunTests' &&
      effect.proposal.input.kind !== 'RunFormatter' &&
      effect.proposal.input.kind !== 'RunStaticAnalysis'
    )
      return undefined;
    const command = this.#commands.get(effect.proposal.input.commandId);
    return command !== undefined &&
      command.capability === effect.proposal.input.kind &&
      effect.requiredCapability === command.capability &&
      effect.resource === `command://${command.identity}@${command.contentSaid}`
      ? command
      : undefined;
  }

  submissionMatches(effect: AuthorizedToolEffect): boolean {
    return (
      effect.proposal.input.kind === 'SubmitResult' &&
      effect.resource === submissionResource(effect.proposal.input.artifactSaids)
    );
  }

  permitsPath(path: string): boolean {
    return (
      this.#repositoryResource(relative(this.#root, path).split(sep).join('/'), 'Read').kind ===
      'Resolved'
    );
  }

  #repositoryResource(path: string, access: 'Read' | 'Write'): ToolResourceResolution {
    if (
      !relativePathPattern.test(path) ||
      pathContainsForbiddenCharacter(path) ||
      this.#isProtected(path) ||
      (access === 'Write' && this.#isReadOnly(path))
    ) {
      return { kind: 'Denied', reason: 'PathEscape' };
    }
    return this.#resolveWorktreePath(path, access) === undefined
      ? { kind: 'Denied', reason: 'PathEscape' }
      : { kind: 'Resolved', resource: `repository://${path}` };
  }

  #isProtected(path: string): boolean {
    return this.#protectedPaths.some(
      (protectedPath) => path === protectedPath || path.startsWith(`${protectedPath}/`),
    );
  }

  #isReadOnly(path: string): boolean {
    return this.#readOnlyPaths.some(
      (readOnlyPath) => path === readOnlyPath || path.startsWith(`${readOnlyPath}/`),
    );
  }

  #resolveWorktreePath(path: string, access: 'Read' | 'Write'): string | undefined {
    const candidate = resolve(this.#root, path);
    let existing = candidate;
    const missing: string[] = [];
    try {
      while (lstatSync(existing, { throwIfNoEntry: false }) === undefined) {
        const parent = dirname(existing);
        if (parent === existing) return undefined;
        missing.unshift(basename(existing));
        existing = parent;
      }
      const resolvedExisting = realpathSync(existing);
      const resolved = resolve(resolvedExisting, ...missing);
      return pathIsInside(this.#root, resolved) &&
        !this.#isProtected(relative(this.#root, resolved).split(sep).join('/')) &&
        (access === 'Read' ||
          !this.#isReadOnly(relative(this.#root, resolved).split(sep).join('/')))
        ? resolved
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function completed(summary: string, outputArtifactSaids: readonly string[]): ToolEffectOutcome {
  return { kind: 'Completed', summary, outputArtifactSaids };
}

async function readBoundedFile(
  path: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<
  | { readonly kind: 'Read'; readonly bytes: Uint8Array }
  | { readonly kind: 'OutputLimitExceeded' | 'FilesystemRejected' }
> {
  signal.throwIfAborted();
  const file = await open(path, 'r');
  try {
    signal.throwIfAborted();
    const metadata = await file.stat();
    signal.throwIfAborted();
    if (!metadata.isFile()) return { kind: 'FilesystemRejected' };
    if (metadata.size > maximumBytes) return { kind: 'OutputLimitExceeded' };
    // The extra byte detects growth beyond the bound without an unbounded read.
    const buffer = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, length, buffer.byteLength - length, length);
      signal.throwIfAborted();
      if (bytesRead === 0) return { kind: 'Read', bytes: buffer.subarray(0, length) };
      length += bytesRead;
    }
    return { kind: 'OutputLimitExceeded' };
  } finally {
    await file.close();
  }
}

function failed(
  failure: Extract<ToolEffectOutcome, { readonly kind: 'Failed' }>['failure'],
  summary: string,
  outputArtifactSaids: readonly string[] = [],
): ToolEffectOutcome {
  return { kind: 'Failed', failure, summary, outputArtifactSaids };
}

function replacementByteLength(parts: readonly string[], replacement: string): number {
  const replacementBytes = Buffer.byteLength(replacement, 'utf8');
  let bytes = 0;
  let previous = '';
  for (const [index, part] of parts.entries()) {
    for (const chunk of [index === 0 ? '' : replacement, part]) {
      if (chunk.length === 0) continue;
      bytes += chunk === replacement ? replacementBytes : Buffer.byteLength(chunk, 'utf8');
      const last = previous.charCodeAt(previous.length - 1);
      const first = chunk.charCodeAt(0);
      // Two separately encoded lone surrogates become one four-byte scalar at a join.
      if (last >= 0xd800 && last <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) bytes -= 2;
      previous = chunk;
    }
  }
  return bytes;
}

export class ManagedWorktreeToolEffects implements ToolEffects {
  readonly #options: ManagedWorktreeToolEffectOptions;

  constructor(options: ManagedWorktreeToolEffectOptions) {
    this.#options = options;
  }

  async enact(effect: AuthorizedToolEffect, signal: AbortSignal): Promise<ToolEffectOutcome> {
    switch (effect.proposal.input.kind) {
      case 'ReadFile':
        return this.#read(effect, signal);
      case 'ListFiles':
        return this.#list(effect, signal);
      case 'SearchRepository':
        return this.#search(effect, signal);
      case 'WriteFile':
        return this.#write(effect, signal);
      case 'ReplaceText':
        return this.#replace(effect, signal);
      case 'RunTests':
      case 'RunFormatter':
      case 'RunStaticAnalysis':
        return this.#command(effect, signal);
      case 'SubmitResult':
        return this.#submit(effect, signal);
    }
  }

  async #read(effect: AuthorizedToolEffect, signal: AbortSignal): Promise<ToolEffectOutcome> {
    const path = this.#options.resources.pathFor(effect);
    if (path === undefined) return failed('FilesystemRejected', 'The file binding changed.');
    try {
      const reading = await readBoundedFile(path, maximumReadBytes, signal);
      signal.throwIfAborted();
      if (reading.kind !== 'Read')
        return failed(reading.kind, 'The file cannot be read within its bound.');
      const bytes = reading.bytes;
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return this.#stored(bytes, 'text/plain; charset=utf-8', content);
    } catch {
      if (signal.aborted) return failed('EffectAborted', 'The repository read was aborted.');
      return failed('FilesystemRejected', 'The requested file could not be read.');
    }
  }

  async #list(effect: AuthorizedToolEffect, signal: AbortSignal): Promise<ToolEffectOutcome> {
    const path = this.#options.resources.pathFor(effect);
    if (path === undefined) return failed('FilesystemRejected', 'The directory binding changed.');
    try {
      const enumeration = await this.#files(path, signal);
      signal.throwIfAborted();
      if (enumeration.kind === 'LimitExceeded') {
        return failed(
          'OutputLimitExceeded',
          'The directory exceeds the traversal or listing bound.',
        );
      }
      const listing = enumeration.files.join('\n');
      const bytes = new TextEncoder().encode(listing);
      return this.#stored(bytes, 'text/plain; charset=utf-8', listing);
    } catch {
      if (signal.aborted) return failed('EffectAborted', 'The repository read was aborted.');
      return failed('FilesystemRejected', 'The directory could not be listed.');
    }
  }

  async #search(effect: AuthorizedToolEffect, signal: AbortSignal): Promise<ToolEffectOutcome> {
    if (effect.proposal.input.kind !== 'SearchRepository') {
      return failed('FilesystemRejected', 'The search binding changed.');
    }
    const path = this.#options.resources.pathFor(effect);
    if (path === undefined) return failed('FilesystemRejected', 'The search binding changed.');
    try {
      signal.throwIfAborted();
      const target = await stat(path);
      signal.throwIfAborted();
      const directory = target.isFile() ? dirname(path) : path;
      const enumeration = await this.#files(path, signal);
      signal.throwIfAborted();
      if (enumeration.kind === 'LimitExceeded') {
        return failed('OutputLimitExceeded', 'The search exceeds the traversal or file bound.');
      }
      const matches: string[] = [];
      for (const file of enumeration.files) {
        const absolute = resolve(directory, file);
        const reading = await readBoundedFile(absolute, maximumReadBytes, signal);
        signal.throwIfAborted();
        if (reading.kind !== 'Read')
          return failed(reading.kind, 'A search target cannot be read within its bound.');
        const lines = new TextDecoder('utf-8', { ignoreBOM: true })
          .decode(reading.bytes)
          .split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (line?.includes(effect.proposal.input.query)) {
            matches.push(`${file}:${String(index + 1)}:${line}`);
            if (matches.length > maximumSearchMatches) {
              return failed('OutputLimitExceeded', 'The search exceeds the match bound.');
            }
          }
        }
      }
      const result = matches.join('\n');
      const bytes = new TextEncoder().encode(result);
      if (bytes.byteLength > maximumReadBytes) {
        return failed('OutputLimitExceeded', 'The search output exceeds the byte bound.');
      }
      return this.#stored(bytes, 'text/plain; charset=utf-8', result);
    } catch {
      if (signal.aborted) return failed('EffectAborted', 'The repository read was aborted.');
      return failed('FilesystemRejected', 'The repository search failed.');
    }
  }

  async #write(effect: AuthorizedToolEffect, signal: AbortSignal): Promise<ToolEffectOutcome> {
    if (effect.proposal.input.kind !== 'WriteFile') {
      return failed('FilesystemRejected', 'The write binding changed.');
    }
    const path = this.#options.resources.pathFor(effect);
    const bytes = new TextEncoder().encode(effect.proposal.input.content);
    if (path === undefined) return failed('FilesystemRejected', 'The write binding changed.');
    if (bytes.byteLength > maximumWriteBytes) {
      return failed('OutputLimitExceeded', 'The write exceeds the byte bound.');
    }
    try {
      signal.throwIfAborted();
      const admission = await this.#options.writeAdmission.admit({ path, bytes }, signal);
      signal.throwIfAborted();
      if (admission.kind !== 'Admitted') return admission;
      await mkdir(dirname(path), { recursive: true });
      signal.throwIfAborted();
      await writeFile(path, bytes, { mode: 0o600, signal });
      return completed(`Wrote ${effect.resource}.`, []);
    } catch {
      if (signal.aborted) return failed('EffectAborted', 'The file write was aborted.');
      return failed('FilesystemRejected', 'The file write failed.');
    }
  }

  async #replace(effect: AuthorizedToolEffect, signal: AbortSignal): Promise<ToolEffectOutcome> {
    if (effect.proposal.input.kind !== 'ReplaceText') {
      return failed('FilesystemRejected', 'The replacement binding changed.');
    }
    const path = this.#options.resources.pathFor(effect);
    if (path === undefined) return failed('FilesystemRejected', 'The replacement binding changed.');
    try {
      signal.throwIfAborted();
      const reading = await readBoundedFile(path, maximumWriteBytes, signal);
      signal.throwIfAborted();
      if (reading.kind !== 'Read')
        return failed(reading.kind, 'The replacement input cannot be read within its bound.');
      const content = new TextDecoder('utf-8', { ignoreBOM: true }).decode(reading.bytes);
      const parts = content.split(effect.proposal.input.oldText);
      const occurrences = parts.length - 1;
      if (occurrences !== effect.proposal.input.expectedOccurrences) {
        return failed('FilesystemRejected', 'The expected replacement occurrence count changed.');
      }
      if (replacementByteLength(parts, effect.proposal.input.newText) > maximumWriteBytes) {
        return failed('OutputLimitExceeded', 'The replacement exceeds the byte bound.');
      }
      const updated = parts.join(effect.proposal.input.newText);
      const admission = await this.#options.writeAdmission.admit(
        {
          path,
          bytes: new TextEncoder().encode(updated),
          replacement: {
            oldText: effect.proposal.input.oldText,
            newText: effect.proposal.input.newText,
          },
        },
        signal,
      );
      signal.throwIfAborted();
      if (admission.kind !== 'Admitted') return admission;
      await writeFile(path, updated, { encoding: 'utf8', mode: 0o600, signal });
      return completed(`Replaced text in ${effect.resource}.`, []);
    } catch {
      if (signal.aborted) return failed('EffectAborted', 'The text replacement was aborted.');
      return failed('FilesystemRejected', 'The text replacement failed.');
    }
  }

  async #command(effect: AuthorizedToolEffect, signal: AbortSignal): Promise<ToolEffectOutcome> {
    const command = this.#options.resources.commandFor(effect);
    if (command === undefined) {
      return failed('ExecutableUnavailable', 'The H1 command binding changed.');
    }
    const outcome = await this.#options.commands.run(
      {
        executableRealpath: command.executableRealpath,
        arguments: command.argv.slice(1),
        timeoutSeconds: command.timeoutSeconds,
        expectedExitCode: command.expectedExitCode,
        budgetProducer: { kind: 'ToolGateway' },
      },
      signal,
    );
    return this.#commandOutcome(command.identity, outcome);
  }

  async #submit(effect: AuthorizedToolEffect, signal: AbortSignal): Promise<ToolEffectOutcome> {
    if (
      effect.proposal.input.kind !== 'SubmitResult' ||
      !this.#options.resources.submissionMatches(effect)
    ) {
      return failed('FilesystemRejected', 'The submission resource binding changed.');
    }
    let outcome: RunSubmissionVerificationOutcome;
    try {
      outcome = await this.#options.verification.verify(
        { artifactSaids: effect.proposal.input.artifactSaids },
        signal,
      );
    } catch {
      return { kind: 'DependencyUnavailable' };
    }
    switch (outcome.kind) {
      case 'Accepted':
      case 'Rejected':
      case 'CompatibilityFailure':
        return {
          kind: 'SubmissionVerified',
          disposition: outcome.kind,
          summary:
            outcome.kind === 'Accepted'
              ? 'Public Task verification accepted the submitted result.'
              : outcome.kind === 'Rejected'
                ? `Public Task verification rejected the submitted result.\n${outcome.feedback}`
                : 'Public Task verification established a harness compatibility failure.',
          outputArtifactSaids: outcome.outputArtifactSaids,
        };
      case 'Blocked':
        if (outcome.reason === 'SecretDetected') return { kind: 'SecretDetected' };
        if (outcome.reason === 'OutboxBackpressure') {
          return { kind: 'OutboxBackpressure' };
        }
        return outcome.reason === 'BudgetExhausted'
          ? { kind: 'BudgetExhausted' }
          : failed(
              'EffectAborted',
              'Public Task verification was aborted.',
              outcome.outputArtifactSaids,
            );
      case 'DependencyUnavailable':
      case 'EvidenceIntegrityFailure':
        return outcome;
      case 'ArtifactUnavailable':
        return failed(
          'ArtifactUnavailable',
          'A submitted artifact is unavailable locally; use a retained artifact SAID or submit an empty list.',
        );
    }
  }

  async #commandOutcome(
    commandId: string,
    reported: ExactChildCommandOutcome,
  ): Promise<ToolEffectOutcome> {
    if (reported.kind === 'WorktreeAdmissionRejected') return { kind: reported.failure };
    const outcome =
      reported.kind === 'WorktreeReconciliationFailed' ? reported.execution : reported;
    switch (outcome.kind) {
      case 'ExecutableUnavailable':
        return failed('ExecutableUnavailable', `Command ${commandId} is unavailable.`);
      case 'AbortedBeforeStart':
        return failed('EffectAborted', `Command ${commandId} was aborted before starting.`);
      case 'BudgetExhausted':
        return { kind: 'BudgetExhausted' };
      case 'DependencyUnavailable':
        return failed('FilesystemRejected', `Command ${commandId} could not start.`);
      case 'Completed':
      case 'ExitCodeMismatch':
      case 'TimedOut':
      case 'OutputLimitExceeded':
      case 'Aborted':
      case 'SecretDetected':
      case 'ProcessGroupSurvived':
      case 'ProcessCleanupUnconfirmed':
      case 'BudgetCommitmentFailed': {
        const recording = await this.#options.processOutput.record(outcome.output);
        if (recording.kind === 'SecretDetected') return recording;
        if (recording.kind !== 'Recorded') return { kind: 'EvidenceIntegrityFailure' };
        if (outcome.kind === 'SecretDetected') return { kind: 'EvidenceIntegrityFailure' };
        const artifactSaids = [
          ...new Set([recording.stdoutArtifactSaid, recording.stderrArtifactSaid]),
        ];
        if (reported.kind === 'WorktreeReconciliationFailed')
          return failed(
            reported.failure,
            `Command ${commandId} failed worktree reconciliation.\n${recording.feedback}`,
            artifactSaids,
          );
        switch (outcome.kind) {
          case 'Completed':
            return completed(
              `Command ${commandId} exited with code ${String(outcome.exitCode)}.\n${recording.feedback}`,
              artifactSaids,
            );
          case 'ExitCodeMismatch':
            return failed(
              'ExitCodeMismatch',
              `Command ${commandId} exited with code ${String(outcome.exitCode)}.\n${recording.feedback}`,
              artifactSaids,
            );
          case 'TimedOut':
            return failed(
              'TimedOut',
              `Command ${commandId} timed out.\n${recording.feedback}`,
              artifactSaids,
            );
          case 'OutputLimitExceeded':
            return failed(
              'OutputLimitExceeded',
              `Command ${commandId} exceeded its output bound.\n${recording.feedback}`,
              artifactSaids,
            );
          case 'Aborted':
            return failed(
              'EffectAborted',
              `Command ${commandId} was aborted.\n${recording.feedback}`,
              artifactSaids,
            );
          case 'ProcessGroupSurvived':
            return failed(
              'ProcessSurvivedTermination',
              `Command ${commandId} left a process after termination.\n${recording.feedback}`,
              artifactSaids,
            );
          case 'ProcessCleanupUnconfirmed':
            return failed(
              'ProcessCleanupUnconfirmed',
              `Command ${commandId} cleanup could not be confirmed within its termination bound.\n${recording.feedback}`,
              artifactSaids,
            );
          case 'BudgetCommitmentFailed':
            return failed(
              outcome.failure,
              `Command ${commandId} failed budget settlement.\n${recording.feedback}`,
              artifactSaids,
            );
        }
      }
    }
  }

  async #files(
    root: string,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: 'Enumerated'; readonly files: readonly string[] }
    | { readonly kind: 'LimitExceeded' }
  > {
    signal.throwIfAborted();
    if (lstatSync(root).isSymbolicLink()) return { kind: 'Enumerated', files: [] };
    const metadata = await stat(root);
    signal.throwIfAborted();
    if (metadata.isFile()) return { kind: 'Enumerated', files: [basename(root)] };
    if (!metadata.isDirectory()) return { kind: 'Enumerated', files: [] };
    const results: string[] = [];
    const pending = [{ directory: root, prefix: '' }];
    let traversedEntries = 0;
    while (pending.length > 0) {
      signal.throwIfAborted();
      const next = pending.pop();
      if (next === undefined) break;
      const directory = await opendir(next.directory, { bufferSize: 32 });
      for await (const entry of directory) {
        signal.throwIfAborted();
        traversedEntries += 1;
        if (traversedEntries > maximumTraversedEntries) return { kind: 'LimitExceeded' };
        const childPrefix = next.prefix.length === 0 ? entry.name : `${next.prefix}/${entry.name}`;
        const absolute = resolve(next.directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (!this.#options.resources.permitsPath(absolute)) continue;
        if (entry.isDirectory()) pending.push({ directory: absolute, prefix: childPrefix });
        else if (entry.isFile()) {
          if (results.length === maximumListedFiles) return { kind: 'LimitExceeded' };
          results.push(childPrefix);
        }
      }
    }
    results.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    return { kind: 'Enumerated', files: results };
  }

  #stored(
    bytes: Uint8Array,
    mediaType: EvidenceArtifactMediaType,
    summary: string,
  ): ToolEffectOutcome {
    const recording = this.#options.artifacts.storeArtifact({ bytes, mediaType });
    if (recording.kind === 'SecretDetected') return recording;
    return recording.kind === 'Stored' || recording.kind === 'AlreadyStored'
      ? completed(summary, [recording.artifact.d])
      : { kind: 'EvidenceIntegrityFailure' };
  }
}
