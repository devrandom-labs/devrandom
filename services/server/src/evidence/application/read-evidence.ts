import type { EvolutionSourceScope } from '@devrandom/domain';
import { exactEvidenceReadingSchema } from '@devrandom/protocol';
import type Type from 'typebox';
import Value from 'typebox/value';

export type ExactEvidenceReading = Type.Static<typeof exactEvidenceReadingSchema>;
export type EvidenceReadOutcome =
  | {
      readonly kind: 'Read';
      readonly bytes: Uint8Array;
      readonly totalBytes: number;
      readonly sourceSaid: string;
      readonly readReceiptSaid: string;
    }
  | { readonly kind: 'Denied' | 'NotFound' | 'Unavailable' };

/** Every nested read rechecks current Task/Mandate source rights. */
export interface EvidenceSourceScopes {
  inspect(input: {
    readonly ownerAid: string;
    readonly taskId: string;
    readonly sourceInventorySaid: string;
  }): Promise<
    | { readonly kind: 'Authorized'; readonly scope: EvolutionSourceScope }
    | { readonly kind: 'Denied' | 'Unavailable' }
  >;
}

export interface RawEvidenceReading {
  read(input: {
    readonly ownerAid: string;
    readonly query: ExactEvidenceReading;
    readonly scope: EvolutionSourceScope;
  }): Promise<EvidenceReadOutcome>;
}

export async function readEvidence(
  input: { readonly ownerAid: string; readonly query: unknown },
  dependencies: { readonly scope: EvidenceSourceScopes; readonly reading: RawEvidenceReading },
): Promise<EvidenceReadOutcome> {
  if (!Value.Check(exactEvidenceReadingSchema, input.query) || input.ownerAid.length === 0)
    return { kind: 'Denied' };
  const scope = await dependencies.scope.inspect({
    ownerAid: input.ownerAid,
    taskId: input.query.taskId,
    sourceInventorySaid: input.query.sourceInventorySaid,
  });
  if (scope.kind !== 'Authorized') return scope;
  if (scope.scope.ownerAid !== input.ownerAid || scope.scope.taskId !== input.query.taskId)
    return { kind: 'Denied' };
  return dependencies.reading.read({
    ownerAid: input.ownerAid,
    query: input.query,
    scope: scope.scope,
  });
}
