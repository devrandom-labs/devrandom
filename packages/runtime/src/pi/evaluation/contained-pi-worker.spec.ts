import { describe, expect, it } from 'vitest';
import { piToolInput } from './contained-pi-worker.js';

describe('contained Pi replace_text arguments', () => {
  it('binds an omitted occurrence count to exactly one replacement', () => {
    expect(
      piToolInput('replace_text', {
        path: 'src/lib.rs',
        oldText: 'before',
        newText: 'after',
      }),
    ).toEqual({
      kind: 'ReplaceText',
      path: 'src/lib.rs',
      oldText: 'before',
      newText: 'after',
      expectedOccurrences: 1,
    });
  });

  it('rejects an invalid explicit occurrence count', () => {
    expect(() =>
      piToolInput('replace_text', {
        path: 'src/lib.rs',
        oldText: 'before',
        newText: 'after',
        expectedOccurrences: 0,
      }),
    ).toThrow('Pi proposed invalid tool arguments.');
  });
});
