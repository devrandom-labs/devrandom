import { isDeepStrictEqual } from 'node:util';

import {
  bindEvaluationVerifierBundle,
  cesrVerifierObservationSchema,
  decodeEvaluationManifest,
  decodeProtectedEvaluationArtifact,
  prepareEvidenceArtifact,
  prepareTrialObservationEvidence,
  type EvaluationManifest,
  type EvaluationVerifierBundle,
  type ProtectedEvaluationArtifact,
  type TrialObservationEvidence,
} from '@devrandom/protocol';
import { observedPublicCase, type ProtectedCaseCustody } from '@devrandom/runtime';
import Value from 'typebox/value';

import { interpretNativeCesrReceiptRecord } from './native-cesr-receipt-record.js';

/** Only acknowledged local parent ciphertext may be reopened for a promotion check. */
export interface PromotionProtectedCiphertextReading {
  protectedArtifact(
    artifactSaid: string,
  ):
    | { readonly kind: 'Found'; readonly artifact: ProtectedEvaluationArtifact }
    | { readonly kind: 'Missing' | 'Corrupt' };
}

function decodePlaintext(plaintext: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown;
  } catch {
    return undefined;
  } finally {
    plaintext.fill(0);
  }
}

/** Re-evaluates one sealed trial from M's hidden oracle and the ACKed parent observation. */
export async function regradeProtectedCesrObservation(
  input: {
    readonly manifest: EvaluationManifest;
    readonly verifier: EvaluationVerifierBundle;
    readonly trial: TrialObservationEvidence;
  },
  ports: {
    readonly custody: Pick<ProtectedCaseCustody, 'open'>;
    readonly ciphertext: PromotionProtectedCiphertextReading;
  },
): Promise<
  { readonly kind: 'Verified'; readonly verdict: 'Pass' | 'Fail' } | { readonly kind: 'Incomplete' }
> {
  const { manifest, verifier, trial } = input;
  const disposition = trial.observation.disposition;
  const slot = trial.observation.slot;
  const protectedCase = verifier.protectedCase;
  if (
    decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
    bindEvaluationVerifierBundle(verifier, manifest).kind !== 'Bound' ||
    prepareTrialObservationEvidence(trial).kind !== 'Prepared' ||
    trial.evaluationId !== manifest.evaluationId ||
    trial.manifestSaid !== manifest.d ||
    trial.harnessRevisionSaid !==
      (slot.arm === 'H1TaskSearch' ? manifest.revisions.H1 : manifest.revisions[slot.arm]) ||
    !manifest.slots.some(
      (scheduled) =>
        scheduled.arm === slot.arm &&
        scheduled.repetition === slot.repetition &&
        scheduled.attempt === slot.attempt,
    ) ||
    verifier.protectedCase.expected.evaluationId !== manifest.evaluationId ||
    trial.protectedObservationSaid === protectedCase.expected.d
  )
    return { kind: 'Incomplete' };
  let found: ReturnType<PromotionProtectedCiphertextReading['protectedArtifact']>;
  try {
    found = ports.ciphertext.protectedArtifact(trial.protectedObservationSaid);
  } catch {
    return { kind: 'Incomplete' };
  }
  if (
    found.kind !== 'Found' ||
    found.artifact.d !== trial.protectedObservationSaid ||
    decodeProtectedEvaluationArtifact(found.artifact).kind !== 'Accepted' ||
    found.artifact.evaluationId !== manifest.evaluationId ||
    found.artifact.objectSaid !== protectedCase.objectSaid ||
    found.artifact.purpose !== 'OracleObservation' ||
    found.artifact.segment !== 0
  )
    return { kind: 'Incomplete' };
  try {
    const stimulus = await ports.custody.open({
      artifact: protectedCase.stimulus,
      evaluationId: manifest.evaluationId,
      objectSaid: protectedCase.objectSaid,
      purpose: 'TrialHoldout',
      segment: 0,
    });
    if (stimulus.kind !== 'Opened') return { kind: 'Incomplete' };
    const stimulusArtifact = prepareEvidenceArtifact(
      stimulus.plaintext,
      'text/plain; charset=utf-8',
    );
    stimulus.plaintext.fill(0);
    if (stimulusArtifact.kind !== 'Prepared') return { kind: 'Incomplete' };
    const expected = await ports.custody.open({
      artifact: protectedCase.expected,
      evaluationId: manifest.evaluationId,
      objectSaid: protectedCase.objectSaid,
      purpose: 'OracleObservation',
      segment: 0,
    });
    if (expected.kind !== 'Opened') return { kind: 'Incomplete' };
    const oracle: unknown = decodePlaintext(expected.plaintext);
    if (
      !Value.Check(cesrVerifierObservationSchema, oracle) ||
      (oracle.kind === 'Rejected' && oracle.error === 'AnyRejection')
    )
      return { kind: 'Incomplete' };
    const observed = await ports.custody.open({
      artifact: found.artifact,
      evaluationId: manifest.evaluationId,
      objectSaid: protectedCase.objectSaid,
      purpose: 'OracleObservation',
      segment: 0,
    });
    if (observed.kind !== 'Opened') return { kind: 'Incomplete' };
    const record: unknown = decodePlaintext(observed.plaintext);
    const interpreted = interpretNativeCesrReceiptRecord(record, {
      caseScope: 'Protected',
      executableSaid: disposition.artifactSaid,
      stimulusSaid: stimulusArtifact.artifact.d,
    });
    if (interpreted.kind !== 'Interpreted') return { kind: 'Incomplete' };
    const passed = observedPublicCase(oracle, interpreted.observation);
    if (passed === undefined) return { kind: 'Incomplete' };
    const verdict = passed ? 'Pass' : 'Fail';
    if (
      verdict !== trial.protectedVerdict ||
      !isDeepStrictEqual(
        disposition.heldOutConditionIds,
        verdict === 'Pass' ? [protectedCase.objectSaid] : [],
      )
    )
      return { kind: 'Incomplete' };
    return { kind: 'Verified', verdict };
  } catch {
    return { kind: 'Incomplete' };
  }
}
