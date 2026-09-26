import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeTaskFileBytes, JsonTaskFile, TaskFileFailure } from './task-file.js';

const bytes = (source: string): Uint8Array => new TextEncoder().encode(source);

function failure(source: Uint8Array): TaskFileFailure {
  try {
    decodeTaskFileBytes(source);
  } catch (cause) {
    if (cause instanceof TaskFileFailure) {
      return cause;
    }
    throw cause;
  }
  throw new Error('expected Task file decoding to fail');
}

describe('Task file JSON boundary', () => {
  it('decodes one closed JSON value without normalizing its members', () => {
    expect(
      decodeTaskFileBytes(
        bytes('{"version":1,"repository":{"kind":"currentHead"},"values":[1,true,null]}'),
      ),
    ).toEqual({
      version: 1,
      repository: { kind: 'currentHead' },
      values: [1, true, null],
    });
  });

  it.each([
    ['byte-order mark', new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), 'BomForbidden'],
    ['comment', bytes('{"version": 1 /* comment */}'), 'JsonInvalid'],
    ['non-finite number', bytes('{"budget": Infinity}'), 'JsonInvalid'],
    ['trailing value', bytes('{} {}'), 'JsonInvalid'],
    ['invalid UTF-8', new Uint8Array([0xc3, 0x28]), 'Utf8Invalid'],
  ] as const)('rejects %s syntax before schema decoding', (_label, source, reason) => {
    expect(failure(source).detail).toEqual({ kind: reason });
  });

  it.each([
    '{"label":"first","label":"second"}',
    '{"label":"first","\\u006cabel":"second"}',
    '{"outer":{"id":"first","id":"second"}}',
  ])('rejects duplicate object members: %s', (source) => {
    expect(failure(bytes(source)).detail).toEqual({ kind: 'DuplicateMember' });
  });

  it('enforces the 256 KiB boundary on bytes, not decoded characters', () => {
    expect(failure(new Uint8Array(262_145)).detail).toEqual({ kind: 'FileTooLarge' });
  });

  it('reads through the same byte boundary and classifies an unavailable file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'devrandom-task-file-'));
    try {
      const path = join(directory, 'task.devrandom.json');
      await writeFile(path, '{"version":1}', 'utf8');
      await expect(new JsonTaskFile().read(path)).resolves.toEqual({
        kind: 'Read',
        document: { version: 1 },
      });
      await expect(new JsonTaskFile().read(join(directory, 'missing.json'))).resolves.toEqual({
        kind: 'Rejected',
        reason: 'FileUnavailable',
      });
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
