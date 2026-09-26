import { describe, expect, it } from 'vitest';

import { harnessCommandFingerprint, type BaselineHarnessProjection } from '@devrandom/protocol';

import { taskOwnerAid } from '../../task/test/task-command-fixture.js';
import { baselineHarnessCommandFixture } from '../test/harness-command-fixture.js';
import { decodeHarnessDocument, encodeHarnessDocument } from './harness-document.js';

const command = baselineHarnessCommandFixture();
const projection: BaselineHarnessProjection = {
  version: 1,
  ownerAid: taskOwnerAid,
  commandId: command.commandId,
  acceptedAt: '2026-09-24T12:30:00.000Z',
  revision: command.revision,
};
const fingerprint = harnessCommandFingerprint(command);

describe('Harness Revision Mongo document', () => {
  it('round-trips one immutable canonical H1 and its stable command identity', () => {
    const document = encodeHarnessDocument(projection, fingerprint);

    expect(document.commandFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(decodeHarnessDocument(document)).toEqual({
      projection,
      commandFingerprint: fingerprint,
      activation: {
        kind: 'AwaitingRunAdmission',
        harnessLineageId: projection.revision.task.harnessLineageId,
        harnessRevisionSaid: projection.revision.d,
      },
    });
  });

  it('rejects changed content beneath the stored H1 SAID', () => {
    const document = encodeHarnessDocument(projection, fingerprint);
    const changed = {
      ...document,
      revision: {
        ...document.revision,
        modelCompatibility: {
          ...document.revision.modelCompatibility,
          model: 'changed-model',
        },
      },
    };

    expect(() => decodeHarnessDocument(changed)).toThrow('HarnessDocumentInvalid');
  });

  it('rejects a timestamp whose BSON Date would change the accepted instant', () => {
    expect(() =>
      encodeHarnessDocument({ ...projection, acceptedAt: '2026-02-30T12:30:00.000Z' }, fingerprint),
    ).toThrow('HarnessDocumentInvalid');
  });
});
