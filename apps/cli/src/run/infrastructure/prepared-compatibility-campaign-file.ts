import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import Type from 'typebox';
import Value from 'typebox/value';

const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const campaignSchema = Type.Object(
  {
    version: Type.Literal(1),
    taskLabel: Type.String({ pattern: '^[a-z][a-z0-9-]{0,62}$' }),
    campaignId: uuidV4Schema,
  },
  { additionalProperties: false },
);

export type PreparedCompatibilityCampaignAcquisition =
  | { readonly kind: 'Acquired'; readonly campaignId: string }
  | { readonly kind: 'BindingConflict' }
  | { readonly kind: 'Unavailable' };

function privateDirectory(metadata: Stats): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink() && (metadata.mode & 0o777) === 0o700;
}

function bindingMatches(document: Type.Static<typeof campaignSchema>, taskLabel: string): boolean {
  return document.taskLabel === taskLabel;
}

export class PreparedCompatibilityCampaignFile {
  readonly #directory: string;
  readonly #newCampaignId: () => string;

  constructor(directory: string, newCampaignId: () => string) {
    this.#directory = directory;
    this.#newCampaignId = newCampaignId;
  }

  async acquire(taskLabel: string): Promise<PreparedCompatibilityCampaignAcquisition> {
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await chmod(this.#directory, 0o700);
      if (!privateDirectory(await lstat(this.#directory))) return { kind: 'Unavailable' };
      const existing = await this.#read();
      if (existing !== undefined) {
        return bindingMatches(existing, taskLabel)
          ? { kind: 'Acquired', campaignId: existing.campaignId }
          : { kind: 'BindingConflict' };
      }
      const campaignId = this.#newCampaignId();
      const document = { version: 1 as const, taskLabel, campaignId };
      if (!Value.Check(campaignSchema, document)) return { kind: 'BindingConflict' };
      const lock = await open(
        join(this.#directory, 'campaign.lock'),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      ).catch(() => undefined);
      if (lock === undefined) return { kind: 'Unavailable' };
      try {
        const concurrent = await this.#read();
        if (concurrent !== undefined) {
          return bindingMatches(concurrent, taskLabel)
            ? { kind: 'Acquired', campaignId: concurrent.campaignId }
            : { kind: 'BindingConflict' };
        }
        const temporary = join(this.#directory, `campaign.${campaignId}.tmp`);
        const file = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        try {
          await file.writeFile(`${JSON.stringify(document)}\n`, 'utf8');
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, join(this.#directory, 'campaign.json'));
        const directory = await open(this.#directory, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
        return { kind: 'Acquired', campaignId };
      } finally {
        await lock.close();
        await unlink(join(this.#directory, 'campaign.lock')).catch(() => undefined);
      }
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async #read(): Promise<Type.Static<typeof campaignSchema> | undefined> {
    const path = join(this.#directory, 'campaign.json');
    const encoded = await readFile(path, 'utf8').catch(() => undefined);
    if (encoded === undefined) return undefined;
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
      throw new Error('Campaign custody is not private');
    }
    const parsed: unknown = JSON.parse(encoded);
    if (!Value.Check(campaignSchema, parsed)) throw new Error('Campaign custody is corrupt');
    return parsed;
  }
}
