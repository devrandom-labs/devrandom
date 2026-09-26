import Type from 'typebox';
import { terminalCalibrationReconciliationBodySchema } from './terminal-reconciliation-http.js';

/** Accounting only: closes an expired, proven no-effects incarnation before a new process. */
export const runtimeRecoveryReconciliationBodySchema = Type.Object(
  terminalCalibrationReconciliationBodySchema.properties,
  { additionalProperties: false },
);
export type RuntimeRecoveryReconciliationBody = Type.Static<
  typeof runtimeRecoveryReconciliationBodySchema
>;
