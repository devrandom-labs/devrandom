import {
  preparePortableHarnessVerification,
  prepareEvidenceArtifact as preparePortableFixtureArtifact,
} from '@devrandom/protocol';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareHarnessPackage, type PublishedHarness } from '@devrandom/protocol';
import { PrivatePublicationFiles } from './private-publication-files.js';
const roots: string[] = [];
describe('clean-profile private harness fork custody', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });
  it('retains source package provenance, creates a new retry-safe lineage, imports no principal or authority', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-fork-'));
    roots.push(root);
    const files = new PrivatePublicationFiles(root);
    const prepared = prepareHarnessPackage({
      publisherAid: `E${'a'.repeat(43)}`,
      sourceRevisionSaid: `E${'b'.repeat(43)}`,
      behavior: { kind: 'Instruction', text: 'Run public verification before completion.' },
    });
    if (prepared.kind !== 'Prepared') throw new Error('package');
    const verificationBytes = Buffer.from('{"kind":"PublicPortableFixture"}');
    const verificationArtifact = preparePortableFixtureArtifact(
      verificationBytes,
      'application/json',
    );
    if (verificationArtifact.kind !== 'Prepared') throw new Error('verification artifact');
    const verification = preparePortableHarnessVerification({
      packageSaid: prepared.package.d,
      checks: [
        'Sanitization',
        'CapabilityIsolation',
        'PortableBehavior',
        'FreshPublicVerification',
        'ProtectedRegression',
      ].map((name) => ({ name, evidenceSaid: verificationArtifact.artifact.d })),
      rawEvidence: [
        {
          artifact: verificationArtifact.artifact,
          bytesBase64Url: verificationBytes.toString('base64url'),
        },
      ],
    });
    if (verification.kind !== 'Prepared') throw new Error('verification');

    const published: PublishedHarness = {
      package: prepared.package,
      verification: verification.verification,
      signature: { exchange: {}, signatures: ['A'.repeat(88)], keyStateSaid: `E${'c'.repeat(43)}` },
    };
    expect(await files.retainVerified(published)).toBe('Retained');
    const commandId = '00000000-0000-4000-8000-000000000001';
    const fork = await files.fork(prepared.package.d, commandId);
    expect(fork.kind).toBe('Forked');
    expect(await new PrivatePublicationFiles(root).fork(prepared.package.d, commandId)).toEqual(
      fork,
    );
    if (fork.kind !== 'Forked') throw new Error('fork');
    expect(Object.keys(fork.fork).sort()).toEqual([
      'behavior',
      'commandId',
      'kind',
      'lineageId',
      'requiredCapabilities',
      'sourcePackageSaid',
      'version',
    ]);
    expect(await files.fork(`E${'d'.repeat(43)}`, commandId)).toEqual({ kind: 'Rejected' });
  });
});
