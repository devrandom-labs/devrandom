import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

import Type from 'typebox';
import Value from 'typebox/value';

const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const fingerprint = Type.String({ pattern: '^sha256:[a-f0-9]{64}$' });
const inputSchema = Type.Object(
  { taskId: uuid, originRunId: uuid, policySaid: said },
  { additionalProperties: false },
);
const commandSchema = Type.Object(
  {
    version: Type.Literal(1),
    ...inputSchema.properties,
    commandId: uuid,
    fingerprint,
  },
  { additionalProperties: false },
);
const admissionSchema = Type.Object(
  {
    version: Type.Literal(1),
    commandId: uuid,
    fingerprint,
    evaluationId: uuid,
  },
  { additionalProperties: false },
);

export type EvaluationCommandInput = Type.Static<typeof inputSchema>;
export type EvaluationCommandAcquisition =
  | {
      readonly kind: 'Recorded';
      readonly commandId: string;
      readonly fingerprint: string;
      readonly admittedEvaluationId?: string;
    }
  | { readonly kind: 'Conflict' | 'Unavailable' };

function commandFingerprint(input: EvaluationCommandInput): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ version: 1, ...input }))
    .digest('hex')}`;
}

function absent(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

function exists(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'EEXIST';
}

async function readDocument(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await file.stat();
    if (
      !status.isFile() ||
      status.size < 2 ||
      status.size > 4096 ||
      (status.mode & 0o777) !== 0o600 ||
      (process.getuid !== undefined && status.uid !== process.getuid())
    ) {
      throw new Error('Evaluation command custody invalid');
    }
    return JSON.parse(await file.readFile({ encoding: 'utf8' })) as unknown;
  } finally {
    await file.close();
  }
}

async function createDocument(path: string, directory: string, document: object): Promise<void> {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await file.writeFile(JSON.stringify(document));
    await file.sync();
  } finally {
    await file.close();
  }
  const directoryFile = await open(directory, constants.O_RDONLY);
  try {
    await directoryFile.sync();
  } finally {
    await directoryFile.close();
  }
}

/** Persist exact command and admitted identity before any contained worker may start. */
export class EvaluationCommandFile {
  readonly #directory: string;
  readonly #newCommandId: () => string;

  constructor(directory: string, newCommandId: () => string) {
    this.#directory = directory;
    this.#newCommandId = newCommandId;
  }

  async acquire(input: EvaluationCommandInput): Promise<EvaluationCommandAcquisition> {
    if (!Value.Check(inputSchema, input)) return { kind: 'Unavailable' };
    try {
      await this.#checkDirectory();
      const path = this.#path(input);
      const expectedFingerprint = commandFingerprint(input);
      let command: unknown;
      try {
        command = await readDocument(path);
      } catch (cause) {
        if (!absent(cause)) throw cause;
        const fresh = {
          version: 1 as const,
          ...input,
          commandId: this.#newCommandId(),
          fingerprint: expectedFingerprint,
        };
        if (!Value.Check(commandSchema, fresh)) return { kind: 'Unavailable' };
        try {
          await createDocument(path, this.#directory, fresh);
        } catch (error) {
          if (!exists(error)) throw error;
        }
        command = await readDocument(path);
      }
      if (!Value.Check(commandSchema, command)) return { kind: 'Unavailable' };
      if (
        command.taskId !== input.taskId ||
        command.originRunId !== input.originRunId ||
        command.policySaid !== input.policySaid ||
        command.fingerprint !== expectedFingerprint
      )
        return { kind: 'Conflict' };
      let admission: unknown;
      try {
        admission = await readDocument(this.#admissionPath(input));
      } catch (cause) {
        if (!absent(cause)) throw cause;
      }
      if (admission !== undefined) {
        if (
          !Value.Check(admissionSchema, admission) ||
          admission.commandId !== command.commandId ||
          admission.fingerprint !== command.fingerprint
        )
          return { kind: 'Unavailable' };
      }
      return {
        kind: 'Recorded',
        commandId: command.commandId,
        fingerprint: command.fingerprint,
        ...(admission === undefined ? {} : { admittedEvaluationId: admission.evaluationId }),
      };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async recordAdmission(
    input: EvaluationCommandInput,
    commandId: string,
    evaluationId: string,
  ): Promise<{ readonly kind: 'Recorded' | 'Conflict' | 'Unavailable' }> {
    if (!Value.Check(uuid, commandId) || !Value.Check(uuid, evaluationId)) {
      return { kind: 'Unavailable' };
    }
    const acquired = await this.acquire(input);
    if (acquired.kind !== 'Recorded') return acquired;
    if (acquired.commandId !== commandId) return { kind: 'Conflict' };
    if (acquired.admittedEvaluationId !== undefined) {
      return {
        kind: acquired.admittedEvaluationId === evaluationId ? 'Recorded' : 'Conflict',
      };
    }
    const document = {
      version: 1 as const,
      commandId,
      fingerprint: acquired.fingerprint,
      evaluationId,
    };
    try {
      await createDocument(this.#admissionPath(input), this.#directory, document);
    } catch (cause) {
      if (!exists(cause)) return { kind: 'Unavailable' };
    }
    const replay = await this.acquire(input);
    return replay.kind === 'Recorded'
      ? { kind: replay.admittedEvaluationId === evaluationId ? 'Recorded' : 'Conflict' }
      : replay;
  }

  async #checkDirectory(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const directory = await open(this.#directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const status = await directory.stat();
      if (
        !status.isDirectory() ||
        (status.mode & 0o777) !== 0o700 ||
        (process.getuid !== undefined && status.uid !== process.getuid())
      )
        throw new Error('Evaluation command directory custody invalid');
    } finally {
      await directory.close();
    }
  }

  #path(input: EvaluationCommandInput): string {
    return join(this.#directory, `${input.taskId}.${input.originRunId}.json`);
  }

  #admissionPath(input: EvaluationCommandInput): string {
    return join(this.#directory, `${input.taskId}.${input.originRunId}.admission.json`);
  }
}
