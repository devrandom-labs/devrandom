import type {
  MandateCredentialEvidence,
  MandateIssuerAnchor,
  MandateTelState,
  PromotionMandateInspection,
  ExactPromotionMandateInspection,
  TaskMandateInspection,
} from '@devrandom/domain';
import {
  decodePromotionMandateCredential,
  decodePromotionMandateCredentialV2,
  decodePromotionMandateCredentialV3,
  decodeTaskMandateCredential,
  decodeTaskMandateCredentialV2,
  promotionMandateSchemaSaid,
  promotionMandateV2SchemaSaid,
  promotionMandateV3SchemaSaid,
  promotionMandateV4SchemaSaid,
  promotionMandateV6SchemaSaid,
  promotionMandateV5SchemaSaid,
  promotionMandateV7SchemaSaid,
  promotionMandateV8SchemaSaid,
  promotionMandateV9SchemaSaid,
  promotionMandateV10SchemaSaid,
  promotionMandateV11SchemaSaid,
  taskMandateSchemaSaid,
  taskMandateV2SchemaSaid,
  taskMandateV3SchemaSaid,
  taskMandateV4SchemaSaid,
  taskMandateV5SchemaSaid,
  taskMandateV6SchemaSaid,
} from '@devrandom/protocol';
import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

import { IdentityFailure } from './identity-error.js';

const nonEmptyString = Type.String({ minLength: 1 });

const issuanceEventSchema = Type.Object(
  {
    d: nonEmptyString,
    t: Type.Literal('iss'),
    i: nonEmptyString,
    ri: nonEmptyString,
    s: Type.Literal('0'),
  },
  { additionalProperties: true },
);

