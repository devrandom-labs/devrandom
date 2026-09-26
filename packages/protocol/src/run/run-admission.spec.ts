import { describe, expect, it } from 'vitest';

import { taskBudgetCeilings } from '../task/task-command.js';
import {
  decodeRunAdmissionPayload,
  runAdmissionCommandFingerprint,
  runAdmissionExchangeRoute,
  type RunAdmissionCommand,
  type RunAdmissionPayload,
} from './run-admission.js';

const commandId = '29222878-e689-4f3b-b2a7-976f5ea38ba8';
const said = (character: string) => `E${character.repeat(43)}`;

const payload: RunAdmissionPayload = {
  version: 1,
  kind: 'RunAdmission',
  commandId,
  taskId: '10b6ea52-bda9-4fe5-b8e7-d2c3e59b618e',
  taskRevisionSaid: said('a'),
  harnessLineageId: '7059b6fc-a9e5-4c6b-b7c7-c7612ae9111c',
  harnessRevisionSaid: said('b'),
  taskMandateSaid: said('c'),
  governorAid: said('d'),
  promotionMandateSaid: said('e'),
  purpose: {
    kind: 'PreparedCompatibilityCalibration',
    campaignId: '9f2cb6f3-e087-4d54-bdd7-b84dc4c7ee33',
    ordinal: 1,
  },
  repository: { objectFormat: 'sha1', commit: 'f'.repeat(40), tree: '1'.repeat(40) },
  requestedBudget: taskBudgetCeilings,
};

describe('Run admission protocol', () => {
  it('decodes only the closed personal-agent exchange payload', () => {
    expect(runAdmissionExchangeRoute).toBe('/devrandom/run/admission/1');
    expect(decodeRunAdmissionPayload(payload)).toEqual({ kind: 'Accepted', payload });
    expect(decodeRunAdmissionPayload({ ...payload, ownerAid: said('g') })).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
    expect(
      decodeRunAdmissionPayload({
        ...payload,
        purpose: { ...payload.purpose, ordinal: 6 },
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SchemaInvalid' });
  });

  it('fingerprints exact command semantics without folding in the lookup identity', () => {
    const command: RunAdmissionCommand = {
      version: 1,
      commandId,
      admissionExchangeSaid: said('h'),
    };
    const fingerprint = runAdmissionCommandFingerprint(command);

    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(
      runAdmissionCommandFingerprint({
        ...command,
        commandId: '6e6e69d0-c5d0-43df-8253-07c576120662',
      }),
    ).toBe(fingerprint);
    expect(
      runAdmissionCommandFingerprint({ ...command, admissionExchangeSaid: said('i') }),
    ).not.toBe(fingerprint);
  });
});
