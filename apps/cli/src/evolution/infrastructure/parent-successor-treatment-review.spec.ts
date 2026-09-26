import { taskBudgetCeilings } from '@devrandom/domain';
import {
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  prepareBaselineHarnessRevision,
  prepareEvidenceArtifact,
} from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { ParentSuccessorTreatmentReview } from './parent-successor-treatment-review.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8');

function fixture(arm: 'C1' | 'C2' | 'C3') {
  const instruction = identifyHarnessInstruction({ path: 'AGENTS.md', content: '# public\n' });
  const completion = identifyHarnessCompletionCommand(
    {
      id: 'public-test',
      argv: ['just', 'test-public'],
      timeoutSeconds: 120,
      expected: { kind: 'exitCode', code: 0 },
    },
    '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-just/bin/just',
  );
  if (instruction.kind !== 'Identified' || completion.kind !== 'Identified')
    throw new Error('fixture');
  const h1 = prepareBaselineHarnessRevision({
    task: {
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      revisionSaid: said('t'),
      harnessLineageId: 'd9cb18e4-f4f8-4378-a852-353eef083d91',
      requestedCapabilities: ['ReadRepository'],
    },
    authority: {
      personalAgentAid: said('a'),
      taskMandateSaid: said('m'),
      allowedCapabilities: ['ReadRepository'],
    },
    repository: {
      objectFormat: 'sha1',
      commit: '1'.repeat(40),
      tree: '2'.repeat(40),
      instructionResources: [instruction.resource],
    },
    completionCommands: [completion.command],
    toolCommands: [],
    modelCompatibility: {
      provider: 'test',
      model: 'pinned-model',
      contextWindowTokens: 100_000,
      maximumOutputTokens: 2_000,
      thinkingLevel: 'off',
      credentialSource: 'TEST_API_KEY',
      toolCalls: 'Supported',
      usageAccounting: 'Required',
    },
    environmentCompatibility: {
      operatingSystem: 'linux',
      architecture: 'x64',
      nodeVersion: '24.20.0',
      gitVersion: '2.51.0',
      piSdkVersion: '0.87.1',
      xstateVersion: '5.33.2',
    },
    capabilities: { available: ['ReadRepository'], unavailable: [] },
    budgetCeilings: {
      task: taskBudgetCeilings,
      server: taskBudgetCeilings,
      mandate: taskBudgetCeilings,
    },
  });
  if (h1.kind !== 'Prepared') throw new Error('fixture H1');
  const configurationBytes = bytes(
    arm === 'C1'
      ? {
          version: 1,
          arm,
          instructionText: 'Run the public compatibility verifier before completion.',
        }
      : arm === 'C2'
        ? { version: 1, arm }
        : {
            version: 1,
            arm,
            formatMarker: 'v2',
            triggerPaths: ['src/lib.rs'],
            priority: ['Failure', 'Contract', 'Edit'],
            maximumItems: 3,
            maximumContextBytes: 2048,
          },
  );
  const implementationBytes =
    arm === 'C1'
      ? undefined
      : bytes(
          arm === 'C2'
            ? {
                version: 1,
                kind: 'RecoveryWorkflow',
                trigger: 'QualifiedRetainedFailure',
                steps: ['RetrieveExperience', 'ReadExactSource', 'Replan', 'FreshPublicVerify'],
              }
            : {
                version: 1,
                kind: 'VersionedFormatContextSelection',
                algorithm: 'ExactPublicHistoryV1',
              },
        );
  const configuration = prepareEvidenceArtifact(configurationBytes, 'application/json');
  const implementation =
    implementationBytes === undefined
      ? undefined
      : prepareEvidenceArtifact(implementationBytes, 'application/octet-stream');
  if (
    configuration.kind !== 'Prepared' ||
    (implementation !== undefined && implementation.kind !== 'Prepared')
  )
    throw new Error('fixture artifacts');
  return {
    binding: {
      parentRevisionSaid: h1.revision.d,
      arm,
      h0Said: said('h'),
      taskRevisionSaid: h1.revision.task.revisionSaid,
      sourceInventorySaid: said('s'),
      executionProfileSaid: said('p'),
    },
    h1: h1.revision,
    successorRevisionSaid: said('c'),
    configurationArtifactSaid: configuration.artifact.d,
    configurationBytes,
    ...(implementationBytes === undefined || implementation === undefined
      ? {}
      : {
          reviewedImplementationSaid: implementation.artifact.d,
          reviewedImplementationBytes: implementationBytes,
        }),
  };
}

describe('parent successor treatment review', () => {
  const reviewer = new ParentSuccessorTreatmentReview();

  it.each(['C1', 'C2', 'C3'] as const)(
    'reviews exact bounded %s treatment semantics',
    async (arm) => {
      const request = fixture(arm);
      expect(await reviewer.review(request)).toEqual({
        kind: 'Reviewed',
        binding: request.binding,
        successorRevisionSaid: request.successorRevisionSaid,
        configurationArtifactSaid: request.configurationArtifactSaid,
        ...(request.reviewedImplementationSaid === undefined
          ? {}
          : { reviewedImplementationSaid: request.reviewedImplementationSaid }),
      });
    },
  );

  it('rejects substituted bytes, changed C2 steps, and C3 authority fields before branch creation', async () => {
    const c2 = fixture('C2');
    expect(
      await reviewer.review({
        ...c2,
        reviewedImplementationBytes: bytes({
          version: 1,
          kind: 'RecoveryWorkflow',
          trigger: 'QualifiedRetainedFailure',
          steps: ['RetrieveExperience', 'SkipVerifier'],
        }),
      }),
    ).toEqual({ kind: 'Rejected' });
    const c3 = fixture('C3');
    expect(
      await reviewer.review({
        ...c3,
        configurationBytes: bytes({ version: 1, arm: 'C3', authority: 'all' }),
      }),
    ).toEqual({ kind: 'Rejected' });
    const malformed = bytes({
      version: 1,
      arm: 'C3',
      formatMarker: 'v2',
      triggerPaths: null,
      priority: [],
      maximumItems: 3,
      maximumContextBytes: 2048,
    });
    const malformedArtifact = prepareEvidenceArtifact(malformed, 'application/json');
    if (malformedArtifact.kind !== 'Prepared') throw new Error('fixture malformed artifact');
    expect(
      await reviewer.review({
        ...c3,
        configurationArtifactSaid: malformedArtifact.artifact.d,
        configurationBytes: malformed,
      }),
    ).toEqual({ kind: 'Rejected' });
    expect(
      await reviewer.review({ ...c3, binding: { ...c3.binding, parentRevisionSaid: said('x') } }),
    ).toEqual({ kind: 'Rejected' });
  });
});
