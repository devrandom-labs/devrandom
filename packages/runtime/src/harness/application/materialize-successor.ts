import {
  decodeBaselineHarnessRevision,
  decodeEvidenceArtifact,
  decodeSuccessorHarnessRevision,
  type BaselineHarnessRevision,
  type EvidenceArtifact,
  type SuccessorHarnessRevision,
} from '@devrandom/protocol';

const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const maximumH1Bytes = 512 * 1_024;
const maximumSuccessorBytes = 16 * 1_024;
const maximumConfigurationBytes = 32 * 1_024;
const maximumImplementationBytes = 128 * 1_024;
const maximumReplayBytes = 32 * 1_024;

export interface SuccessorMaterializationBinding {
  readonly parentRevisionSaid: string;
  readonly arm: 'C1' | 'C2' | 'C3';
  readonly h0Said: string;
  readonly taskRevisionSaid: string;
  readonly sourceInventorySaid: string;
  readonly executionProfileSaid: string;
}

export interface ExactTreatmentArtifact {
  readonly artifact: EvidenceArtifact;
  readonly bytes: Uint8Array;
}

/** Only the trusted parent can approve reviewed configuration and executable catalogue bytes. */
export interface SuccessorTreatmentReview {
  review(input: {
    readonly binding: SuccessorMaterializationBinding;
    readonly h1: BaselineHarnessRevision;
    readonly successorRevisionSaid: string;
    readonly configurationArtifactSaid: string;
    readonly configurationBytes: Uint8Array;
    readonly reviewedImplementationSaid?: string;
    readonly reviewedImplementationBytes?: Uint8Array;
  }): Promise<
    | {
        readonly kind: 'Reviewed';
        readonly binding: SuccessorMaterializationBinding;
        readonly successorRevisionSaid: string;
        readonly configurationArtifactSaid: string;
        readonly reviewedImplementationSaid?: string;
      }
    | { readonly kind: 'Rejected' }
  >;
}

/** A raw replay receipt is not a causal verdict; this parent capability verifies its contents. */
export interface SuccessorPublicReplay {
  verify(input: {
    readonly h0Said: string;
    readonly sourceInventorySaid: string;
    readonly arm: 'C2' | 'C3';
    readonly successorRevisionSaid: string;
    readonly configurationArtifactSaid: string;
    readonly reviewedImplementationSaid: string;
    readonly receiptArtifactSaid: string;
    readonly receiptBytes: Uint8Array;
  }): Promise<
    | {
        readonly kind: 'Confirmed';
        readonly h0Said: string;
        readonly sourceInventorySaid: string;
        readonly arm: 'C2' | 'C3';
        readonly successorRevisionSaid: string;
        readonly configurationArtifactSaid: string;
        readonly reviewedImplementationSaid: string;
        readonly receiptArtifactSaid: string;
      }
    | { readonly kind: 'Rejected' }
  >;
}

export interface ExecutableSuccessorDescriptor {
  /** H1 is copied unchanged; authority, tools, model, budgets and verifier stay inherited. */
  readonly h1: BaselineHarnessRevision;
  readonly successorRevisionSaid: string;
  readonly binding: SuccessorMaterializationBinding;
  readonly treatment: SuccessorHarnessRevision['treatment'];
  readonly configuration: EvidenceArtifact;
  readonly implementation?: EvidenceArtifact;
  readonly replay?: EvidenceArtifact;
}

export type SuccessorMaterialization =
  | { readonly kind: 'Materialized'; readonly descriptor: ExecutableSuccessorDescriptor }
  | {
      readonly kind: 'Blocked';
      readonly reason:
        'H1' | 'Successor' | 'Binding' | 'Configuration' | 'Implementation' | 'Replay' | 'Review';
    };

function canonicalJson(bytes: Uint8Array, maximumBytes: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > maximumBytes)
    return undefined;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return JSON.stringify(value) === text ? value : undefined;
  } catch {
    return undefined;
  }
}

