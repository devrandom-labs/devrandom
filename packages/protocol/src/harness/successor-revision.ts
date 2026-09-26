import { Saider } from 'signify-ts';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const common = {
  parentRevisionSaid: said,
  h0Said: said,
  taskRevisionSaid: said,
  sourceInventorySaid: said,
  executionProfileSaid: said,
  configurationArtifactSaid: said,
};
const instruction = Type.Object(
  { kind: Type.Literal('Instruction') },
  { additionalProperties: false },
);
const reviewedWorkflow = Type.Object(
  {
    kind: Type.Literal('ReviewedWorkflow'),
    reviewedImplementationSaid: said,
    publicReplayReceiptSaid: said,
  },
  { additionalProperties: false },
);
const contextSelection = Type.Object(
  {
    kind: Type.Literal('ContextSelection'),
    reviewedImplementationSaid: said,
    publicReplayReceiptSaid: said,
  },
  { additionalProperties: false },
);

/** The variant admits exactly one treatment; all H1 authority remains inherited. */
export const successorHarnessRevisionInputSchema = Type.Union([
  Type.Object(
    { ...common, arm: Type.Literal('C1'), treatment: instruction },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...common, arm: Type.Literal('C2'), treatment: reviewedWorkflow },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...common, arm: Type.Literal('C3'), treatment: contextSelection },
    { additionalProperties: false },
  ),
]);

const documentPrefix = {
  version: Type.Literal(1),
  d: said,
  kind: Type.Literal('ReviewedSuccessor'),
};
export const successorHarnessRevisionSchema = Type.Union([
  Type.Object(
    { ...documentPrefix, ...common, arm: Type.Literal('C1'), treatment: instruction },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...documentPrefix, ...common, arm: Type.Literal('C2'), treatment: reviewedWorkflow },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...documentPrefix, ...common, arm: Type.Literal('C3'), treatment: contextSelection },
    { additionalProperties: false },
  ),
]);

export type SuccessorHarnessRevisionInput = Type.Static<typeof successorHarnessRevisionInputSchema>;
export type SuccessorHarnessRevision = Type.Static<typeof successorHarnessRevisionSchema>;
export type SuccessorHarnessRevisionRejection =
  'SchemaInvalid' | 'NonCanonical' | 'SaidMismatch' | 'SaidConstructionFailed';
export type SuccessorHarnessRevisionPreparation =
  | { readonly kind: 'Prepared'; readonly revision: SuccessorHarnessRevision }
  | { readonly kind: 'Rejected'; readonly reason: SuccessorHarnessRevisionRejection };
export type SuccessorHarnessRevisionDecoding =
  | { readonly kind: 'Accepted'; readonly revision: SuccessorHarnessRevision }
  | { readonly kind: 'Rejected'; readonly reason: SuccessorHarnessRevisionRejection };

function document(input: SuccessorHarnessRevisionInput, d: string) {
  return {
    version: 1 as const,
    d,
    kind: 'ReviewedSuccessor' as const,
    parentRevisionSaid: input.parentRevisionSaid,
    arm: input.arm,
    h0Said: input.h0Said,
    taskRevisionSaid: input.taskRevisionSaid,
    sourceInventorySaid: input.sourceInventorySaid,
    executionProfileSaid: input.executionProfileSaid,
    configurationArtifactSaid: input.configurationArtifactSaid,
    treatment: input.treatment,
  };
}

function inputOf(revision: SuccessorHarnessRevision): SuccessorHarnessRevisionInput {
  const input = {
    parentRevisionSaid: revision.parentRevisionSaid,
    arm: revision.arm,
    h0Said: revision.h0Said,
    taskRevisionSaid: revision.taskRevisionSaid,
    sourceInventorySaid: revision.sourceInventorySaid,
    executionProfileSaid: revision.executionProfileSaid,
    configurationArtifactSaid: revision.configurationArtifactSaid,
    treatment: revision.treatment,
  };
  if (!Value.Check(successorHarnessRevisionInputSchema, input))
    throw new Error('Accepted successor revision lost its treatment variant');
  return input;
}

export function prepareSuccessorHarnessRevision(
  input: unknown,
): SuccessorHarnessRevisionPreparation {
  if (!Value.Check(successorHarnessRevisionInputSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  try {
    const saidified: unknown = Saider.saidify(document(input, ''))[1];
    return Value.Check(successorHarnessRevisionSchema, saidified)
      ? { kind: 'Prepared', revision: saidified }
      : { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidConstructionFailed' };
  }
}

export function decodeSuccessorHarnessRevision(input: unknown): SuccessorHarnessRevisionDecoding {
  if (!Value.Check(successorHarnessRevisionSchema, input))
    return { kind: 'Rejected', reason: 'SchemaInvalid' };
  if (JSON.stringify(input) !== JSON.stringify(document(inputOf(input), input.d)))
    return { kind: 'Rejected', reason: 'NonCanonical' };
  try {
    if (!new Saider({ qb64: input.d }).verify(input, true, false))
      return { kind: 'Rejected', reason: 'SaidMismatch' };
  } catch {
    return { kind: 'Rejected', reason: 'SaidMismatch' };
  }
  return { kind: 'Accepted', revision: structuredClone(input) };
}
