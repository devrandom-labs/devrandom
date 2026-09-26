import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, join } from 'node:path';

import {
  credentialRegistryId,
  governorAid,
  issuerAid,
  personalAgentAid,
  userAid,
} from '@devrandom/identity';
import Type from 'typebox';
import Value from 'typebox/value';

import {
  advanceTaskAuthorization,
  beginTaskAuthorization,
  type TaskAuthorization,
  type TaskAuthorizationAdvancement,
  type TaskAuthorizationBinding,
} from '../domain/task-authorization.js';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const operationNameSchema = Type.String({ minLength: 1, maxLength: 512 });
const epochMillisecondsSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const timestampSchema = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});

const bindingSchema = Type.Object(
  {
    ownerAid: saidSchema,
    taskId: uuidV4Schema,
    taskRevisionSaid: saidSchema,
    harnessLineageId: uuidV4Schema,
    personalAgentAid: saidSchema,
    governorAid: saidSchema,
    issuerAid: saidSchema,
    mandateRegistryId: saidSchema,
  },
  { additionalProperties: false },
);

const submissionSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('OperationRecorded'), operationName: operationNameSchema },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal('RecoveredWithoutOperation') }, { additionalProperties: false }),
]);

const credentialSchema = Type.Object(
  {
    issuedAt: epochMillisecondsSchema,
    credentialSaid: saidSchema,
    issuance: submissionSchema,
  },
  { additionalProperties: false },
);

const grantSchema = Type.Object(
  {
    preparedAt: epochMillisecondsSchema,
    grantSaid: saidSchema,
    submission: submissionSchema,
  },
  { additionalProperties: false },
);

const holderAdmissionSchema = Type.Object(
  {
    preparedAt: epochMillisecondsSchema,
    admitSaid: saidSchema,
    submission: submissionSchema,
  },
  { additionalProperties: false },
);

const credentialProperties = { credential: credentialSchema };
const holderGrantProperties = { ...credentialProperties, holderGrant: grantSchema };
const holderAdmissionProperties = {
  ...holderGrantProperties,
  holderAdmission: holderAdmissionSchema,
};
const serverGrantProperties = { ...holderAdmissionProperties, serverGrant: grantSchema };

const mandateProgressSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('IssuancePrepared'), issuedAt: epochMillisecondsSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('IssuanceSubmitted'),
      issuedAt: epochMillisecondsSchema,
      credentialSaid: saidSchema,
      operationName: operationNameSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('CredentialMaterialized'), ...credentialProperties },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('HolderGrantPreparing'),
      ...credentialProperties,
      preparedAt: epochMillisecondsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('HolderGrantPrepared'),
      ...credentialProperties,
      preparedAt: epochMillisecondsSchema,
      grantSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('HolderGrantSubmitted'),
      ...credentialProperties,
      preparedAt: epochMillisecondsSchema,
      grantSaid: saidSchema,
      operationName: operationNameSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('HolderGrantMaterialized'), ...holderGrantProperties },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('HolderAdmissionPreparing'),
      ...holderGrantProperties,
      preparedAt: epochMillisecondsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('HolderAdmissionAwaitingMaterialization'),
      ...holderAdmissionProperties,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('HolderVerified'), ...holderAdmissionProperties },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ServerGrantPreparing'),
      ...holderAdmissionProperties,
      preparedAt: epochMillisecondsSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ServerGrantPrepared'),
      ...holderAdmissionProperties,
      preparedAt: epochMillisecondsSchema,
      grantSaid: saidSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ServerGrantSubmitted'),
      ...holderAdmissionProperties,
      preparedAt: epochMillisecondsSchema,
      grantSaid: saidSchema,
      operationName: operationNameSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal('ServerGrantMaterialized'), ...serverGrantProperties },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ServerPresentationAwaitingGrant'),
      ...serverGrantProperties,
      presentationExpiresAt: timestampSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ServerPresentationAdmitting'),
      ...serverGrantProperties,
      presentationExpiresAt: timestampSchema,
      operationName: operationNameSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('ServerAdmitted'),
      ...serverGrantProperties,
      presentationExpiresAt: timestampSchema,
      admittedAt: timestampSchema,
      admission: submissionSchema,
    },
    { additionalProperties: false },
  ),
]);

function admittedMandateSchema<Kind extends 'TaskMandate' | 'PromotionMandate'>(kind: Kind) {
  return Type.Object(
    {
      kind: Type.Literal(kind),
      ...serverGrantProperties,
      presentationExpiresAt: timestampSchema,
      admittedAt: timestampSchema,
      admission: submissionSchema,
    },
    { additionalProperties: false },
  );
}

