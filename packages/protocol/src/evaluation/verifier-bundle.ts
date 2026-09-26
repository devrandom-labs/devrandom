import { Buffer } from 'node:buffer';

import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { decodeEvaluationManifest, type EvaluationManifest } from './manifest.js';
import {
  decodeProtectedEvaluationArtifact,
  protectedEvaluationArtifactSchema,
} from './protected-artifact.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});
const conditionId = Type.String({
  minLength: 1,
  maxLength: 96,
  pattern: '^[a-z][a-z0-9._-]*$',
});
const parsedObservation = Type.Object(
  {
    kind: Type.Literal('Parsed'),
    receipts: Type.Array(
      Type.Object(
        {
          version: Type.Union([Type.Literal('Legacy'), Type.Literal('Current')]),
          payload: said,
        },
        { additionalProperties: false },
      ),
      { maxItems: 1024 },
    ),
  },
  { additionalProperties: false },
);
const rejectedObservation = Type.Object(
  {
    kind: Type.Literal('Rejected'),
    error: Type.Union([
      Type.Literal('AnyRejection'),
      Type.Literal('InvalidFrame'),
      Type.Literal('InvalidPayload'),
      Type.Literal('UnsupportedVersion'),
    ]),
  },
  { additionalProperties: false },
);
export const cesrVerifierObservationSchema = Type.Union([parsedObservation, rejectedObservation]);
const encryptedCase = Type.Object(
  {
    objectSaid: said,
    stimulus: protectedEvaluationArtifactSchema,
    expected: protectedEvaluationArtifactSchema,
  },
  { additionalProperties: false },
);

/** A parent-only case catalogue. It contains ciphertext descriptors, never hidden plaintext. */
export const evaluationVerifierBundleInputSchema = Type.Object(
  {
    evaluationId: uuid,
    taskId: uuid,
    taskRevisionSaid: said,
    ownerAid: said,
    personalAgentAid: said,
    policySaid: said,
    executionProfileSaid: said,
    oracleAdapterDigest: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
    reviewedRecipeSaid: said,
    toolchainSaid: said,
    publicConditions: Type.Array(
      Type.Object(
        {
          id: conditionId,
          stimulusBase64Url: Type.String({
            minLength: 2,
            maxLength: 87_384,
            pattern: '^[A-Za-z0-9_-]+$',
          }),
          expected: cesrVerifierObservationSchema,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 32 },
    ),
    protectedCase: encryptedCase,
    terminalCase: encryptedCase,
  },
  { additionalProperties: false },
);
export const evaluationVerifierBundleSchema = Type.Object(
  {
    version: Type.Literal(1),
    d: said,
    kind: Type.Literal('EvaluationVerifierBundle'),
    ...evaluationVerifierBundleInputSchema.properties,
  },
  { additionalProperties: false },
);

export type EvaluationVerifierBundle = Type.Static<typeof evaluationVerifierBundleSchema>;
export type EvaluationVerifierBundleInput = Type.Static<typeof evaluationVerifierBundleInputSchema>;
export type EvaluationVerifierBundleRejection =
  | 'SchemaInvalid'
  | 'CaseScopeInvalid'
  | 'PublicConditionInvalid'
  | 'SaidMismatch'
  | 'SaidConstructionFailed';
export type EvaluationVerifierBundlePreparation =
  | { readonly kind: 'Prepared'; readonly bundle: EvaluationVerifierBundle }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationVerifierBundleRejection };
export type EvaluationVerifierBundleDecoding =
  | { readonly kind: 'Accepted'; readonly bundle: EvaluationVerifierBundle }
  | { readonly kind: 'Rejected'; readonly reason: EvaluationVerifierBundleRejection };
export type EvaluationVerifierBinding =
  | { readonly kind: 'Bound' }
  | { readonly kind: 'Rejected'; readonly reason: 'BundleInvalid' | 'ManifestMismatch' };
export const maximumEvaluationVerifierBundleBytes = 768 * 1024;

