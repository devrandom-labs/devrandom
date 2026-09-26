import Type from 'typebox';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuid = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

/** Owner-scoped initial specialization or signed committed activation, never a pending decision. */
const binding = {
  version: Type.Literal(1),
  taskId: uuid,
  taskRevisionSaid: said,
  harnessLineageId: uuid,
  activeRevisionSaid: said,
};

export const activeHarnessPointerSchema = Type.Union([
  Type.Object(
    { ...binding, kind: Type.Literal('Initial'), pointerVersion: Type.Literal(1) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...binding,
      kind: Type.Literal('Committed'),
      pointerVersion: Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }),
      commandId: uuid,
      decisionReceiptSaid: said,
      disposition: Type.Union([Type.Literal('Activated'), Type.Literal('Retained')]),
    },
    { additionalProperties: false },
  ),
]);

export type ActiveHarnessPointer = Type.Static<typeof activeHarnessPointerSchema>;
