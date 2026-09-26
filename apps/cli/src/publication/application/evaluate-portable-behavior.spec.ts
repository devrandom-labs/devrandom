import { describe, expect, it } from 'vitest';
import { prepareHarnessPackage } from '@devrandom/protocol';
import { evaluatePortableBehavior } from './evaluate-portable-behavior.js';
describe('portable behavior public safety replay', () => {
  it('executes C3 priority and bound regression while rejecting protected source and wrong version', async () => {
    const prepared = prepareHarnessPackage({
      publisherAid: `E${'a'.repeat(43)}`,
      sourceRevisionSaid: `E${'b'.repeat(43)}`,
      behavior: {
        kind: 'VersionedFormatContextSelection',
        algorithm: 'ExactPublicHistoryV1',
        formatMarker: { parameter: 'formatMarker' },
        triggerPaths: { parameter: 'formatPaths' },
        priority: ['Edit', 'Contract', 'Failure'],
        maximumItems: 2,
        maximumContextBytes: 512,
      },
    });
    if (prepared.kind !== 'Prepared') throw new Error('package');
    expect(await evaluatePortableBehavior(prepared.package)).toBe('Passed');
  });
});
