import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { prepareEvolutionHypothesis, prepareQualifiedFailureWindow } from '@devrandom/protocol';
import { expect, it } from 'vitest';

import { GitCesrPublicHistory } from './git-cesr-public-history.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;
const taskId = 'bbb13317-1c5e-4472-842e-692da01386cf';
const originRunId = '91d7f67f-d2f9-4fae-87cc-ac827de6f0d1';

it('projects exact repaired source branches without falsely claiming legacy rejection', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'devrandom-cesr-history-')));
  try {
    await cp(resolve('fixtures/cesr-scoped-receipt-service'), directory, { recursive: true });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Devrandom test');
    git('config', 'user.email', 'test@devrandom.invalid');
    git('add', '.');
    git('commit', '-qm', 'Test-only exact source');
    const window = prepareQualifiedFailureWindow({
      version: 1,
      kind: 'QualifiedFailureWindow',
      taskId,
      taskRevisionSaid: said('t'),
      originRunId,
      retainedCheckpointSaid: said('k'),
      retainedSealSaid: said('s'),
      failureEventSaid: said('f'),
      verifierReceiptSaid: said('b'),
      precedingEventSaids: [said('P')],
    });
    if (window.kind !== 'Prepared') throw new Error('Test window invalid');
    const hypothesis = prepareEvolutionHypothesis({
      taskId,
      taskRevisionSaid: said('t'),
      originRunId,
      retainedCheckpointSaid: said('k'),
      retainedSealSaid: said('s'),
      parentRevisionSaid: said('h'),
      personalAgentAid: said('a'),
      sourceInventorySaid: said('i'),
      retrievalReceiptSaid: said('q'),
      failure: { eventSaid: said('f'), rawEvidenceSaid: said('b') },
      source: { episodeSaid: said('e'), rawEvidenceSaid: said('r') },
      implicatedComponent: 'ContextSelection',
      predictedCorrection: 'Inspect actual public scoped framing contract.',
      publicReplay: {
        failureWindowSaid: window.artifact.d,
        configurationSaid: said('x'),
        nonTreatmentInputsSaid: said('n'),
        failureQuery: 'CESR scoped compatibility',
        predictedAction: 'Inspect source before edit',
        predictedSourceChoiceSaid: said('c'),
        assertion: 'Relevant source changes the context choice.',
      },
      falsifier: 'The source choice is unchanged without source.',
      regressionRisks: ['Additional context costs tokens.'],
      rejectedExplanations: ['No relevant source exists.'],
    });
    if (hypothesis.kind !== 'Prepared') throw new Error('Test H0 invalid');
    const history = new GitCesrPublicHistory({ hypothesis: hypothesis.hypothesis, window });
    const read = await history.read({
      sourceDirectory: directory,
      h1Commit: git('rev-parse', 'HEAD'),
      h1Tree: git('rev-parse', 'HEAD^{tree}'),
      taskId,
      taskRevisionSaid: said('t'),
      sourceInventorySaid: said('i'),
      formatMarker: 'Current',
    });
    expect(read.kind).toBe('Read');
    if (read.kind !== 'Read') return;
    const source = read.sources.find((item) => item.kind === 'Edit');
    if (source === undefined) throw new Error('Missing source');
    const binding = {
      taskId,
      taskRevisionSaid: said('t'),
      sourceInventorySaid: said('i'),
      sourceId: source.sourceId,
      artifact: source.artifact,
      bytes: source.bytes,
    };
    const projection = await history.project(binding);
    expect(projection.kind).toBe('Projected');
    if (projection.kind !== 'Projected') return;
    expect(projection.text).toContain('strip_prefix("-_AAABAA")');
    expect(projection.text).toContain('strip_prefix("-_AAACAA")');
    expect(projection.text).not.toContain('rejects other version markers');
    for (const line of projection.text.split('\n').slice(1)) {
      expect(new TextDecoder().decode(source.bytes)).toContain(line.replace(/^\d+: /u, ''));
    }
    expect(
      await history.project({ ...binding, bytes: new TextEncoder().encode('forged history') }),
    ).toEqual({ kind: 'Rejected' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
