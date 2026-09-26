import { prepareEvidenceArtifact } from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { observeSuccessorPublicReplay } from './observe-successor-public-replay.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const stimulus = Buffer.from('public current frame');
const stimulusArtifact = prepareEvidenceArtifact(stimulus, 'text/plain; charset=utf-8');
if (stimulusArtifact.kind !== 'Prepared') throw new Error('fixture');

function fixture() {
  const condition = {
    id: 'public-current',
    stimulusBase64Url: stimulus.toString('base64url'),
    expected: {
      kind: 'Parsed' as const,
      receipts: [{ version: 'Current' as const, payload: said('p') }],
    },
  };
  const observed = {
    kind: 'Observed' as const,
    executableSaid: said('x'),
    observation: condition.expected,
    rawObservationSaid: said('o'),
    cleanupReceiptSaid: said('c'),
  };
  const configurationBytes = Buffer.from('{"version":1,"arm":"C2"}');
  const implementationBytes = Buffer.from(
    '{"version":1,"kind":"RecoveryWorkflow","trigger":"QualifiedRetainedFailure","steps":["RetrieveExperience","ReadExactSource","Replan","FreshPublicVerify"]}',
  );
  const configuration = prepareEvidenceArtifact(configurationBytes, 'application/json');
  const implementation = prepareEvidenceArtifact(implementationBytes, 'application/octet-stream');
  if (configuration.kind !== 'Prepared' || implementation.kind !== 'Prepared')
    throw new Error('treatment');
  const construction = {
    build: vi.fn().mockResolvedValue({
      kind: 'Frozen',
      executableSaid: said('x'),
      sourceSaid: said('s'),
      buildReceiptSaid: said('b'),
      cleanupReceiptSaid: said('d'),
    }),
  };
  const observation = { observe: vi.fn().mockResolvedValue(observed) };
  const retain = vi
    .fn()
    .mockImplementation(({ artifact, bytes }: { artifact: { d: string }; bytes: Uint8Array }) =>
      Promise.resolve(
        prepareEvidenceArtifact(bytes, 'application/json').kind === 'Prepared'
          ? { kind: 'Retained', artifactSaid: artifact.d }
          : { kind: 'Unavailable' },
      ),
    );
  const input = {
    h0Said: said('h'),
    sourceInventorySaid: said('i'),
    arm: 'C2' as const,
    h1Commit: '1'.repeat(40),
    h1Tree: '2'.repeat(40),
    sourceDirectory: '/tmp/public-cesr-source',
    configurationArtifactSaid: configuration.artifact.d,
    reviewedImplementationSaid: implementation.artifact.d,
    configuration: { artifact: configuration.artifact, bytes: configurationBytes },
    implementation: { artifact: implementation.artifact, bytes: implementationBytes },
    capturedSourceSaid: said('s'),
    reviewedRecipeSaid: said('r'),
    toolchainSaid: said('t'),
    containerProfileSaid: said('v'),
    publicConditions: [condition],
    signal: new AbortController().signal,
  };
  const catalogue = {
    review: vi.fn().mockResolvedValue({ kind: 'Reviewed', publicConditions: [condition] }),
  };
  const behavior = {
    replay: vi.fn().mockResolvedValue({
      kind: 'Replayed',
      proof: {
        kind: 'C2Workflow',
        hypothesisSaid: said('h'),
        sourceEpisodeSaid: said('e'),
        readReceiptSaid: said('a'),
        action: 'Inspect exact source then run public verifier.',
      },
    }),
  };
  return { input, construction, observation, retain, catalogue, behavior };
}

describe('parent successor public replay', () => {
  it('retains a SAID-bound receipt with actual public observation and source/build custody before revision exists', async () => {
    const ready = fixture();
    const outcome = await observeSuccessorPublicReplay(ready.input, {
      construction: ready.construction,
      observation: ready.observation,
      catalogue: ready.catalogue,
      behavior: ready.behavior,
      custody: { retain: ready.retain },
    });
    expect(outcome.kind).toBe('Observed');
    if (outcome.kind !== 'Observed') return;
    expect(JSON.parse(Buffer.from(outcome.bytes).toString('utf8'))).toMatchObject({
      h0Said: ready.input.h0Said,
      arm: 'C2',
      h1Commit: ready.input.h1Commit,
      configurationArtifactSaid: ready.input.configurationArtifactSaid,
      reviewedImplementationSaid: ready.input.reviewedImplementationSaid,
      buildReceiptSaid: said('b'),
      observations: [
        {
          id: 'public-current',
          rawObservationSaid: said('o'),
          cleanupReceiptSaid: said('c'),
          verdict: 'Pass',
        },
      ],
      behavior: { kind: 'C2Workflow', hypothesisSaid: said('h') },
    });
    expect(ready.observation.observe).toHaveBeenCalledOnce();
    expect(ready.retain).toHaveBeenCalledOnce();
  });

  it('retains the actual negative public observation during behavioral rehearsal', async () => {
    const ready = fixture();
    ready.observation.observe.mockResolvedValueOnce({
      kind: 'Observed',
      executableSaid: said('x'),
      observation: { kind: 'Rejected', error: 'InvalidFrame' },
      rawObservationSaid: said('o'),
      cleanupReceiptSaid: said('c'),
    });
    const result = await observeSuccessorPublicReplay(ready.input, {
      construction: ready.construction,
      observation: ready.observation,
      custody: { retain: ready.retain },
      catalogue: ready.catalogue,
      behavior: ready.behavior,
    });
    expect(result.kind).toBe('Observed');
    if (result.kind === 'Observed')
      expect(JSON.parse(Buffer.from(result.bytes).toString())).toMatchObject({
        observations: [
          { verdict: 'Fail', observation: { kind: 'Rejected', error: 'InvalidFrame' } },
        ],
      });
  });

  it('refuses a drifted public Task source before build or receipt custody', async () => {
    const ready = fixture();
    ready.catalogue.review.mockResolvedValueOnce({ kind: 'SourceMismatch' });
    expect(
      await observeSuccessorPublicReplay(ready.input, {
        construction: ready.construction,
        observation: ready.observation,
        catalogue: ready.catalogue,
        custody: { retain: ready.retain },
        behavior: ready.behavior,
      }),
    ).toEqual({ kind: 'Blocked', gate: 'Catalogue' });
    expect(ready.construction.build).not.toHaveBeenCalled();
    expect(ready.retain).not.toHaveBeenCalled();
  });

  it('blocks a contradicted candidate behavior replay before the native source integrity gate', async () => {
    const ready = fixture();
    ready.behavior.replay.mockResolvedValueOnce({ kind: 'Blocked' });
    expect(
      await observeSuccessorPublicReplay(ready.input, {
        construction: ready.construction,
        observation: ready.observation,
        catalogue: ready.catalogue,
        behavior: ready.behavior,
        custody: { retain: ready.retain },
      }),
    ).toEqual({ kind: 'Blocked', gate: 'TreatmentReplay' });
    expect(ready.construction.build).not.toHaveBeenCalled();
    expect(ready.retain).not.toHaveBeenCalled();
  });
});
