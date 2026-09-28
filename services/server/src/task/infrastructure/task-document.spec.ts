import { taskCommandFingerprint, type TaskProjectionV1 } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { decodeTaskDocument, encodeTaskDocument } from './task-document.js';
import { taskCommandFixture, taskOwnerAid } from '../test/task-command-fixture.js';

const task: TaskProjectionV1 = {
  version: 1,
  taskId: '22222222-2222-4222-8222-222222222222',
  ownerAid: taskOwnerAid,
  label: 'compatibility-fix',
  harnessLineageId: '33333333-3333-4333-8333-333333333333',
  revisionSaid: taskCommandFixture().revision.d,
  revision: taskCommandFixture().revision,
  lifecycle: { kind: 'Open' as const },
  commandId: taskCommandFixture().commandId,
  createdAt: '2026-09-24T12:00:00.000Z',
  expectedVersion: 0 as const,
};
const commandFingerprint = taskCommandFingerprint({
  version: 1,
  commandId: task.commandId,
  label: task.label,
  revision: task.revision,
});

describe('Task Mongo document', () => {
  it('round-trips the Task aggregate and immutable embedded revision', () => {
    const document = encodeTaskDocument(task, commandFingerprint, {
      ownerSlot: 2,
      globalSlot: 9,
    });

    expect(decodeTaskDocument(document)).toEqual({
      task,
      commandFingerprint,
      allocation: { ownerSlot: 2, globalSlot: 9 },
    });
  });

  it.each([
    [{ kind: 'Completed' as const }, 1],
    [{ kind: 'Cancelled' as const }, 4],
  ])(
    'round-trips the closed %s lifecycle and its aggregate version',
    (lifecycle, expectedVersion) => {
      const settled = { ...task, lifecycle, expectedVersion };
      const document = encodeTaskDocument(settled, commandFingerprint, {
        ownerSlot: 2,
        globalSlot: 9,
      });

      expect(decodeTaskDocument(document).task).toEqual(settled);
    },
  );

  it('rejects an encoded document whose command fingerprint does not bind its Task command', () => {
    expect(() =>
      encodeTaskDocument(task, `sha256:${'a'.repeat(64)}`, {
        ownerSlot: 0,
        globalSlot: 0,
      }),
    ).toThrow('TaskDocumentInvalid');
  });

  it('rejects the fifth owner slot when the signed Task ceiling is four', () => {
    expect(() =>
      encodeTaskDocument(task, commandFingerprint, { ownerSlot: 4, globalSlot: 4 }),
    ).toThrow('TaskDocumentInvalid');
  });

  it('rejects a stored document whose command fingerprint was changed', () => {
    const document = encodeTaskDocument(task, commandFingerprint, {
      ownerSlot: 0,
      globalSlot: 0,
    });

    expect(() =>
      decodeTaskDocument({ ...document, commandFingerprint: `sha256:${'a'.repeat(64)}` }),
    ).toThrow('TaskDocumentInvalid');
  });

  it('rejects a document whose embedded revision is not canonically valid', () => {
    const document = encodeTaskDocument(task, commandFingerprint, {
      ownerSlot: 0,
      globalSlot: 0,
    });
    const invalid = {
      ...document,
      revision: { ...document.revision, objective: 'changed after SAID allocation' },
    };

    expect(() => decodeTaskDocument(invalid)).toThrow('TaskDocumentInvalid');
  });

  it('rejects a stored Task whose creation time violates its immutable deadline', () => {
    const document = encodeTaskDocument(task, commandFingerprint, {
      ownerSlot: 0,
      globalSlot: 0,
    });

    expect(() =>
      decodeTaskDocument({ ...document, createdAt: new Date('2026-09-24T15:00:00.000Z') }),
    ).toThrow('TaskDocumentInvalid');
  });

  it('rejects a creation timestamp whose BSON Date would change the accepted instant', () => {
    const command = taskCommandFixture('2026-03-01T14:00:00.000Z');
    const impossibleCreation = {
      ...task,
      revision: command.revision,
      revisionSaid: command.revision.d,
      createdAt: '2026-02-29T12:00:00.000Z',
    };
    const fingerprint = taskCommandFingerprint({
      version: 1,
      commandId: impossibleCreation.commandId,
      label: impossibleCreation.label,
      revision: impossibleCreation.revision,
    });

    expect(() =>
      encodeTaskDocument(impossibleCreation, fingerprint, { ownerSlot: 0, globalSlot: 0 }),
    ).toThrow('TaskDocumentInvalid');
  });

  it('rejects an unsafe stored aggregate version', () => {
    const document = encodeTaskDocument(task, commandFingerprint, {
      ownerSlot: 0,
      globalSlot: 0,
    });

    expect(() =>
      decodeTaskDocument({ ...document, expectedVersion: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow('TaskDocumentInvalid');
  });
});
