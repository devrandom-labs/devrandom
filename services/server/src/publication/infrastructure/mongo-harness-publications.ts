import { MongoServerError, type Collection, type Db, type MongoClient } from 'mongodb';
import {
  decodeHarnessPackage,
  publishedHarnessSchema,
  type PublishedHarness,
} from '@devrandom/protocol';
import Value from 'typebox/value';
import type { HarnessPublicationStorage } from '../application/publish-harness.js';
interface PackageDocument {
  readonly _id: string;
  readonly published: PublishedHarness;
  readonly ownerAid: string;
}
interface PublicationCommandDocument {
  readonly _id: string;
  readonly fingerprint: string;
  readonly packageSaid: string;
}
interface PublicationBudgetDocument {
  readonly _id: string;
  readonly count: number;
  readonly bytes: number;
}
/** The public collection contains only sanitized signed packages. Command custody and bounded owner counters remain private. */
export class MongoHarnessPublications implements HarnessPublicationStorage {
  readonly #client: MongoClient;
  readonly #packages: Collection<PackageDocument>;
  readonly #commands: Collection<PublicationCommandDocument>;
  readonly #budgets: Collection<PublicationBudgetDocument>;
  constructor(client: MongoClient, database: Db) {
    this.#client = client;
    this.#packages = database.collection('harnessPublications');
    this.#commands = database.collection('harnessPublicationCommands');
    this.#budgets = database.collection('harnessPublicationBudgets');
  }
  async publish(
    input: Parameters<HarnessPublicationStorage['publish']>[0],
  ): ReturnType<HarnessPublicationStorage['publish']> {
    const session = this.#client.startSession();
    try {
      return await session.withTransaction(async () => {
        const key = `${input.ownerAid}:${input.commandId}`;
        const previous = await this.#commands.findOne({ _id: key }, { session });
        if (previous !== null)
          return previous.fingerprint === input.fingerprint
            ? { kind: 'AlreadyPublished' as const, packageSaid: previous.packageSaid }
            : { kind: 'Conflict' as const };
        const existing = await this.#packages.findOne(
          { _id: input.published.package.d },
          { session },
        );
        if (
          existing !== null &&
          (existing.ownerAid !== input.ownerAid ||
            JSON.stringify(existing.published) !== JSON.stringify(input.published))
        )
          return { kind: 'Conflict' as const };
        const packageBytes = Buffer.byteLength(JSON.stringify(input.published), 'utf8');
        if (packageBytes > 96 * 1024) return { kind: 'Rejected' as const };
        // Every new command consumes bounded durable custody, including aliases of an existing package.
        const bytes = (existing === null ? packageBytes : 0) + 1024;
        await this.#budgets.updateOne(
          { _id: input.ownerAid },
          { $setOnInsert: { count: 0, bytes: 0 } },
          { upsert: true, session },
        );
        const budget = await this.#budgets.updateOne(
          { _id: input.ownerAid, count: { $lt: 128 }, bytes: { $lte: 8 * 1024 * 1024 - bytes } },
          { $inc: { count: 1, bytes } },
          { session },
        );
        if (budget.modifiedCount !== 1) return { kind: 'Rejected' as const };
        if (existing === null) {
          await this.#packages.insertOne(
            {
              _id: input.published.package.d,
              ownerAid: input.ownerAid,
              published: input.published,
            },
            { session },
          );
        }
        await this.#commands.insertOne(
          { _id: key, fingerprint: input.fingerprint, packageSaid: input.published.package.d },
          { session },
        );
        return {
          kind: existing === null ? ('Published' as const) : ('AlreadyPublished' as const),
          packageSaid: input.published.package.d,
        };
      });
    } catch (error) {
      return {
        kind:
          error instanceof MongoServerError && error.code === 11000 ? 'Conflict' : 'Unavailable',
      };
    } finally {
      await session.endSession();
    }
  }
  async read(packageSaid: string): ReturnType<HarnessPublicationStorage['read']> {
    try {
      const found = await this.#packages.findOne({ _id: packageSaid });
      if (found === null) return { kind: 'Absent' };
      return Value.Check(publishedHarnessSchema, found.published) &&
        decodeHarnessPackage(found.published.package).kind === 'Accepted' &&
        found.published.package.d === packageSaid
        ? { kind: 'Read', published: found.published }
        : { kind: 'Unavailable' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