const issuanceAnchorSchema = Type.Object(
  {
    d: nonEmptyString,
    i: nonEmptyString,
    a: Type.Array(
      Type.Object(
        { i: nonEmptyString, s: nonEmptyString, d: nonEmptyString },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: true },
);

const credentialRecordSchema = Type.Object(
  { sad: Type.Unknown(), iss: issuanceEventSchema, anc: issuanceAnchorSchema },
  { additionalProperties: true },
);

const credentialStateSchema = Type.Object(
  {
    i: nonEmptyString,
    ri: nonEmptyString,
    s: nonEmptyString,
    et: nonEmptyString,
    dt: Type.Optional(nonEmptyString),
  },
  { additionalProperties: true },
);

const keyEventsSchema = Type.Array(
  Type.Object({ ked: Type.Unknown() }, { additionalProperties: true }),
);

const resolvedSchemaDocument = Type.Object({ $id: nonEmptyString }, { additionalProperties: true });

export interface MandateCredentialEvidenceSources {
  readonly expectedCredentialSaid: string;
  readonly credential: unknown;
  readonly credentialState: unknown;
  readonly issuerKeyEvents: unknown;
  readonly resolvedSchema: unknown;
}

export type MandateInspection =
  | { readonly kind: 'TaskMandate'; readonly value: TaskMandateInspection }
  | { readonly kind: 'PromotionMandate'; readonly value: PromotionMandateInspection };

function invalidMandateEvidence(reason: string, cause?: unknown): never {
  throw new IdentityFailure(
    { kind: 'credential-invalid', reason: `Mandate credential evidence is invalid: ${reason}` },
    cause === undefined ? undefined : cause,
  );
}

function verifySaid(document: object, said: string, purpose: string, label = 'd'): void {
  try {
    if (!new Saider({ qb64: said }).verify(document, true, true, undefined, label)) {
      invalidMandateEvidence(`${purpose} is not bound by its SAID`);
    }
  } catch (cause) {
    if (cause instanceof IdentityFailure) {
      throw cause;
    }
    invalidMandateEvidence(`${purpose} has an invalid SAID`, cause);
  }
}

function telState(untrusted: unknown, credentialSaid: string, registryId: string): MandateTelState {
  if (!Value.Check(credentialStateSchema, untrusted)) {
    return { kind: 'IncompatibleCredentialState' };
  }
  if (untrusted.i !== credentialSaid || untrusted.ri !== registryId) {
    return { kind: 'IncompatibleCredentialState' };
  }
  if (untrusted.et === 'iss' && untrusted.s === '0') {
    return { kind: 'Issued' };
  }
  if (untrusted.et === 'rev' && untrusted.dt !== undefined) {
    return { kind: 'Revoked', revokedAt: untrusted.dt };
  }
  return { kind: 'IncompatibleCredentialState' };
}

function issuerAnchor(
  untrustedKeyEvents: unknown,
  anchor: Type.Static<typeof issuanceAnchorSchema>,
  issuerAid: string,
): MandateIssuerAnchor {
  if (!Value.Check(keyEventsSchema, untrustedKeyEvents)) {
    return invalidMandateEvidence('issuer KEL response is malformed');
  }
  if (anchor.i !== issuerAid) {
    return { kind: 'Mismatch', eventSaid: anchor.d };
  }
  for (const event of untrustedKeyEvents) {
    if (
      Value.Check(issuanceAnchorSchema, event.ked) &&
      event.ked.d === anchor.d &&
      event.ked.i === issuerAid
    ) {
      verifySaid(event.ked, event.ked.d, 'issuer KEL anchor event');
      return { kind: 'Anchored', eventSaid: anchor.d };
    }
  }
  return { kind: 'Missing' };
}

function cryptographicEvidence(
  sources: MandateCredentialEvidenceSources,
  credential: {
    readonly d: string;
    readonly i: string;
    readonly ri: string;
    readonly s: string;
    readonly a: { readonly d: string; readonly i: string; readonly dt: string };
  },
): MandateCredentialEvidence {
  if (!Value.Check(credentialRecordSchema, sources.credential)) {
    return invalidMandateEvidence('credential record is incomplete');
  }
  const record = sources.credential;
  if (credential.d !== sources.expectedCredentialSaid) {
    return invalidMandateEvidence('credential identity differs from the requested SAID');
  }
  const issuance = record.iss;
  verifySaid(issuance, issuance.d, 'credential issuance event');
  if (
    issuance.i !== credential.d ||
    issuance.ri !== credential.ri ||
    !record.anc.a.some(
      (seal) => seal.i === credential.d && seal.s === issuance.s && seal.d === issuance.d,
    )
  ) {
    return invalidMandateEvidence('issuance event and anchor do not bind the credential');
  }
  verifySaid(record.anc, record.anc.d, 'issuer anchor event');
  if (!Value.Check(resolvedSchemaDocument, sources.resolvedSchema)) {
    return invalidMandateEvidence('resolved schema is malformed');
  }
  verifySaid(sources.resolvedSchema, sources.resolvedSchema.$id, 'resolved mandate schema', '$id');
  if (sources.resolvedSchema.$id !== credential.s) {
    return invalidMandateEvidence('resolved mandate schema differs from credential schema');
  }
  return {
    credentialSaid: credential.d,
    attributeSaid: credential.a.d,
    issuerAid: credential.i,
    issueeAid: credential.a.i,
    registryId: credential.ri,
    schemaSaid: credential.s,
    issuedAt: credential.a.dt,
    credentialSaidBinding: { kind: 'Verified' },
    attributeSaidBinding: { kind: 'Verified' },
    schemaDocument: { kind: 'Resolved', schemaSaid: sources.resolvedSchema.$id },
    telState: telState(sources.credentialState, credential.d, credential.ri),
    issuerAnchor: issuerAnchor(sources.issuerKeyEvents, record.anc, credential.i),
  };
}

export function inspectTaskMandateCredentialEvidence(
  sources: MandateCredentialEvidenceSources,
): TaskMandateInspection {
  if (!Value.Check(credentialRecordSchema, sources.credential)) {
    return invalidMandateEvidence('credential record is incomplete');
  }
  const legacy = decodeTaskMandateCredential(sources.credential.sad);
  const decoding =
    legacy.kind === 'Accepted' ? legacy : decodeTaskMandateCredentialV2(sources.credential.sad);
  if (decoding.kind === 'Rejected') {
    return invalidMandateEvidence(`Task Mandate decoding failed: ${decoding.reason}`);
  }
  const { credential } = decoding;
  if (
    credential.s !== taskMandateSchemaSaid &&
    credential.s !== taskMandateV2SchemaSaid &&
    credential.s !== taskMandateV3SchemaSaid &&
    credential.s !== taskMandateV4SchemaSaid &&
    credential.s !== taskMandateV5SchemaSaid &&
    credential.s !== taskMandateV6SchemaSaid
  ) {
    return invalidMandateEvidence('Task Mandate schema differs from the pinned schema');
  }
  return {
    credential: cryptographicEvidence(sources, credential),
    authority: credential.a.authority,
    taskId: credential.a.taskId,
    taskRevisionSaid: credential.a.taskRevisionSaid,
    harnessLineageId: credential.a.harnessLineageId,
    repository: credential.a.repository,
    allowedCapabilities: credential.a.allowedCapabilities,
    budgets: credential.a.budgets,
    allowedEvolutionClasses: credential.a.allowedEvolutionClasses,
    notBefore: credential.a.notBefore,
    expiresAt: credential.a.expiresAt,
    ...('experience' in credential.a ? { experience: credential.a.experience } : {}),
  };
}

export function inspectPromotionMandateCredentialEvidence(
  sources: MandateCredentialEvidenceSources,
): PromotionMandateInspection {
  if (!Value.Check(credentialRecordSchema, sources.credential)) {
    return invalidMandateEvidence('credential record is incomplete');
  }
  const legacy = decodePromotionMandateCredential(sources.credential.sad);
  const v3 = decodePromotionMandateCredentialV3(sources.credential.sad);
  const decoding =
    legacy.kind === 'Accepted'
      ? legacy
      : (() => {
          const v2 = decodePromotionMandateCredentialV2(sources.credential.sad);
          return v2.kind === 'Accepted' ? v2 : v3;
        })();
  if (decoding.kind === 'Rejected') {
    return invalidMandateEvidence(`Promotion Mandate decoding failed: ${decoding.reason}`);
  }
  const { credential } = decoding;
  if (
    credential.s !== promotionMandateSchemaSaid &&
    credential.s !== promotionMandateV2SchemaSaid &&
    credential.s !== promotionMandateV3SchemaSaid &&
    credential.s !== promotionMandateV4SchemaSaid &&
    credential.s !== promotionMandateV6SchemaSaid &&
    credential.s !== promotionMandateV5SchemaSaid &&
    credential.s !== promotionMandateV7SchemaSaid &&
    credential.s !== promotionMandateV8SchemaSaid &&
    credential.s !== promotionMandateV9SchemaSaid &&
    credential.s !== promotionMandateV10SchemaSaid &&
    credential.s !== promotionMandateV11SchemaSaid
  ) {
    return invalidMandateEvidence('Promotion Mandate schema differs from the pinned schema');
  }
  return {
    credential: cryptographicEvidence(sources, credential),
    authority: credential.a.authority,
    taskId: credential.a.taskId,
    taskRevisionSaid: credential.a.taskRevisionSaid,
    harnessLineageId: credential.a.harnessLineageId,
    capabilityCeiling: credential.a.capabilityCeiling,
    budgetCeiling: credential.a.budgetCeiling,
    evolutionClassCeiling: credential.a.evolutionClassCeiling,
    requiredEvidenceClasses: credential.a.requiredEvidenceClasses,
    ...('experience' in credential.a ? { experience: credential.a.experience } : {}),
    ...(v3.kind === 'Accepted'
      ? {
          evaluationManifestSaid: v3.credential.a.evaluationManifestSaid,
          requiredMetrics: v3.credential.a.requiredMetrics,
          requiredChecks: v3.credential.a.requiredChecks,
          riskLimit: v3.credential.a.riskLimit,
        }
      : {}),
    notBefore: credential.a.notBefore,
    expiresAt: credential.a.expiresAt,
  };
}

export function inspectExactPromotionMandateCredentialEvidence(
  sources: MandateCredentialEvidenceSources,
): ExactPromotionMandateInspection {
  if (!Value.Check(credentialRecordSchema, sources.credential))
    return invalidMandateEvidence('credential record is incomplete');
  if (decodePromotionMandateCredentialV3(sources.credential.sad).kind !== 'Accepted')
    return invalidMandateEvidence('exact Promotion Mandate v3 decoding failed');
  const inspection = inspectPromotionMandateCredentialEvidence(sources);
  if (
    (inspection.credential.schemaSaid !== promotionMandateV3SchemaSaid &&
      inspection.credential.schemaSaid !== promotionMandateV5SchemaSaid &&
      inspection.credential.schemaSaid !== promotionMandateV7SchemaSaid &&
      inspection.credential.schemaSaid !== promotionMandateV9SchemaSaid) ||
    !('evaluationManifestSaid' in inspection) ||
    !('requiredMetrics' in inspection) ||
    !('requiredChecks' in inspection) ||
    !('riskLimit' in inspection)
  )
    return invalidMandateEvidence('exact Promotion Mandate v3 claims are absent');
  return inspection as ExactPromotionMandateInspection;
}

export function inspectMandateCredentialEvidence(
  sources: MandateCredentialEvidenceSources,
): MandateInspection {
  if (!Value.Check(credentialRecordSchema, sources.credential)) {
    return invalidMandateEvidence('credential record is incomplete');
  }
  const task = decodeTaskMandateCredential(sources.credential.sad);
  const taskV2 = decodeTaskMandateCredentialV2(sources.credential.sad);
  if (task.kind === 'Accepted' || taskV2.kind === 'Accepted') {
    return { kind: 'TaskMandate', value: inspectTaskMandateCredentialEvidence(sources) };
  }
  const promotion = decodePromotionMandateCredential(sources.credential.sad);
  const promotionV2 = decodePromotionMandateCredentialV2(sources.credential.sad);
  const promotionV3 = decodePromotionMandateCredentialV3(sources.credential.sad);
  if (
    promotion.kind === 'Accepted' ||
    promotionV2.kind === 'Accepted' ||
    promotionV3.kind === 'Accepted'
  ) {
    return {
      kind: 'PromotionMandate',
      value: inspectPromotionMandateCredentialEvidence(sources),
    };
  }
  return invalidMandateEvidence('credential is not an exact Task or Promotion Mandate');
}
