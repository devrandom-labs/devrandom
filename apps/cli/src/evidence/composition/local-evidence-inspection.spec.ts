import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { inspectLocalEvidence, inspectLocalHarness } from './local-evidence-inspection.js';
it('reads Evaluation evidence only through the public custody endpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-inspection-'));
  try {
    const evaluationId = '12345678-1234-4234-8234-123456789abc';
    await mkdir(join(root, 'evaluations', evaluationId), { recursive: true });
    const readPublicArtifact = vi.fn(() => Promise.resolve({ kind: 'Denied' as const }));
    const input = {
      stateRoot: root,
      artifactSaid: `E${'a'.repeat(43)}`,
      signal: new AbortController().signal,
      hosted: { evaluations: { readPublicArtifact } } as unknown as Parameters<
        typeof inspectLocalEvidence
      >[0]['hosted'],
    };
    expect(await inspectLocalEvidence(input)).toEqual({ kind: 'NotFound' });
    expect(readPublicArtifact).toHaveBeenCalledWith({
      evaluationId,
      artifactSaid: input.artifactSaid,
    });
    expect(await inspectLocalHarness(root, '../../identity')).toEqual({ kind: 'Rejected' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
