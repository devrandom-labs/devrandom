import { constants } from 'node:fs';
import { mkdir, open, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import Type from 'typebox';
import Value from 'typebox/value';
import {
  decodeEvidenceArtifact,
  decodeSuccessorHarnessRevision,
  evidenceArtifactSchema,
  successorHarnessRevisionSchema,
  type SuccessorHarnessRevision,
} from '@devrandom/protocol';
import type { ExactTreatmentArtifact } from '@devrandom/runtime';
import type { CandidateBranchReceipt } from '../application/candidate-branch-custody.js';
const encodedArtifact = Type.Object(
  { artifact: evidenceArtifactSchema, bytesBase64Url: Type.String({ maxLength: 700000 }) },
  { additionalProperties: false },
);
const schema = Type.Object(
  {
    version: Type.Literal(1),
    revision: successorHarnessRevisionSchema,
    configuration: encodedArtifact,
    implementation: Type.Optional(encodedArtifact),
    replay: Type.Optional(encodedArtifact),
    branch: Type.Object(
      {
        arm: Type.Union([Type.Literal('C1'), Type.Literal('C2'), Type.Literal('C3')]),
        branch: Type.String({ minLength: 1, maxLength: 512 }),
        directory: Type.String({ minLength: 1, maxLength: 4096 }),
        parentCommit: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
        commit: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
        tree: Type.String({ pattern: '^[a-f0-9]{40,64}$' }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export interface RetainedSuccessorTreatment {
  readonly revision: SuccessorHarnessRevision;
  readonly configuration: ExactTreatmentArtifact;
  readonly implementation?: ExactTreatmentArtifact;
  readonly replay?: ExactTreatmentArtifact;
  readonly branch: CandidateBranchReceipt;
}
type Reading =
  | { readonly kind: 'Read'; readonly candidate: RetainedSuccessorTreatment }
  | { readonly kind: 'Missing' | 'Unavailable' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const encode = (input: ExactTreatmentArtifact) => ({
  artifact: input.artifact,
  bytesBase64Url: Buffer.from(input.bytes).toString('base64url'),
});
function decode(input: Type.Static<typeof encodedArtifact>): ExactTreatmentArtifact | undefined {
  const bytes = Buffer.from(input.bytesBase64Url, 'base64url');
  return bytes.toString('base64url') === input.bytesBase64Url &&
    decodeEvidenceArtifact(input.artifact, bytes).kind === 'Accepted'
    ? { artifact: input.artifact, bytes }
    : undefined;
}
function candidate(input: unknown): RetainedSuccessorTreatment | undefined {
  if (
    !Value.Check(schema, input) ||
    decodeSuccessorHarnessRevision(input.revision).kind !== 'Accepted'
  )
    return undefined;
  const configuration = decode(input.configuration);
  const implementation =
    input.implementation === undefined ? undefined : decode(input.implementation);
  const replay = input.replay === undefined ? undefined : decode(input.replay);
  const revision = input.revision;
  if (
    configuration === undefined ||
    configuration.artifact.d !== revision.configurationArtifactSaid ||
    input.branch.arm !== revision.arm ||
    !isAbsolute(input.branch.directory) ||
    input.branch.commit === input.branch.parentCommit
  )
    return undefined;
  if (
    revision.treatment.kind === 'Instruction'
      ? input.implementation !== undefined || input.replay !== undefined
      : implementation === undefined ||
        replay === undefined ||
        implementation.artifact.d !== revision.treatment.reviewedImplementationSaid ||
        replay.artifact.d !== revision.treatment.publicReplayReceiptSaid
  )
    return undefined;
  return {
    revision,
    configuration,
    ...(implementation === undefined ? {} : { implementation }),
    ...(replay === undefined ? {} : { replay }),
    branch: input.branch,
  };
}
/** Immutable exact treatment custody. Callers still replay materialization against their current M. */
export class FileSuccessorTreatmentCustody {
  readonly #stateRoot: string;
  constructor(stateRoot: string) {
    this.#stateRoot = stateRoot;
    if (!isAbsolute(stateRoot)) throw new Error('Absolute successor custody root required');
  }
  async read(evaluationId: string, revisionSaid: string): Promise<Reading> {
    if (!uuid.test(evaluationId) || !said.test(revisionSaid)) return { kind: 'Unavailable' };
    try {
      const directory = join(this.#stateRoot, 'evaluations', evaluationId, 'successors');
      const status = await lstat(directory);
      if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o700)
        return { kind: 'Unavailable' };
      const file = await open(
        join(directory, `${revisionSaid}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          (stat.mode & 0o777) !== 0o600 ||
          stat.size > 2200000 ||
          stat.uid !== process.getuid?.()
        )
          return { kind: 'Unavailable' };
        const text = await file.readFile('utf8');
        const value: unknown = JSON.parse(text);
        if (JSON.stringify(value) !== text) return { kind: 'Unavailable' };
        const decoded = candidate(value);
        return decoded?.revision.d === revisionSaid
          ? { kind: 'Read', candidate: decoded }
          : { kind: 'Unavailable' };
      } finally {
        await file.close();
      }
    } catch (cause) {
      return {
        kind:
          cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
            ? 'Missing'
            : 'Unavailable',
      };
    }
  }
  async retain(
    evaluationId: string,
    input: RetainedSuccessorTreatment,
  ): Promise<{ readonly kind: 'Retained' | 'Rejected' | 'Conflict' | 'Unavailable' }> {
    if (!uuid.test(evaluationId)) return { kind: 'Rejected' };
    const document = {
      version: 1,
      revision: input.revision,
      configuration: encode(input.configuration),
      ...(input.implementation === undefined
        ? {}
        : { implementation: encode(input.implementation) }),
      ...(input.replay === undefined ? {} : { replay: encode(input.replay) }),
      branch: input.branch,
    };
    if (candidate(document) === undefined) return { kind: 'Rejected' };
    const bytes = JSON.stringify(document);
    if (Buffer.byteLength(bytes) > 2200000) return { kind: 'Rejected' };
    const directory = join(this.#stateRoot, 'evaluations', evaluationId, 'successors');
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const status = await lstat(directory);
      if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o777) !== 0o700)
        return { kind: 'Unavailable' };
      const file = await open(
        join(directory, `${input.revision.d}.json`),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      const handle = await open(directory, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { kind: 'Retained' };
    } catch (cause) {
      if (cause instanceof Error && 'code' in cause && cause.code === 'EEXIST') {
        const prior = await this.read(evaluationId, input.revision.d);
        if (prior.kind !== 'Read') return { kind: 'Unavailable' };
        const retained = prior.candidate;
        return JSON.stringify({
          ...retained,
          configuration: encode(retained.configuration),
          ...(retained.implementation === undefined
            ? {}
            : { implementation: encode(retained.implementation) }),
          ...(retained.replay === undefined ? {} : { replay: encode(retained.replay) }),
        }) ===
          JSON.stringify({
            ...input,
            configuration: encode(input.configuration),
            ...(input.implementation === undefined
              ? {}
              : { implementation: encode(input.implementation) }),
            ...(input.replay === undefined ? {} : { replay: encode(input.replay) }),
          })
          ? { kind: 'Retained' }
          : { kind: 'Conflict' };
      }
      return { kind: 'Unavailable' };
    }
  }
}
