import {
  preparePortableHarnessVerification,
  prepareEvidenceArtifact as preparePortableFixtureArtifact,
} from '@devrandom/protocol';
import { exchange, ready, Signer, SignifyClient, Tier } from 'signify-ts';
import { describe, expect, it, vi } from 'vitest';
import {
  prepareHarnessPackage,
  publicationExchangeRoute,
  type PublishedHarness,
} from '@devrandom/protocol';
import { signifyHarnessPublicationSignatures } from './publication-signature.js';
const said = `E${'a'.repeat(43)}`;
describe('native publication signature verification', () => {
  it('verifies actual Ed25519 EXN bytes against authenticated KERIA state and rejects altered signer or bytes', async () => {
    await ready();
    const signer = new Signer({ raw: new Uint8Array(32).fill(7) });
    const prepared = prepareHarnessPackage({
      publisherAid: said,
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

    const [native] = exchange(
      publicationExchangeRoute,
      {
        version: 1,
        kind: 'HarnessPublication',
        packageSaid: prepared.package.d,
        verificationSaid: verification.verification.d,
        keyStateSaid: said,
      },
      said,
      `E${'c'.repeat(43)}`,
      '2026-09-26T12:00:00.000000+00:00',
    );
    const signature = signer.sign(new TextEncoder().encode(native.raw), 0);
    const published: PublishedHarness = {
      package: prepared.package,
      verification: verification.verification,
      signature: { exchange: native.sad, signatures: [signature.qb64], keyStateSaid: said },
    };
    const client = new SignifyClient('http://127.0.0.1:3901', '0123456789abcdefghijk', Tier.low);
    type State = Awaited<ReturnType<ReturnType<SignifyClient['keyStates']>['get']>>[number];
    const state = { i: said, d: said, kt: '1', k: [signer.verfer.qb64], ee: { d: said } } as State;
    const current = vi.spyOn(client.keyStates(), 'get').mockResolvedValue([state]);
    expect(await signifyHarnessPublicationSignatures(client).verify(published)).toBe('Verified');
    expect(
      await signifyHarnessPublicationSignatures(client).verify({
        ...published,
        signature: {
          ...published.signature,
          exchange: { ...native.sad, dt: '2026-09-26T12:01:00.000000+00:00' },
        },
      }),
    ).toBe('Rejected');
    current.mockResolvedValue([
      { ...state, k: [new Signer({ raw: new Uint8Array(32).fill(8) }).verfer.qb64] },
    ]);
    expect(await signifyHarnessPublicationSignatures(client).verify(published)).toBe('Rejected');
    current.mockResolvedValue([{ ...state, ee: { ...state.ee, d: `E${'d'.repeat(43)}` } }]);
    expect(await signifyHarnessPublicationSignatures(client).verify(published)).toBe('Rejected');
  });
});
