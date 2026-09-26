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
import Type from 'typebox';
import Value from 'typebox/value';

/** Only acknowledged local parent ciphertext may be reopened for a promotion check. */
export interface PromotionProtectedCiphertextReading {
  protectedArtifact(
    artifactSaid: string,
  ):
    | { readonly kind: 'Found'; readonly artifact: ProtectedEvaluationArtifact }
    | { readonly kind: 'Missing' | 'Corrupt' };
}

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const observationRecord = Type.Object(
  {
    executableSaid: said,
    stimulusSaid: said,
    caseScope: Type.Literal('Protected'),
    observation: cesrVerifierObservationSchema,
    stdout: Type.String({ maxLength: 512 * 1024 }),
    effectiveLimitsDigest: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  },
  { additionalProperties: false },
);

function parseNativeStdout(stdout: string): unknown {
  const text = stdout.trimEnd();
  if (text.startsWith('DV1|P|') && !text.includes('\n')) {
    const raw = text.slice(6);
    const receipts =
      raw === ''
        ? []
        : raw.split(',').map((part) => {
            const fields = part.split(':');
            const version = fields[0];
            const payload = fields[1];
            if (
              fields.length !== 2 ||
              (version !== 'Legacy' && version !== 'Current') ||
              payload === undefined ||
              !/^[A-Z][A-Za-z0-9_-]{43}$/u.test(payload)
            )
              throw new Error('invalid native receipt');
            return { version, payload };
          });
    return { kind: 'Parsed', receipts };
  }
  const rejected = /^DV1\|R\|(InvalidFrame|InvalidPayload|UnsupportedVersion)$/u.exec(text);
  if (rejected?.[1] !== undefined) return { kind: 'Rejected', error: rejected[1] };
  return undefined;
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
    if (
      !Value.Check(observationRecord, record) ||
      record.executableSaid !== disposition.artifactSaid ||
      record.stimulusSaid !== stimulusArtifact.artifact.d ||
      !isDeepStrictEqual(parseNativeStdout(record.stdout), record.observation)
    )
      return { kind: 'Incomplete' };
    const passed = observedPublicCase(oracle, record.observation);
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