function validPublicConditions(input: EvaluationVerifierBundleInput): boolean {
  const identifiers = new Set<string>();
  for (const condition of input.publicConditions) {
    if (identifiers.has(condition.id)) return false;
    identifiers.add(condition.id);
    const bytes = Buffer.from(condition.stimulusBase64Url, 'base64url');
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > 64 * 1024 ||
      bytes.toString('base64url') !== condition.stimulusBase64Url
    )
      return false;
    try {
      if (!new TextDecoder('utf-8', { fatal: true }).decode(bytes).startsWith('-A')) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function validEncryptedCase(
  input: EvaluationVerifierBundleInput,
  which: 'protectedCase' | 'terminalCase',
): boolean {
  const item = input[which];
  const purpose = which === 'protectedCase' ? 'TrialHoldout' : 'TerminalCase';
  const segment = which === 'protectedCase' ? 0 : 1;
  return (
    decodeProtectedEvaluationArtifact(item.stimulus).kind === 'Accepted' &&
    decodeProtectedEvaluationArtifact(item.expected).kind === 'Accepted' &&
    item.stimulus.purpose === purpose &&
    item.expected.purpose === 'OracleObservation' &&
    item.stimulus.evaluationId === input.evaluationId &&
    item.expected.evaluationId === input.evaluationId &&
    item.stimulus.objectSaid === item.objectSaid &&
    item.expected.objectSaid === item.objectSaid &&
    item.stimulus.segment === segment &&
    item.expected.segment === segment &&
    item.stimulus.d !== item.expected.d
  );
}

function invalid(
  input: EvaluationVerifierBundleInput,
): EvaluationVerifierBundleRejection | undefined {
  if (
    !validEncryptedCase(input, 'protectedCase') ||
    !validEncryptedCase(input, 'terminalCase') ||
    input.protectedCase.objectSaid === input.terminalCase.objectSaid ||
    new Set([
      input.protectedCase.stimulus.d,
      input.protectedCase.expected.d,
      input.terminalCase.stimulus.d,
      input.terminalCase.expected.d,
    ]).size !== 4
  )
    return 'CaseScopeInvalid';
  if (!validPublicConditions(input)) return 'PublicConditionInvalid';
  return undefined;
}

export function prepareEvaluationVerifierBundle(
  input: unknown,
): EvaluationVerifierBundlePreparation {
  if (!Value.Check(evaluationVerifierBundleInputSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  const failure = invalid(input);
  if (failure !== undefined) return { kind: 'Rejected', reason: failure };
  try {
    const document: unknown = Saider.saidify({
      version: 1,
      d: '',
      kind: 'EvaluationVerifierBundle',
      ...structuredClone(input),
    })[1];
    return Value.Check(evaluationVerifierBundleSchema, document)
      ? { kind: 'Prepared', bundle: document }
      : { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeEvaluationVerifierBundle(input: unknown): EvaluationVerifierBundleDecoding {
  if (!Value.Check(evaluationVerifierBundleSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  const failure = invalid(input);
  if (failure !== undefined) return { kind: 'Rejected', reason: failure };
  try {
    return new Saider({ qb64: input.d }).verify(input, true, false)
      ? { kind: 'Accepted', bundle: structuredClone(input) }
      : { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
}

/** Exact JSON bytes are retained so server custody and local replay name the same bundle. */
export function encodeEvaluationVerifierBundle(
  bundle: EvaluationVerifierBundle,
): { readonly kind: 'Encoded'; readonly bytes: Uint8Array } | { readonly kind: 'Rejected' } {
  if (decodeEvaluationVerifierBundle(bundle).kind !== 'Accepted') return { kind: 'Rejected' };
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  return bytes.byteLength <= maximumEvaluationVerifierBundleBytes
    ? { kind: 'Encoded', bytes }
    : { kind: 'Rejected' };
}

export function decodeEvaluationVerifierBundleBytes(input: unknown):
  | {
      readonly kind: 'Accepted';
      readonly bundle: EvaluationVerifierBundle;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'Rejected' } {
  if (
    !(input instanceof Uint8Array) ||
    input.byteLength === 0 ||
    input.byteLength > maximumEvaluationVerifierBundleBytes
  )
    return { kind: 'Rejected' };
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input));
    const decoded = decodeEvaluationVerifierBundle(parsed);
    if (decoded.kind !== 'Accepted') return { kind: 'Rejected' };
    const encoded = encodeEvaluationVerifierBundle(decoded.bundle);
    if (encoded.kind !== 'Encoded' || !Buffer.from(input).equals(Buffer.from(encoded.bytes)))
      return { kind: 'Rejected' };
    return { kind: 'Accepted', bundle: decoded.bundle, bytes: Uint8Array.from(input) };
  } catch {
    return { kind: 'Rejected' };
  }
}

/** The local parent binds the exact case catalogue to acknowledged M before any worker. */
export function bindEvaluationVerifierBundle(
  bundle: EvaluationVerifierBundle,
  manifest: EvaluationManifest,
): EvaluationVerifierBinding {
  if (
    decodeEvaluationVerifierBundle(bundle).kind !== 'Accepted' ||
    decodeEvaluationManifest(manifest).kind !== 'Accepted'
  )
    return { kind: 'Rejected', reason: 'BundleInvalid' };
  if (
    bundle.d !== manifest.verifierSaid ||
    bundle.evaluationId !== manifest.evaluationId ||
    bundle.taskId !== manifest.taskId ||
    bundle.taskRevisionSaid !== manifest.taskRevisionSaid ||
    bundle.ownerAid !== manifest.ownerAid ||
    bundle.personalAgentAid !== manifest.personalAgentAid ||
    bundle.policySaid !== manifest.policySaid ||
    bundle.executionProfileSaid !== manifest.executionProfileSaid ||
    bundle.protectedCase.stimulus.d !== manifest.protectedCaseArtifactSaid ||
    bundle.terminalCase.stimulus.d !== manifest.finalCaseArtifactSaid ||
    manifest.heldOutCaseCount !== 1 ||
    bundle.publicConditions.length !== manifest.publicConditionIds.length ||
    bundle.publicConditions.some(
      (condition, index) => condition.id !== manifest.publicConditionIds[index],
    )
  )
    return { kind: 'Rejected', reason: 'ManifestMismatch' };
  return { kind: 'Bound' };
}