function configurationMatches(
  value: unknown,
  arm: SuccessorMaterializationBinding['arm'],
): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!('version' in value) || !('arm' in value) || value.version !== 1 || value.arm !== arm)
    return false;
  return ![
    'authority',
    'activeTools',
    'modelCompatibility',
    'budgetCeilings',
    'toolGateway',
    'verifier',
    'winner',
    'score',
  ].some((field) => field in value);
}

function exactArtifact(
  envelope: ExactTreatmentArtifact | undefined,
  expectedSaid: string,
  maximumBytes: number,
  mediaType: EvidenceArtifact['mediaType'],
): envelope is ExactTreatmentArtifact {
  return (
    envelope !== undefined &&
    envelope.artifact.d === expectedSaid &&
    envelope.artifact.mediaType === mediaType &&
    envelope.bytes.byteLength > 0 &&
    envelope.bytes.byteLength <= maximumBytes &&
    decodeEvidenceArtifact(envelope.artifact, envelope.bytes).kind === 'Accepted'
  );
}

function sameBinding(
  left: SuccessorMaterializationBinding,
  right: SuccessorMaterializationBinding,
): boolean {
  return (
    left.parentRevisionSaid === right.parentRevisionSaid &&
    left.arm === right.arm &&
    left.h0Said === right.h0Said &&
    left.taskRevisionSaid === right.taskRevisionSaid &&
    left.sourceInventorySaid === right.sourceInventorySaid &&
    left.executionProfileSaid === right.executionProfileSaid
  );
}

function frozen<Value>(value: Value): Value {
  if (typeof value === 'object' && value !== null) {
    for (const key of Reflect.ownKeys(value)) frozen(Reflect.get(value, key) as unknown);
    Object.freeze(value);
  }
  return value;
}

