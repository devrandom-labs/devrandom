import { derivePortableBehavior, reviewedPortableInstructions } from '@devrandom/domain';
import { expect, it } from 'vitest';
import { prepareResearchCandidates, researchCandidateInstructions } from './research-candidates.js';
function proposalFixture() {
  return {
    C1: {
      configuration: {
        version: 1,
        arm: 'C1',
        instructionText: 'Run public verification before completion.',
      },
    },
    C2: {
      configuration: { version: 1, arm: 'C2' },
      implementation: {
        version: 1,
        kind: 'RecoveryWorkflow',
        trigger: 'QualifiedRetainedFailure',
        steps: ['RetrieveExperience', 'ReadExactSource', 'Replan', 'FreshPublicVerify'],
      },
    },
    C3: {
      configuration: {
        version: 1,
        arm: 'C3',
        formatMarker: 'Current',
        triggerPaths: ['src/lib.rs'],
        priority: ['Failure', 'Contract', 'Edit'],
        maximumItems: 3,
        maximumContextBytes: 4096,
      },
      implementation: {
        version: 1,
        kind: 'VersionedFormatContextSelection',
        algorithm: 'ExactPublicHistoryV1',
      },
    },
  };
}

it('admits exactly three bounded treatment proposals and rejects authority or source changes', () => {
  const proposal = proposalFixture();
  expect(prepareResearchCandidates(proposal).kind).toBe('Prepared');
  expect(
    prepareResearchCandidates({
      ...proposal,
      C1: { configuration: { ...proposal.C1.configuration, authority: 'all' } },
    }).kind,
  ).toBe('Rejected');
  expect(
    prepareResearchCandidates({
      ...proposal,
      sourceEdits: [{ path: 'src/lib.rs', content: 'replacement' }],
    }).kind,
  ).toBe('Rejected');
});

it('rejects unsupported C1 wording before freezing, rather than accepting a later unpublishable winner', () => {
  const proposal = proposalFixture();
  proposal.C1.configuration.instructionText =
    'Inspect both public version counters before editing.';
  expect(derivePortableBehavior(proposal.C1.configuration, undefined, [])).toEqual({
    kind: 'Rejected',
  });
  expect(prepareResearchCandidates(proposal)).toEqual({ kind: 'Rejected' });
});

it.each([
  'Run public verification before completion.',
  'Run the public compatibility verifier before completion.',
  'Inspect the public contract before editing and run public verification before completion.',
  'Verify the expected public behavior after each change.',
])('retains the exact reviewed instruction bytes: %s', (instruction) => {
  const proposal = proposalFixture();
  proposal.C1.configuration.instructionText = instruction;
  const prepared = prepareResearchCandidates(proposal);
  expect(prepared.kind).toBe('Prepared');
  if (prepared.kind !== 'Prepared') return;
  expect(prepared.candidates.map((candidate) => candidate.arm)).toEqual(['C1', 'C2', 'C3']);
  for (const candidate of prepared.candidates) {
    const original = proposal[candidate.arm];
    expect(Buffer.from(candidate.configuration.bytes).toString()).toBe(
      JSON.stringify(original.configuration),
    );
    const configuration: unknown = JSON.parse(
      Buffer.from(candidate.configuration.bytes).toString(),
    );
    const implementation: unknown =
      candidate.implementation === undefined
        ? undefined
        : JSON.parse(Buffer.from(candidate.implementation.bytes).toString());
    const portable = derivePortableBehavior(configuration, implementation, []);
    expect(portable.kind).toBe('Portable');
    if (candidate.arm === 'C1')
      expect(portable).toEqual({
        kind: 'Portable',
        behavior: { kind: 'Instruction', text: instruction },
      });
  }
});
it('accepts no substitute when the model rejects the catalogue as unsuitable', () => {
  expect(
    prepareResearchCandidates({ kind: 'Rejected', reason: 'NoEvidenceAppropriateInstruction' }),
  ).toEqual({ kind: 'Rejected' });
});

it('offers the existing reviewed catalogue with an explicit no-fit rejection before freezing', () => {
  expect(Object.isFrozen(reviewedPortableInstructions)).toBe(true);
  expect(researchCandidateInstructions).toContain(JSON.stringify(reviewedPortableInstructions));
  expect(researchCandidateInstructions).toContain('NoEvidenceAppropriateInstruction');
  expect(researchCandidateInstructions).toContain(
    'do not force a fit, paraphrase, or invent a replacement',
  );
});
