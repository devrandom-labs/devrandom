import Type from 'typebox';

import { appendEvidenceBatchBodySchema } from './evidence-http.js';

const saidSchema = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const uuidV4Schema = Type.String({
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
});

/** Only original-incarnation bookkeeping after a calibration lease expires. */
export const terminalCalibrationReconciliationBodySchema = Type.Object(
  {
    version: Type.Literal(1),
    expected: Type.Object(
      {
        incarnationId: uuidV4Schema,
        runStartedSaid: saidSchema,
        acceptedThroughSequence: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
        chainHeadSaid: saidSchema,
      },
      { additionalProperties: false },
    ),
    body: appendEvidenceBatchBodySchema,
  },
  { additionalProperties: false },
);

export type TerminalCalibrationReconciliationBody = Type.Static<
  typeof terminalCalibrationReconciliationBodySchema
>;
