import { taskBudgetCeilings } from '@devrandom/domain';
import {
  identifyHarnessCompletionCommand,
  identifyHarnessInstruction,
  prepareBaselineHarnessRevision,
  prepareEvidenceArtifact,
  prepareSuccessorHarnessRevision,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { materializeSuccessor } from './materialize-successor.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const utf8 = new TextEncoder();

function artifact(
  bytes: Uint8Array,
  mediaType: 'application/json' | 'application/octet-stream' = 'application/json',
) {
  const prepared = prepareEvidenceArtifact(bytes, mediaType);
  if (prepared.kind !== 'Prepared') throw new Error('fixture artifact');
  return { artifact: prepared.artifact, bytes };
}

function fixture(
  arm: 'C1' | 'C2' | 'C3' = 'C1',
  configurationArm: 'C1' | 'C2' | 'C3' = arm,
  configurationFields: { readonly authority?: { readonly personalAgentAid: string } } = {},
) {
  const instruction = identifyHarnessInstruction({
    path: 'AGENTS.md',
    content: '# public instructions\n',
  });
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
    throw new Error('fixture H1 resources');
  const h1Prepared = prepareBaselineHarnessRevision({
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
  if (h1Prepared.kind !== 'Prepared') throw new Error(`fixture H1: ${h1Prepared.reason}`);
  const h1 = h1Prepared.revision;
  const configuration = artifact(
    utf8.encode(
      JSON.stringify({ version: 1, arm: configurationArm, reviewed: true, ...configurationFields }),
    ),
  );
  const implementation = artifact(
    utf8.encode('reviewed implementation bytes'),
    'application/octet-stream',
  );
  const replay = artifact(
    utf8.encode(JSON.stringify({ kind: 'PublicReplay', arm, supported: true })),
  );
  const treatment =
    arm === 'C1'
      ? { kind: 'Instruction' }
      : arm === 'C2'
        ? {
            kind: 'ReviewedWorkflow',
            reviewedImplementationSaid: implementation.artifact.d,
            publicReplayReceiptSaid: replay.artifact.d,
          }
        : {
            kind: 'ContextSelection',
            reviewedImplementationSaid: implementation.artifact.d,
            publicReplayReceiptSaid: replay.artifact.d,
          };
  const successorPrepared = prepareSuccessorHarnessRevision({
    parentRevisionSaid: h1.d,
    arm,
    h0Said: said('o'),
    taskRevisionSaid: h1.task.revisionSaid,
    sourceInventorySaid: said('s'),
    executionProfileSaid: said('p'),
    configurationArtifactSaid: configuration.artifact.d,
    treatment,
  });
  if (successorPrepared.kind !== 'Prepared') throw new Error('fixture successor');
  const successor = successorPrepared.revision;
  const expected = {
    parentRevisionSaid: h1.d,
    arm,
    h0Said: said('o'),
    taskRevisionSaid: h1.task.revisionSaid,
    sourceInventorySaid: said('s'),
    executionProfileSaid: said('p'),
  };
  const input = {
    expected,
    h1Bytes: utf8.encode(JSON.stringify(h1)),
    successorBytes: utf8.encode(JSON.stringify(successor)),
    configuration,
    implementation: arm === 'C1' ? undefined : implementation,
    replay: arm === 'C1' ? undefined : replay,
  };
  const treatmentReview = {
    review: vi
      .fn()
      .mockImplementation(
        (request: {
          readonly binding: typeof expected;
          readonly successorRevisionSaid: string;
          readonly configurationArtifactSaid: string;
          readonly reviewedImplementationSaid?: string;
        }) =>
          Promise.resolve({
            kind: 'Reviewed',
            binding: request.binding,
            successorRevisionSaid: request.successorRevisionSaid,
            configurationArtifactSaid: request.configurationArtifactSaid,
            reviewedImplementationSaid: request.reviewedImplementationSaid,
          }),
      ),
  };
  const publicReplay = {
    verify: vi
      .fn()
      .mockImplementation(
        (request: {
          readonly h0Said: string;
          readonly sourceInventorySaid: string;
          readonly arm: string;
          readonly successorRevisionSaid: string;
          readonly configurationArtifactSaid: string;
          readonly reviewedImplementationSaid: string;
          readonly receiptArtifactSaid: string;
        }) =>
          Promise.resolve({
            kind: 'Confirmed',
            h0Said: request.h0Said,
            sourceInventorySaid: request.sourceInventorySaid,
            arm: request.arm,
            successorRevisionSaid: request.successorRevisionSaid,
            configurationArtifactSaid: request.configurationArtifactSaid,
            reviewedImplementationSaid: request.reviewedImplementationSaid,
            receiptArtifactSaid: request.receiptArtifactSaid,
          }),
      ),
  };
  return {
    h1,
    successor,
    input,
    treatmentReview,
    publicReplay,
    configuration,
    implementation,
    replay,
  };
}

describe('successor Harness materialization', () => {
  it.each(['C1', 'C2', 'C3'] as const)(
    'materializes %s as one delta over exact immutable H1',
    async (arm) => {
      const ready = fixture(arm);
      const result = await materializeSuccessor(ready.input, {
        treatmentReview: ready.treatmentReview,
        publicReplay: ready.publicReplay,
      });
      expect(result.kind).toBe('Materialized');
      if (result.kind !== 'Materialized') return;
      expect(result.descriptor.h1).toEqual(ready.h1);
      expect(result.descriptor.h1.authority).toEqual(ready.h1.authority);
      expect(result.descriptor.h1.activeTools).toEqual(ready.h1.activeTools);
      expect(result.descriptor.h1.modelCompatibility).toEqual(ready.h1.modelCompatibility);
      expect(result.descriptor.h1.budgetCeilings).toEqual(ready.h1.budgetCeilings);
      expect(result.descriptor.successorRevisionSaid).toBe(ready.successor.d);
      expect(result.descriptor.configuration.d).toBe(ready.configuration.artifact.d);
      expect(Object.isFrozen(result.descriptor.h1.authority)).toBe(true);
      expect(Object.isFrozen(result.descriptor.h1.activeTools)).toBe(true);
      expect(Object.isFrozen(result.descriptor)).toBe(true);
      if (arm === 'C1') expect(ready.publicReplay.verify).not.toHaveBeenCalled();
      else expect(ready.publicReplay.verify).toHaveBeenCalledTimes(1);
    },
  );

  it('blocks altered H1 bytes or a different expected H1 SAID before review', async () => {
    const ready = fixture();
    expect(
      (
        await materializeSuccessor(
          {
            ...ready.input,
            h1Bytes: utf8.encode(`${new TextDecoder().decode(ready.input.h1Bytes)} `),
          },
          { treatmentReview: ready.treatmentReview, publicReplay: ready.publicReplay },
        )
      ).kind,
    ).toBe('Blocked');
    expect(
      (
        await materializeSuccessor(
          { ...ready.input, expected: { ...ready.input.expected, parentRevisionSaid: said('z') } },
          { treatmentReview: ready.treatmentReview, publicReplay: ready.publicReplay },
        )
      ).kind,
    ).toBe('Blocked');
    expect(ready.treatmentReview.review).not.toHaveBeenCalled();
    const changedH1 = {
      ...ready.h1,
      authority: { ...ready.h1.authority, personalAgentAid: said('z') },
    };
    expect(
      (
        await materializeSuccessor(
          { ...ready.input, h1Bytes: utf8.encode(JSON.stringify(changedH1)) },
          { treatmentReview: ready.treatmentReview, publicReplay: ready.publicReplay },
        )
      ).kind,
    ).toBe('Blocked');
  });

  it('blocks post-freeze successor substitution before parent review', async () => {
    const ready = fixture('C2');
    const changed = { ...ready.successor, sourceInventorySaid: said('z') };
    expect(
      await materializeSuccessor(
        { ...ready.input, successorBytes: utf8.encode(JSON.stringify(changed)) },
        { treatmentReview: ready.treatmentReview, publicReplay: ready.publicReplay },
      ),
    ).toEqual({ kind: 'Blocked', reason: 'Successor' });
    expect(ready.treatmentReview.review).not.toHaveBeenCalled();
  });

  it('blocks Task, source, profile, H0 or arm mismatch', async () => {
    for (const field of [
      'taskRevisionSaid',
      'sourceInventorySaid',
      'executionProfileSaid',
      'h0Said',
      'arm',
    ] as const) {
      const ready = fixture();
      const expected = { ...ready.input.expected, [field]: field === 'arm' ? 'C2' : said('z') };
      expect(
        (
          await materializeSuccessor(
            { ...ready.input, expected },
            { treatmentReview: ready.treatmentReview, publicReplay: ready.publicReplay },
          )
        ).kind,
      ).toBe('Blocked');
    }
  });

  it('blocks missing, oversized or digest-mismatched configuration bytes', async () => {
    const ready = fixture();
    const changed = { ...ready.input.configuration, bytes: utf8.encode('different') };
    expect(
      (
        await materializeSuccessor(
          { ...ready.input, configuration: changed },
          { treatmentReview: ready.treatmentReview, publicReplay: ready.publicReplay },
        )
      ).kind,
    ).toBe('Blocked');
    const oversized = artifact(new Uint8Array(32_769));
    expect(
      (
        await materializeSuccessor(
          { ...ready.input, configuration: oversized },
          { treatmentReview: ready.treatmentReview, publicReplay: ready.publicReplay },
        )
      ).kind,
    ).toBe('Blocked');
    const mismatchedArm = fixture('C1', 'C2');
    expect(
      await materializeSuccessor(mismatchedArm.input, {
        treatmentReview: mismatchedArm.treatmentReview,
        publicReplay: mismatchedArm.publicReplay,
      }),
    ).toEqual({ kind: 'Blocked', reason: 'Configuration' });
    const override = fixture('C1', 'C1', { authority: { personalAgentAid: said('z') } });
    expect(
      await materializeSuccessor(override.input, {
        treatmentReview: override.treatmentReview,
        publicReplay: override.publicReplay,
      }),
    ).toEqual({ kind: 'Blocked', reason: 'Configuration' });
  });

  it('blocks C1 implementation/replay extras and C2 missing or corrupt reviewed code/receipt', async () => {
    const c1 = fixture('C1');
    expect(
      (
        await materializeSuccessor(
          { ...c1.input, implementation: c1.implementation },
          { treatmentReview: c1.treatmentReview, publicReplay: c1.publicReplay },
        )
      ).kind,
    ).toBe('Blocked');
    expect(
      (
        await materializeSuccessor(
          { ...c1.input, replay: c1.replay },
          { treatmentReview: c1.treatmentReview, publicReplay: c1.publicReplay },
        )
      ).kind,
    ).toBe('Blocked');
    const c2 = fixture('C2');
    expect(
      (
        await materializeSuccessor(
          { ...c2.input, implementation: undefined },
          { treatmentReview: c2.treatmentReview, publicReplay: c2.publicReplay },
        )
      ).kind,
    ).toBe('Blocked');
    expect(
      (
        await materializeSuccessor(
          { ...c2.input, replay: undefined },
          { treatmentReview: c2.treatmentReview, publicReplay: c2.publicReplay },
        )
      ).kind,
    ).toBe('Blocked');
    expect(
      (
        await materializeSuccessor(
          { ...c2.input, replay: { ...c2.replay, bytes: utf8.encode('forged') } },
          { treatmentReview: c2.treatmentReview, publicReplay: c2.publicReplay },
        )
      ).kind,
    ).toBe('Blocked');
  });

  it('blocks a denied or mismatched parent review and replay disposition', async () => {
    const ready = fixture('C2');
    ready.treatmentReview.review = vi.fn().mockResolvedValue({ kind: 'Rejected' });
    expect(
      (
        await materializeSuccessor(ready.input, {
          treatmentReview: ready.treatmentReview,
          publicReplay: ready.publicReplay,
        })
      ).kind,
    ).toBe('Blocked');
    ready.treatmentReview.review = vi.fn().mockResolvedValue({
      kind: 'Reviewed',
      binding: ready.input.expected,
      successorRevisionSaid: said('z'),
      configurationArtifactSaid: ready.configuration.artifact.d,
      reviewedImplementationSaid: ready.implementation.artifact.d,
    });
    expect(
      (
        await materializeSuccessor(ready.input, {
          treatmentReview: ready.treatmentReview,
          publicReplay: ready.publicReplay,
        })
      ).kind,
    ).toBe('Blocked');
    const fresh = fixture('C2');
    fresh.publicReplay.verify = vi.fn().mockResolvedValue({
      kind: 'Confirmed',
      h0Said: said('z'),
      sourceInventorySaid: said('s'),
      arm: 'C2',
      receiptArtifactSaid: fresh.replay.artifact.d,
    });
    expect(
      (
        await materializeSuccessor(fresh.input, {
          treatmentReview: fresh.treatmentReview,
          publicReplay: fresh.publicReplay,
        })
      ).kind,
    ).toBe('Blocked');
    const wrongCandidate = fixture('C2');
    wrongCandidate.publicReplay.verify = vi.fn().mockResolvedValue({
      kind: 'Confirmed',
      h0Said: wrongCandidate.input.expected.h0Said,
      sourceInventorySaid: wrongCandidate.input.expected.sourceInventorySaid,
      arm: 'C2',
      successorRevisionSaid: wrongCandidate.successor.d,
      configurationArtifactSaid: said('z'),
      reviewedImplementationSaid: wrongCandidate.implementation.artifact.d,
      receiptArtifactSaid: wrongCandidate.replay.artifact.d,
    });
    expect(
      await materializeSuccessor(wrongCandidate.input, {
        treatmentReview: wrongCandidate.treatmentReview,
        publicReplay: wrongCandidate.publicReplay,
      }),
    ).toEqual({ kind: 'Blocked', reason: 'Replay' });
  });

  it('does not let a review callback mutate inherited H1 authority', async () => {
    const ready = fixture();
    ready.treatmentReview.review = vi
      .fn()
      .mockImplementation((request: { h1: { authority: { personalAgentAid: string } } }) => {
        request.h1.authority.personalAgentAid = said('z');
        return Promise.resolve({ kind: 'Rejected' });
      });
    expect(
      await materializeSuccessor(ready.input, {
        treatmentReview: ready.treatmentReview,
        publicReplay: ready.publicReplay,
      }),
    ).toEqual({ kind: 'Blocked', reason: 'Review' });
    expect(ready.h1.authority.personalAgentAid).toBe(said('a'));
  });
});