const taskAdmittedSchema = admittedMandateSchema('TaskMandate');
const promotionAdmittedSchema = admittedMandateSchema('PromotionMandate');

const stageSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal('TaskMandate'), progress: mandateProgressSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('PromotionMandate'),
      taskMandate: taskAdmittedSchema,
      progress: mandateProgressSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('Ready'),
      taskMandate: taskAdmittedSchema,
      promotionMandate: promotionAdmittedSchema,
    },
    { additionalProperties: false },
  ),
]);

const taskAuthorizationSchema = Type.Object(
  {
    version: Type.Literal(1),
    revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    binding: bindingSchema,
    stage: stageSchema,
  },
  { additionalProperties: false },
);

export type TaskAuthorizationFileError =
  | { readonly kind: 'TaskAuthorizationInvalid' }
  | { readonly kind: 'TaskAuthorizationInsecure' }
  | { readonly kind: 'TaskAuthorizationConflict' }
  | { readonly kind: 'TaskAuthorizationBindingConflict' }
  | { readonly kind: 'TaskAuthorizationTransitionConflict' }
  | { readonly kind: 'TaskAuthorizationUnavailable' };

export class TaskAuthorizationFileFailure extends Error {
  readonly detail: TaskAuthorizationFileError;

  constructor(detail: TaskAuthorizationFileError, cause?: unknown) {
    super(detail.kind, cause === undefined ? undefined : { cause });
    this.name = 'TaskAuthorizationFileFailure';
    this.detail = detail;
  }
}

