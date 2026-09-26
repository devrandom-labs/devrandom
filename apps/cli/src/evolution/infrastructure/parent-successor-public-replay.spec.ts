import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { ParentSuccessorPublicReplay } from './parent-successor-public-replay.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const condition = {
  id: 'public-current',
  stimulusBase64Url: Buffer.from('input').toString('base64url'),
  expected: {
    kind: 'Parsed' as const,
    receipts: [{ version: 'Current' as const, payload: said('p') }],
  },
};

function fixture() {
  const catalogue = prepareEvidenceArtifact(
    Buffer.from(JSON.stringify([condition])),
    'application/json',
  );
  const stimulus = prepareEvidenceArtifact(Buffer.from('input'), 'text/plain; charset=utf-8');
  if (catalogue.kind !== 'Prepared' || stimulus.kind !== 'Prepared') throw new Error('catalogue');
  const rawBytes = Buffer.from(
    JSON.stringify({
      executableSaid: said('x'),
      stimulusSaid: stimulus.artifact.d,
      caseScope: 'Public',
      observation: condition.expected,
      stdout: 'DV1|P|Current:' + said('p'),
      effectiveLimitsDigest: 'sha256:' + '1'.repeat(64),
    }),
  );
  const raw = prepareEvidenceArtifact(rawBytes, 'application/json');
  if (raw.kind !== 'Prepared') throw new Error('raw');
  const cleanupBytes = Buffer.from(
    JSON.stringify({ rawObservationSaid: raw.artifact.d, stopped: true }),
  );
  const cleanup = prepareEvidenceArtifact(cleanupBytes, 'application/json');
  if (cleanup.kind !== 'Prepared') throw new Error('cleanup');
  const buildBytes = Buffer.from(
    JSON.stringify({
      sourceSaid: said('s'),
      recipeSaid: said('r'),
      toolchainSaid: said('t'),
      exitCode: 0,
      stdout: '',
      stderr: '',
      effectiveLimitsDigest: 'sha256:' + '1'.repeat(64),
    }),
  );
  const build = prepareEvidenceArtifact(buildBytes, 'application/json');
  if (build.kind !== 'Prepared') throw new Error('build');
  const buildCleanupBytes = Buffer.from(
    JSON.stringify({ buildReceiptSaid: build.artifact.d, stopped: true }),
  );
  const buildCleanup = prepareEvidenceArtifact(buildCleanupBytes, 'application/json');
  if (buildCleanup.kind !== 'Prepared') throw new Error('build cleanup');
  const receiptBytes = Buffer.from(
    JSON.stringify({
      version: 1,
      kind: 'SuccessorPublicReplay',
      h0Said: said('h'),
      sourceInventorySaid: said('i'),
      arm: 'C2',
      h1Commit: '1'.repeat(40),
      h1Tree: '2'.repeat(40),
      configurationArtifactSaid: said('q'),
      reviewedImplementationSaid: said('w'),
      behavior: {
        kind: 'C2Workflow',
        hypothesisSaid: said('h'),
        sourceEpisodeSaid: said('e'),
        readReceiptSaid: said('a'),
        action: 'Inspect exact source then run public verifier.',
      },
      capturedSourceSaid: said('s'),
      reviewedRecipeSaid: said('r'),
      toolchainSaid: said('t'),
      containerProfileSaid: said('v'),
      publicCatalogueSaid: catalogue.artifact.d,
      executableSaid: said('x'),
      buildReceiptSaid: build.artifact.d,
      buildCleanupReceiptSaid: buildCleanup.artifact.d,
      observations: [
        {
          id: condition.id,
          stimulusSaid: stimulus.artifact.d,
          observation: condition.expected,
          rawObservationSaid: raw.artifact.d,
          cleanupReceiptSaid: cleanup.artifact.d,
          verdict: 'Pass',
        },
      ],
    }),
  );
  const artifact = prepareEvidenceArtifact(receiptBytes, 'application/json');
  if (artifact.kind !== 'Prepared') throw new Error('receipt');
  const request = {
    h0Said: said('h'),
    sourceInventorySaid: said('i'),
    arm: 'C2' as const,
    successorRevisionSaid: said('z'),
    configurationArtifactSaid: said('q'),
    reviewedImplementationSaid: said('w'),
    receiptArtifactSaid: artifact.artifact.d,
    receiptBytes,
  };
  const custody = {
    read: (artifactSaid: string) =>
      Promise.resolve(
        artifactSaid === artifact.artifact.d
          ? { kind: 'Read' as const, artifact: artifact.artifact, bytes: receiptBytes }
          : artifactSaid === raw.artifact.d
            ? { kind: 'Read' as const, artifact: raw.artifact, bytes: rawBytes }
            : artifactSaid === cleanup.artifact.d
              ? { kind: 'Read' as const, artifact: cleanup.artifact, bytes: cleanupBytes }
              : artifactSaid === build.artifact.d
                ? { kind: 'Read' as const, artifact: build.artifact, bytes: buildBytes }
                : artifactSaid === buildCleanup.artifact.d
                  ? {
                      kind: 'Read' as const,
                      artifact: buildCleanup.artifact,
                      bytes: buildCleanupBytes,
                    }
                  : { kind: 'Missing' as const },
      ),
  };
  return { request, custody, receiptBytes };
}

