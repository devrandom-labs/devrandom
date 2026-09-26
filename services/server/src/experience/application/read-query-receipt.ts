import type { EvolutionSourceScope } from '@devrandom/domain';
import type { EvidenceArtifact } from '@devrandom/protocol';

import type { ExperienceScopes } from './retrieve-experience.js';

export interface ExperienceQueryReceiptReading {
  read(input: {
    readonly ownerAid: string;
    readonly taskId: string;
    readonly sourceInventorySaid: string;
    readonly receiptSaid: string;
    readonly offset: number;
    readonly maximumBytes: number;
    readonly scope: EvolutionSourceScope;
  }): Promise<ExperienceQueryReceiptReadOutcome>;
}

export type ExperienceQueryReceiptReadOutcome =
  | {
      readonly kind: 'Read';
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
      readonly totalBytes: number;
      readonly offset: number;
    }
  | { readonly kind: 'Denied' | 'Unavailable' };

const said = /^[A-Z][A-Za-z0-9_-]{43}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Current Task/Mandate rights are inspected on every exact receipt read. */
export async function readExperienceQueryReceipt(
  input: {
    readonly ownerAid: string;
    readonly taskId: string;
    readonly sourceInventorySaid: string;
    readonly receiptSaid: string;
    readonly offset: number;
    readonly maximumBytes: number;
  },
  dependencies: {
    readonly scopes: ExperienceScopes;
    readonly receipts: ExperienceQueryReceiptReading;
  },
): Promise<ExperienceQueryReceiptReadOutcome> {
  if (
    !said.test(input.ownerAid) ||
    !uuid.test(input.taskId) ||
    !said.test(input.sourceInventorySaid) ||
    !said.test(input.receiptSaid) ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > 512 * 1024 ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 1 ||
    input.maximumBytes > 32 * 1024
  )
    return { kind: 'Denied' };
  const authorization = await dependencies.scopes.inspect({
    ownerAid: input.ownerAid,
    taskId: input.taskId,
    sourceInventorySaid: input.sourceInventorySaid,
  });
  if (authorization.kind !== 'Authorized') return authorization;
  if (
    authorization.scope.ownerAid !== input.ownerAid ||
    authorization.scope.taskId !== input.taskId ||
    authorization.scope.mandate.kind !== 'AuthorizedExperience'
  )
    return { kind: 'Denied' };
  return dependencies.receipts.read({ ...input, scope: authorization.scope });
}
