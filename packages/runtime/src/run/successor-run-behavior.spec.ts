import { describe, expect, it } from 'vitest';
import type { Run } from '@devrandom/domain';
import {
  prepareEvidenceArtifact,
  prepareSuccessorHarnessRevision,
  type BaselineHarnessRevision,
} from '@devrandom/protocol';
import type { EvidenceRecorder } from '../evidence/evidence-recorder.js';
import { CommittedSuccessorRunBehavior } from './successor-run-behavior.js';
const said = (letter: string) => 'E' + letter.repeat(43);
function fixture() {
  const bytes = Buffer.from(
    JSON.stringify({
      version: 1,
      arm: 'C1',
      instructionText: 'Inspect the versioned contract before editing.',
    }),
  );
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  if (artifact.kind !== 'Prepared') throw new Error('artifact');
  const prepared = prepareSuccessorHarnessRevision({
    arm: 'C1',
    parentRevisionSaid: said('a'),
    h0Said: said('b'),
    taskRevisionSaid: said('c'),
    sourceInventorySaid: said('d'),
    executionProfileSaid: said('e'),
    configurationArtifactSaid: artifact.artifact.d,
    treatment: { kind: 'Instruction' },
  });
  if (prepared.kind !== 'Prepared') throw new Error('revision');
  const revision = prepared.revision;
  const h1 = { d: said('a') } as BaselineHarnessRevision;
  const run = {
    binding: { runId: 'run', initialHarnessRevisionSaid: h1.d, taskRevisionSaid: said('c') },
    currentExecution: { harnessRevisionSaid: revision.d, segmentSaid: said('f') },
  } as Run;
  const events: unknown[] = [];
  const evidence = {
    storeArtifact: ({ bytes }: { bytes: Uint8Array }) => {
      const stored = prepareEvidenceArtifact(bytes, 'application/json');
      return stored.kind === 'Prepared'
        ? { kind: 'Stored', artifact: stored.artifact }
        : { kind: 'Unavailable' };
    },
    record: (event: unknown) => {
      events.push(event);
      return { kind: 'Recorded' };
    },
  } as unknown as EvidenceRecorder;
  const input = {
    descriptor: {
      h1,
      successorRevisionSaid: revision.d,
      binding: {
        parentRevisionSaid: h1.d,
        arm: 'C1' as const,
        h0Said: said('b'),
        taskRevisionSaid: said('c'),
        sourceInventorySaid: said('d'),
        executionProfileSaid: said('e'),
      },
      treatment: revision.treatment,
      configuration: artifact.artifact,
    },
    revision,
    configuration: { artifact: artifact.artifact, bytes },
    context: { text: 'Verified checkpoint facts only.', sourceEventSaids: [said('g')] },
    now: () => '2026-09-26T15:00:00.000Z',
  };
  return { input, run, evidence, events };
}
describe('committed successor execution behavior', () => {
  it('uses reviewed C1 instructions with bounded recovered facts and keeps original prompts immutable', async () => {
    const f = fixture();
    const behavior = new CommittedSuccessorRunBehavior(f.input);
    const prepared = await behavior.prepare({
      run: f.run,
      executionProfileSaid: said('e'),
      baseSystemPrompt: 'H1 instructions',
      taskPrompt: 'Original Task contract',
      evidence: f.evidence,
      signal: new AbortController().signal,
    });
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') throw new Error('prepared');
    expect(prepared.systemPrompt).toContain('Inspect the versioned contract');
    expect(prepared.prompt).toContain('Original Task contract');
    expect(f.events).toHaveLength(2);
    expect(
      await behavior.prepare({
        run: f.run,
        executionProfileSaid: said('e'),
        baseSystemPrompt: 'H1',
        taskPrompt: 'Task',
        evidence: f.evidence,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'Rejected' });
  });
  it('rejects changed treatment bytes and an uncommitted successor before recording behavior', async () => {
    const f = fixture();
    expect(
      await new CommittedSuccessorRunBehavior({
        ...f.input,
        configuration: { ...f.input.configuration, bytes: Buffer.from('{}') },
      }).prepare({
        run: f.run,
        executionProfileSaid: said('e'),
        baseSystemPrompt: 'H1',
        taskPrompt: 'Task',
        evidence: f.evidence,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'Rejected' });
    expect(
      await new CommittedSuccessorRunBehavior(f.input).prepare({
        run: {
          ...f.run,
          currentExecution: {
            segmentSaid: said('f'),
            evidenceStreamId: 'stream',
            harnessRevisionSaid: said('z'),
          },
        },
        executionProfileSaid: said('e'),
        baseSystemPrompt: 'H1',
        taskPrompt: 'Task',
        evidence: f.evidence,
        signal: new AbortController().signal,
      }),
    ).toEqual({ kind: 'Rejected' });
    expect(f.events).toHaveLength(0);
  });
});