describe('parent public replay verification', () => {
  it('accepts only an exact retained native-observation receipt bound to the public catalogue and H1 source', async () => {
    const ready = fixture();
    const verifier = new ParentSuccessorPublicReplay({
      custody: ready.custody,
      executables: { open: () => Promise.resolve('/tmp/frozen-native') },
      conditions: [condition],
      h1Commit: '1'.repeat(40),
      h1Tree: '2'.repeat(40),
      capturedSourceSaid: said('s'),
      reviewedRecipeSaid: said('r'),
      toolchainSaid: said('t'),
      containerProfileSaid: said('v'),
    });
    expect(await verifier.verify(ready.request)).toMatchObject({
      kind: 'Confirmed',
      receiptArtifactSaid: ready.request.receiptArtifactSaid,
    });
  });

  it('rejects a substituted receipt, missing custody, or failed observation even with a self-consistent SAID', async () => {
    const ready = fixture();
    const verifier = new ParentSuccessorPublicReplay({
      custody: ready.custody,
      executables: { open: () => Promise.resolve('/tmp/frozen-native') },
      conditions: [condition],
      h1Commit: '1'.repeat(40),
      h1Tree: '2'.repeat(40),
      capturedSourceSaid: said('s'),
      reviewedRecipeSaid: said('r'),
      toolchainSaid: said('t'),
      containerProfileSaid: said('v'),
    });
    expect(
      await verifier.verify({ ...ready.request, receiptBytes: Buffer.from('changed') }),
    ).toEqual({ kind: 'Rejected' });
    const absent = new ParentSuccessorPublicReplay({
      custody: { read: () => Promise.resolve({ kind: 'Missing' as const }) },
      conditions: [condition],
      executables: { open: () => Promise.resolve('/tmp/frozen-native') },
      h1Commit: '1'.repeat(40),
      h1Tree: '2'.repeat(40),
      capturedSourceSaid: said('s'),
      reviewedRecipeSaid: said('r'),
      toolchainSaid: said('t'),
      containerProfileSaid: said('v'),
    });
    expect(await absent.verify(ready.request)).toEqual({ kind: 'Rejected' });
    const changed = JSON.parse(ready.receiptBytes.toString('utf8')) as {
      observations: { verdict: string }[];
    };
    const firstObservation = changed.observations[0];
    if (firstObservation === undefined) throw new Error('missing first observation');
    firstObservation.verdict = 'Fail';
    const badBytes = Buffer.from(JSON.stringify(changed));
    const badArtifact = prepareEvidenceArtifact(badBytes, 'application/json');
    if (badArtifact.kind !== 'Prepared') throw new Error('bad artifact');
    const bad = new ParentSuccessorPublicReplay({
      custody: {
        read: () =>
          Promise.resolve({
            kind: 'Read' as const,
            artifact: badArtifact.artifact,
            bytes: badBytes,
          }),
      },
      executables: { open: () => Promise.resolve('/tmp/frozen-native') },
      conditions: [condition],
      h1Commit: '1'.repeat(40),
      h1Tree: '2'.repeat(40),
      capturedSourceSaid: said('s'),
      reviewedRecipeSaid: said('r'),
      toolchainSaid: said('t'),
      containerProfileSaid: said('v'),
    });
    expect(
      await bad.verify({
        ...ready.request,
        receiptArtifactSaid: badArtifact.artifact.d,
        receiptBytes: badBytes,
      }),
    ).toEqual({ kind: 'Rejected' });
  });
});
