import { Buffer } from 'node:buffer';

import {
  prepareEvidenceArtifact,
  prepareEvaluationVerifierBundle,
  type EvaluationVerifierBundle,
  type EvaluationVerifierBundleInput,
  type ProtectedEvaluationArtifact,
} from '@devrandom/protocol';

import { matchCesrPublicContract, type CesrPublicContract } from './cesr-public-contract.js';
import type { ProtectedCaseCustody } from './evaluation-conversations.js';

type PublicVerifierBinding = Omit<EvaluationVerifierBundleInput, 'protectedCase' | 'terminalCase'>;

export type CesrComparisonCasePreparation =
  | {
      readonly kind: 'Prepared';
      readonly bundle: EvaluationVerifierBundle;
      readonly protectedArtifacts: readonly [
        ProtectedEvaluationArtifact,
        ProtectedEvaluationArtifact,
        ProtectedEvaluationArtifact,
        ProtectedEvaluationArtifact,
      ];
    }
  | { readonly kind: 'Incomplete'; readonly reason: 'Entropy' | 'Custody' | 'Catalogue' };

/** A parent-only source of independent, non-enumerable CESR payload material. */
export interface FreshCesrPayloads {
  drawPayload(): Uint8Array;
}

type SealedCase = {
  readonly objectSaid: string;
  readonly stimulus: ProtectedEvaluationArtifact;
  readonly expected: ProtectedEvaluationArtifact;
};

async function sealCase(
  input: {
    readonly evaluationId: string;
    readonly segment: 0 | 1;
    readonly contract: CesrPublicContract;
    readonly first: string;
    readonly second: string;
  },
  custody: ProtectedCaseCustody,
): Promise<SealedCase | undefined> {
  const flat = {
    stimulus: `-AAY-_AAABAA${input.first}${input.second}`,
    receipts: [
      { version: 'Legacy', payload: input.first },
      { version: 'Legacy', payload: input.second },
    ],
  };
  const selected = input.contract === 'FlatGroups' ? flat : scopedCase(input);
  const stimulus = new TextEncoder().encode(selected.stimulus);
  const expected = new TextEncoder().encode(
    JSON.stringify({ kind: 'Parsed', receipts: selected.receipts }),
  );
  try {
    const identity = prepareEvidenceArtifact(stimulus, 'text/plain; charset=utf-8');
    if (identity.kind !== 'Prepared') return undefined;
    const objectSaid = identity.artifact.d;
    const first = await custody.seal({
      evaluationId: input.evaluationId,
      objectSaid,
      purpose: input.segment === 0 ? 'TrialHoldout' : 'TerminalCase',
      segment: input.segment,
      plaintext: stimulus,
    });
    if (first.kind !== 'Sealed') return undefined;
    const second = await custody.seal({
      evaluationId: input.evaluationId,
      objectSaid,
      purpose: 'OracleObservation',
      segment: input.segment,
      plaintext: expected,
    });
    return second.kind === 'Sealed'
      ? { objectSaid, stimulus: first.artifact, expected: second.artifact }
      : undefined;
  } catch {
    return undefined;
  } finally {
    stimulus.fill(0);
    expected.fill(0);
  }
}

/** Independent parent construction: hidden compositions vary only the fully disclosed grammar. */
function scopedCase(input: {
  readonly first: string;
  readonly second: string;
  readonly segment: 0 | 1;
}) {
  const frame = (body: string, large: boolean): string => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let count = body.length / 4;
    let digits = '';
    for (let index = 0; index < (large ? 5 : 2); index += 1) {
      digits = alphabet.charAt(count % 64) + digits;
      count = Math.floor(count / 64);
    }
    return `${large ? '--A' : '-A'}${digits}${body}`;
  };
  if (input.segment === 0) {
    const inherited = frame(input.first.repeat(373), true);
    const current = frame(`-_AAACAA${input.second}`, false);
    return {
      stimulus:
        frame(`-_AAABAA${inherited}${current}${input.first}`, true) + frame(input.second, false),
      receipts: [
        ...Array.from({ length: 373 }, () => ({ version: 'Legacy', payload: input.first })),
        { version: 'Current', payload: input.second },
        { version: 'Legacy', payload: input.first },
        { version: 'Current', payload: input.second },
      ],
    };
  }
  const legacy = frame(`-_AAABAA${frame(input.second.repeat(373), true)}`, true);
  return {
    stimulus: frame(`${input.first}${legacy}${input.first}`, true),
    receipts: [
      { version: 'Current', payload: input.first },
      ...Array.from({ length: 373 }, () => ({ version: 'Legacy', payload: input.second })),
      { version: 'Current', payload: input.first },
    ],
  };
}

/** E3 parent custody: fresh hidden trial and terminal cases are sealed before M is prepared. */
export async function sealCesrComparisonCases(
  input: PublicVerifierBinding,
  ports: { readonly custody: ProtectedCaseCustody } & FreshCesrPayloads,
): Promise<CesrComparisonCasePreparation> {
  const contract = matchCesrPublicContract(input.publicConditions);
  if (contract === undefined) return { kind: 'Incomplete', reason: 'Catalogue' };
  const material: Uint8Array[] = [];
  const payloads: string[] = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      const drawn = ports.drawPayload();
      if (!(drawn instanceof Uint8Array) || drawn.byteLength !== 32)
        return { kind: 'Incomplete', reason: 'Entropy' };
      material.push(drawn);
      const encoded = Buffer.from(drawn);
      const payload = `E${encoded.toString('base64url')}`;
      encoded.fill(0);
      if (payload.length !== 44 || payloads.includes(payload))
        return { kind: 'Incomplete', reason: 'Entropy' };
      payloads.push(payload);
    }
    const [first, second, third, fourth] = payloads;
    if (first === undefined || second === undefined || third === undefined || fourth === undefined)
      return { kind: 'Incomplete', reason: 'Entropy' };
    const protectedCase = await sealCase(
      { evaluationId: input.evaluationId, segment: 0, first, second, contract },
      ports.custody,
    );
    if (protectedCase === undefined) return { kind: 'Incomplete', reason: 'Custody' };
    const terminalCase = await sealCase(
      { evaluationId: input.evaluationId, segment: 1, first: third, second: fourth, contract },
      ports.custody,
    );
    if (terminalCase === undefined) return { kind: 'Incomplete', reason: 'Custody' };
    const prepared = prepareEvaluationVerifierBundle({ ...input, protectedCase, terminalCase });
    return prepared.kind === 'Prepared'
      ? {
          kind: 'Prepared',
          bundle: prepared.bundle,
          protectedArtifacts: [
            protectedCase.stimulus,
            protectedCase.expected,
            terminalCase.stimulus,
            terminalCase.expected,
          ],
        }
      : { kind: 'Incomplete', reason: 'Catalogue' };
  } catch {
    return { kind: 'Incomplete', reason: 'Entropy' };
  } finally {
    for (const bytes of material) bytes.fill(0);
  }
}