/** Harness application gate: materialize one reviewed delta without modifying H1. */
export async function materializeSuccessor(
  input: {
    readonly expected: SuccessorMaterializationBinding;
    readonly h1Bytes: Uint8Array;
    readonly successorBytes: Uint8Array;
    readonly configuration: ExactTreatmentArtifact;
    readonly implementation?: ExactTreatmentArtifact | undefined;
    readonly replay?: ExactTreatmentArtifact | undefined;
  },
  ports: {
    readonly treatmentReview: SuccessorTreatmentReview;
    readonly publicReplay: SuccessorPublicReplay;
  },
): Promise<SuccessorMaterialization> {
  const expected = frozen(structuredClone(input.expected));
  const configuration = {
    artifact: structuredClone(input.configuration.artifact),
    bytes: Uint8Array.from(input.configuration.bytes),
  };
  const implementation =
    input.implementation === undefined
      ? undefined
      : {
          artifact: structuredClone(input.implementation.artifact),
          bytes: Uint8Array.from(input.implementation.bytes),
        };
  const replayArtifact =
    input.replay === undefined
      ? undefined
      : {
          artifact: structuredClone(input.replay.artifact),
          bytes: Uint8Array.from(input.replay.bytes),
        };
  const h1Raw = canonicalJson(Uint8Array.from(input.h1Bytes), maximumH1Bytes);
  const h1Decoded = decodeBaselineHarnessRevision(h1Raw);
  if (h1Decoded.kind !== 'Accepted' || h1Decoded.revision.d !== expected.parentRevisionSaid)
    return { kind: 'Blocked', reason: 'H1' };
  const successorRaw = canonicalJson(Uint8Array.from(input.successorBytes), maximumSuccessorBytes);
  const successorDecoded = decodeSuccessorHarnessRevision(successorRaw);
  if (successorDecoded.kind !== 'Accepted') return { kind: 'Blocked', reason: 'Successor' };
  const h1 = frozen(h1Decoded.revision);
  const successor = successorDecoded.revision;
  if (
    !said.test(expected.h0Said) ||
    !said.test(expected.sourceInventorySaid) ||
    !said.test(expected.executionProfileSaid) ||
    !sameBinding(expected, successor) ||
    h1.task.revisionSaid !== expected.taskRevisionSaid
  )
    return { kind: 'Blocked', reason: 'Binding' };
  if (
    !exactArtifact(
      configuration,
      successor.configurationArtifactSaid,
      maximumConfigurationBytes,
      'application/json',
    ) ||
    !configurationMatches(
      canonicalJson(configuration.bytes, maximumConfigurationBytes),
      successor.arm,
    )
  )
    return { kind: 'Blocked', reason: 'Configuration' };

  let reviewedImplementationSaid: string | undefined;
  let publicReplayReceiptSaid: string | undefined;
  if (successor.arm === 'C1') {
    if (implementation !== undefined || replayArtifact !== undefined)
      return { kind: 'Blocked', reason: 'Implementation' };
  } else {
    reviewedImplementationSaid = successor.treatment.reviewedImplementationSaid;
    publicReplayReceiptSaid = successor.treatment.publicReplayReceiptSaid;
    if (
      !exactArtifact(
        implementation,
        reviewedImplementationSaid,
        maximumImplementationBytes,
        'application/octet-stream',
      )
    )
      return { kind: 'Blocked', reason: 'Implementation' };
    if (
      !exactArtifact(
        replayArtifact,
        publicReplayReceiptSaid,
        maximumReplayBytes,
        'application/json',
      ) ||
      canonicalJson(replayArtifact.bytes, maximumReplayBytes) === undefined
    )
      return { kind: 'Blocked', reason: 'Replay' };
  }

  let review: Awaited<ReturnType<SuccessorTreatmentReview['review']>>;
  try {
    review = await ports.treatmentReview.review({
      binding: expected,
      h1,
      successorRevisionSaid: successor.d,
      configurationArtifactSaid: configuration.artifact.d,
      configurationBytes: Uint8Array.from(configuration.bytes),
      ...(reviewedImplementationSaid === undefined ? {} : { reviewedImplementationSaid }),
      ...(implementation === undefined
        ? {}
        : { reviewedImplementationBytes: Uint8Array.from(implementation.bytes) }),
    });
  } catch {
    return { kind: 'Blocked', reason: 'Review' };
  }
  if (
    review.kind !== 'Reviewed' ||
    !sameBinding(review.binding, expected) ||
    review.successorRevisionSaid !== successor.d ||
    review.configurationArtifactSaid !== configuration.artifact.d ||
    review.reviewedImplementationSaid !== reviewedImplementationSaid
  )
    return { kind: 'Blocked', reason: 'Review' };

  if (successor.arm !== 'C1') {
    if (
      replayArtifact === undefined ||
      publicReplayReceiptSaid === undefined ||
      reviewedImplementationSaid === undefined
    )
      return { kind: 'Blocked', reason: 'Replay' };
    let replay: Awaited<ReturnType<SuccessorPublicReplay['verify']>>;
    try {
      replay = await ports.publicReplay.verify({
        h0Said: expected.h0Said,
        sourceInventorySaid: expected.sourceInventorySaid,
        arm: successor.arm,
        successorRevisionSaid: successor.d,
        configurationArtifactSaid: configuration.artifact.d,
        reviewedImplementationSaid,
        receiptArtifactSaid: replayArtifact.artifact.d,
        receiptBytes: Uint8Array.from(replayArtifact.bytes),
      });
    } catch {
      return { kind: 'Blocked', reason: 'Replay' };
    }
    if (
      replay.kind !== 'Confirmed' ||
      replay.h0Said !== expected.h0Said ||
      replay.sourceInventorySaid !== expected.sourceInventorySaid ||
      replay.arm !== successor.arm ||
      replay.successorRevisionSaid !== successor.d ||
      replay.configurationArtifactSaid !== configuration.artifact.d ||
      replay.reviewedImplementationSaid !== reviewedImplementationSaid ||
      replay.receiptArtifactSaid !== publicReplayReceiptSaid
    )
      return { kind: 'Blocked', reason: 'Replay' };
  }

  return {
    kind: 'Materialized',
    descriptor: frozen({
      h1,
      successorRevisionSaid: successor.d,
      binding: expected,
      treatment: structuredClone(successor.treatment),
      configuration: configuration.artifact,
      ...(implementation === undefined ? {} : { implementation: implementation.artifact }),
      ...(replayArtifact === undefined ? {} : { replay: replayArtifact.artifact }),
    }),
  };
}