export class TaskAuthorizationFile {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async read(taskId: string): Promise<TaskAuthorization | undefined> {
    const path = this.#path(taskId);
    let before: Stats;
    try {
      before = await lstat(path);
    } catch (cause) {
      if (isAbsent(cause)) {
        return undefined;
      }
      throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationUnavailable' }, cause);
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !ownedByCurrentUser(before) ||
      (before.mode & 0o077) !== 0
    ) {
      throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationInsecure' });
    }

    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino) {
        throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationConflict' });
      }
      const source = await handle.readFile('utf8');
      const parsed: unknown = JSON.parse(source);
      const authorization = decodeTaskAuthorization(parsed);
      if (authorization === undefined || authorization.binding.taskId !== taskId) {
        throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationInvalid' });
      }
      return authorization;
    } catch (cause) {
      if (cause instanceof TaskAuthorizationFileFailure) {
        throw cause;
      }
      throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationInvalid' }, cause);
    } finally {
      await handle?.close();
    }
  }

  async commit(
    previousRevision: number | undefined,
    authorization: TaskAuthorization,
  ): Promise<void> {
    const decoded = decodeTaskAuthorization(authorization);
    if (decoded === undefined || !isDeepStrictEqual(decoded, authorization)) {
      throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationInvalid' });
    }
    await this.#prepareDirectory();
    const path = this.#path(authorization.binding.taskId);
    const lockPath = `${path}.lock`;
    let lock;
    try {
      lock = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch (cause) {
      throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationConflict' }, cause);
    }
    try {
      const current = await this.read(authorization.binding.taskId);
      if (current?.revision !== previousRevision) {
        throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationConflict' });
      }
      if (current === undefined) {
        if (!isInitialAuthorization(authorization)) {
          throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationTransitionConflict' });
        }
      } else {
        if (!isDeepStrictEqual(current.binding, authorization.binding)) {
          throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationBindingConflict' });
        }
        if (!isSuccessor(current, authorization)) {
          throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationTransitionConflict' });
        }
      }
      await this.#replaceAtomically(path, authorization);
    } finally {
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  #path(taskId: string): string {
    if (!Value.Check(uuidV4Schema, taskId)) {
      throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationInvalid' });
    }
    return join(this.#directory, `${taskId}.json`);
  }

  async #prepareDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const state = await lstat(this.#directory);
    if (!state.isDirectory() || state.isSymbolicLink() || !ownedByCurrentUser(state)) {
      throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationInsecure' });
    }
    await chmod(this.#directory, 0o700);
  }

  async #replaceAtomically(path: string, authorization: TaskAuthorization): Promise<void> {
    const temporary = join(
      dirname(path),
      `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`,
    );
    let handle;
    try {
      handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(authorization)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, path);
      const directory = await open(this.#directory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      throw new TaskAuthorizationFileFailure({ kind: 'TaskAuthorizationUnavailable' }, cause);
    } finally {
      await handle?.close();
    }
  }
}

function decodeTaskAuthorization(input: unknown): TaskAuthorization | undefined {
  if (
    !Value.Check(taskAuthorizationSchema, input) ||
    !distinctPrincipals(input.binding) ||
    !validStage(input.stage)
  ) {
    return undefined;
  }
  return {
    version: 1,
    revision: input.revision,
    binding: decodeBinding(input.binding),
    stage: input.stage,
  };
}

function validStage(stage: Type.Static<typeof stageSchema>): boolean {
  switch (stage.kind) {
    case 'TaskMandate':
      return validProgress(stage.progress);
    case 'PromotionMandate':
      return validAdmittedMandate(stage.taskMandate) && validProgress(stage.progress);
    case 'Ready':
      return (
        validAdmittedMandate(stage.taskMandate) && validAdmittedMandate(stage.promotionMandate)
      );
  }
}

function validProgress(progress: Type.Static<typeof mandateProgressSchema>): boolean {
  switch (progress.kind) {
    case 'IssuancePrepared':
    case 'IssuanceSubmitted':
      return true;
    case 'CredentialMaterialized':
      return true;
    case 'HolderGrantPreparing':
    case 'HolderGrantPrepared':
    case 'HolderGrantSubmitted':
      return progress.preparedAt >= progress.credential.issuedAt;
    case 'HolderGrantMaterialized':
      return validGrant(progress.holderGrant, progress.credential.issuedAt);
    case 'HolderAdmissionPreparing':
      return (
        validGrant(progress.holderGrant, progress.credential.issuedAt) &&
        progress.preparedAt >= progress.holderGrant.preparedAt
      );
    case 'HolderAdmissionAwaitingMaterialization':
    case 'HolderVerified':
      return validHolderFacts(progress);
    case 'ServerGrantPreparing':
    case 'ServerGrantPrepared':
    case 'ServerGrantSubmitted':
      return (
        validHolderFacts(progress) && progress.preparedAt >= progress.holderAdmission.preparedAt
      );
    case 'ServerGrantMaterialized':
      return (
        validHolderFacts(progress) &&
        validGrant(progress.serverGrant, progress.holderAdmission.preparedAt)
      );
    case 'ServerPresentationAwaitingGrant':
    case 'ServerPresentationAdmitting':
      return (
        validHolderFacts(progress) &&
        validGrant(progress.serverGrant, progress.holderAdmission.preparedAt) &&
        validTimestamp(progress.presentationExpiresAt)
      );
    case 'ServerAdmitted':
      return validAdmittedMandate(progress);
  }
}

function validHolderFacts(input: {
  readonly credential: Type.Static<typeof credentialSchema>;
  readonly holderGrant: Type.Static<typeof grantSchema>;
  readonly holderAdmission: Type.Static<typeof holderAdmissionSchema>;
}): boolean {
  return (
    validGrant(input.holderGrant, input.credential.issuedAt) &&
    input.holderAdmission.preparedAt >= input.holderGrant.preparedAt
  );
}

function validAdmittedMandate(input: {
  readonly credential: Type.Static<typeof credentialSchema>;
  readonly holderGrant: Type.Static<typeof grantSchema>;
  readonly holderAdmission: Type.Static<typeof holderAdmissionSchema>;
  readonly serverGrant: Type.Static<typeof grantSchema>;
  readonly presentationExpiresAt: string;
  readonly admittedAt: string;
}): boolean {
  return (
    validHolderFacts(input) &&
    validGrant(input.serverGrant, input.holderAdmission.preparedAt) &&
    validTimestamp(input.presentationExpiresAt) &&
    validTimestamp(input.admittedAt) &&
    Date.parse(input.admittedAt) < Date.parse(input.presentationExpiresAt)
  );
}

function validGrant(grant: Type.Static<typeof grantSchema>, earliest: number): boolean {
  return grant.preparedAt >= earliest;
}

function validTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function decodeBinding(input: Type.Static<typeof bindingSchema>): TaskAuthorizationBinding {
  return {
    ownerAid: userAid(input.ownerAid),
    taskId: input.taskId,
    taskRevisionSaid: input.taskRevisionSaid,
    harnessLineageId: input.harnessLineageId,
    personalAgentAid: personalAgentAid(input.personalAgentAid),
    governorAid: governorAid(input.governorAid),
    issuerAid: issuerAid(input.issuerAid),
    mandateRegistryId: credentialRegistryId(input.mandateRegistryId),
  };
}

function distinctPrincipals(binding: Type.Static<typeof bindingSchema>): boolean {
  return new Set([binding.ownerAid, binding.personalAgentAid, binding.governorAid]).size === 3;
}

function isInitialAuthorization(authorization: TaskAuthorization): boolean {
  if (
    authorization.revision !== 0 ||
    authorization.stage.kind !== 'TaskMandate' ||
    authorization.stage.progress.kind !== 'IssuancePrepared'
  ) {
    return false;
  }
  const beginning = beginTaskAuthorization(
    authorization.binding,
    authorization.stage.progress.issuedAt,
  );
  return beginning.kind === 'Begun' && isDeepStrictEqual(beginning.authorization, authorization);
}

function isSuccessor(current: TaskAuthorization, candidate: TaskAuthorization): boolean {
  const advancement = advancementFromCandidate(current, candidate);
  if (advancement === undefined) {
    return false;
  }
  const transition = advanceTaskAuthorization(current, advancement);
  return (
    transition.kind === 'Advanced' &&
    transition.authorization.revision === candidate.revision &&
    isDeepStrictEqual(transition.authorization, candidate)
  );
}

function advancementFromCandidate(
  current: TaskAuthorization,
  candidate: TaskAuthorization,
): TaskAuthorizationAdvancement | undefined {
  if (candidate.revision !== current.revision + 1) {
    return undefined;
  }
  if (
    current.stage.kind === 'TaskMandate' &&
    current.stage.progress.kind === 'ServerAdmitted' &&
    candidate.stage.kind === 'PromotionMandate' &&
    candidate.stage.progress.kind === 'IssuancePrepared'
  ) {
    return {
      kind: 'PreparePromotionIssuance',
      issuedAt: candidate.stage.progress.issuedAt,
    };
  }
  if (candidate.stage.kind === 'Ready') {
    return current.stage.kind === 'PromotionMandate'
      ? {
          kind: 'ServerAdmitted',
          presentationExpiresAt: candidate.stage.promotionMandate.presentationExpiresAt,
          admittedAt: candidate.stage.promotionMandate.admittedAt,
        }
      : undefined;
  }
  const progress = candidate.stage.progress;
  if (current.stage.kind === 'Ready') {
    return undefined;
  }
  switch (progress.kind) {
    case 'IssuancePrepared':
      return undefined;
    case 'IssuanceSubmitted':
      return {
        kind: 'CredentialIssuanceSubmitted',
        credentialSaid: progress.credentialSaid,
        operationName: progress.operationName,
      };
    case 'CredentialMaterialized':
      return { kind: 'CredentialMaterialized', credentialSaid: progress.credential.credentialSaid };
    case 'HolderGrantPreparing':
      return { kind: 'PrepareHolderGrant', preparedAt: progress.preparedAt };
    case 'HolderGrantPrepared':
      return { kind: 'HolderGrantPrepared', grantSaid: progress.grantSaid };
    case 'HolderGrantSubmitted':
      return { kind: 'HolderGrantSubmitted', operationName: progress.operationName };
    case 'HolderGrantMaterialized':
      return { kind: 'HolderGrantMaterialized' };
    case 'HolderAdmissionPreparing':
      return { kind: 'PrepareHolderAdmission', preparedAt: progress.preparedAt };
    case 'HolderAdmissionAwaitingMaterialization':
      return progress.holderAdmission.submission.kind === 'OperationRecorded'
        ? {
            kind: 'HolderAdmissionSubmitted',
            admitSaid: progress.holderAdmission.admitSaid,
            operationName: progress.holderAdmission.submission.operationName,
          }
        : {
            kind: 'HolderAdmissionRecovered',
            admitSaid: progress.holderAdmission.admitSaid,
          };
    case 'HolderVerified':
      return { kind: 'HolderVerified' };
    case 'ServerGrantPreparing':
      return { kind: 'PrepareServerGrant', preparedAt: progress.preparedAt };
    case 'ServerGrantPrepared':
      return { kind: 'ServerGrantPrepared', grantSaid: progress.grantSaid };
    case 'ServerGrantSubmitted':
      return { kind: 'ServerGrantSubmitted', operationName: progress.operationName };
    case 'ServerGrantMaterialized':
      return { kind: 'ServerGrantMaterialized' };
    case 'ServerPresentationAwaitingGrant':
      return {
        kind: 'ServerPresentationAwaitingGrant',
        presentationExpiresAt: progress.presentationExpiresAt,
      };
    case 'ServerPresentationAdmitting':
      return {
        kind: 'ServerPresentationAdmitting',
        presentationExpiresAt: progress.presentationExpiresAt,
        operationName: progress.operationName,
      };
    case 'ServerAdmitted':
      return {
        kind: 'ServerAdmitted',
        presentationExpiresAt: progress.presentationExpiresAt,
        admittedAt: progress.admittedAt,
      };
  }
}

function ownedByCurrentUser(state: Stats): boolean {
  return process.getuid === undefined || state.uid === process.getuid();
}

function isAbsent(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}
