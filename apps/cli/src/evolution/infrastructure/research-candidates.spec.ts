import { expect, it } from 'vitest';
import { prepareResearchCandidates } from './research-candidates.js';
it('admits exactly three bounded treatment proposals and rejects authority or source changes', () => {
  const proposal = {
    C1: {
      configuration: {
        version: 1,
        arm: 'C1',
        instructionText: 'Inspect both public version counters before editing.',
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
