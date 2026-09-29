import type { TaskBudgets } from '@devrandom/domain';
import { describe, expect, it } from 'vitest';

import {
  decodePublicVerifierReceipt,
  decodeVerifiedCheckpoint,
  identifyCheckpointFileContent,
  preparePublicVerifierReceipt,
  prepareVerifiedCheckpoint,
  type PublicVerifierReceipt,
  type VerifiedCheckpointDraft,
} from './verified-checkpoint.js';

const said = (character: string) => 'E'.concat(character.repeat(43));

function budgets(value: number): TaskBudgets {
  return {
    workAccessAttemptLifetimeSeconds: value,
    workAccessGrantLifetimeSeconds: value,
    nonterminalAttemptsPerUserClient: value,
    activeGrantsPerUserClient: value,
    publicAttemptCreationsPerMinutePerLoopbackSource: value,
    nonterminalAttemptsGlobally: value,
    requestsPerGrant: value,
    tasksPerAdmittedUser: value,
    runsPerAdmittedUser: value,
    activeRunsPerAdmittedUser: value,
    hostedWorkTasksGlobally: value,
    hostedWorkRunsGlobally: value,
    activeHostedWorkRunsGlobally: value,
    ordinaryJsonRequestBodyBytes: value,
    evidenceBatchBodyBytes: value,
    artifactRequestBodyBytes: value,
    evidencePlusArtifactsPerRunBytes: value,
    acceptedEvidencePlusArtifactsGloballyBytes: value,
    runWallTimeSeconds: value,
    providerRequests: value,
    providerInputTokens: value,
    providerOutputTokens: value,
    toolProposals: value,
    aggregateChildCommandTimeSeconds: value,
    oneChildCommandTimeSeconds: value,
    changedFiles: value,
    changedWorktreeBytes: value,
    providerSpendMicroUsd: value,
  };
}

function receipt(): PublicVerifierReceipt {
  const prepared = preparePublicVerifierReceipt({
    version: 1,
    completionConditionId: 'public-tests',
    commandSaid: said('j'),
    recordedAt: '2026-09-24T20:00:09.000Z',
    outcome: {
      kind: 'Rejected',
      reason: {
        kind: 'UnexpectedExitCode',
        expected: 0,
        observed: 1,
      },
      elapsedMilliseconds: 1_200,
      outputArtifactSaids: [said('k')],
    },
  });
  if (prepared.kind !== 'Prepared') {
    throw new Error('fixture receipt must prepare');
  }
  return prepared.receipt;
}

function draft(
  verifierReceipt: PublicVerifierReceipt,
): Extract<VerifiedCheckpointDraft, { readonly version: 1 }> {
  return {
    version: 1,
    taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
    taskRevisionSaid: said('a'),
    runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
    incarnationId: 'ee87e11d-fb5f-46b4-841f-8a7a5faad97c',
    harnessRevisionSaid: said('b'),
    harnessLineageId: '34657aa0-0130-451c-b699-f6bb5fa2cae3',
    personalAgentAid: said('c'),
    governorAid: said('d'),
    taskMandateSaid: said('e'),
    promotionMandateSaid: said('f'),
    purpose: { kind: 'Retained' },
    repository: {
      objectFormat: 'sha1',
      baseCommit: '1'.repeat(40),
      baseTree: '2'.repeat(40),
      changedFiles: [
        {
          path: 'src/receipt.rs',
          disposition: 'Modified',
          mode: '100644',
          contentSaid: said('g'),
        },
      ],
    },
    outputArtifactSaids: [said('h')],
    verifierReceipts: [verifierReceipt],
    evidence: { eventCount: 12, finalSequence: 11, chainHeadSaid: said('i') },
    budget: { consumed: budgets(0), remaining: budgets(1) },
    runState: {
      kind: 'Active',
      phase: { kind: 'Blocked', reason: 'HarnessCompatibilityFailure' },
      verification: { kind: 'Rejected' },
    },
    continuation: { kind: 'LaterHarnessCompatibilityResolutionRequired' },
  };
}

describe('verified checkpoint protocol', () => {
  it.each([6, 8, 9, 10, 16, 17])(
    'retains remaining Run quota %s only within the supported recovery ceiling',
    (quota) => {
      const original = draft(receipt());
      const prepared = prepareVerifiedCheckpoint(
        {
          ...original,
          budget: {
            ...original.budget,
            remaining: { ...original.budget.remaining, runsPerAdmittedUser: quota },
          },
        },
        ['public-tests'],
      );
      expect(prepared.kind).toBe(quota <= 16 ? 'Prepared' : 'Rejected');
      if (prepared.kind === 'Prepared')
        expect(decodeVerifiedCheckpoint(prepared.checkpoint, ['public-tests']).kind).toBe(
          'Accepted',
        );
    },
  );

  it('accepts only a blocked secret checkpoint with an exact privacy marker pair and no manifest', () => {
    const input = draft(receipt());
    const privacy = {
      ...input,
      version: 2,
      repository: {
        objectFormat: 'sha1',
        baseCommit: '1'.repeat(40),
        baseTree: '2'.repeat(40),
        repositoryMeasurement: {
          kind: 'UnavailableBecauseSecret',
          disclosure: { kind: 'WithheldSecret', reason: 'Credential', byteLength: 43 },
          dataWithheldEventSaid: said('w'),
          securityViolationEventSaid: said('z'),
        },
      },
      evidence: { eventCount: 12, finalSequence: 11, chainHeadSaid: said('z') },
      runState: {
        kind: 'Active',
        phase: { kind: 'Blocked', reason: 'SecretDetected' },
        verification: { kind: 'Rejected' },
      },
      continuation: { kind: 'ExternalResolutionRequired', reason: 'SecretDetected' },
    } as unknown as Extract<VerifiedCheckpointDraft, { readonly version: 2 }>;
    const prepared = prepareVerifiedCheckpoint(privacy, ['public-tests']);
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') throw new Error('privacy checkpoint must prepare');
    expect(decodeVerifiedCheckpoint(prepared.checkpoint, ['public-tests']).kind).toBe('Accepted');
    expect(
      prepareVerifiedCheckpoint(
        { ...privacy, runState: input.runState } as unknown as VerifiedCheckpointDraft,
        ['public-tests'],
      ),
    ).toEqual({
      kind: 'Rejected',
      reason: 'SchemaInvalid',
    });
    expect(
      prepareVerifiedCheckpoint(
        {
          ...privacy,
          repository: { ...privacy.repository, changedFiles: [] },
        } as unknown as VerifiedCheckpointDraft,
        ['public-tests'],
      ).kind,
    ).toBe('Rejected');
  });
  it('round-trips actual consumption above the admission ceiling in an exhausted checkpoint', () => {
    const input = draft(receipt());
    const prepared = prepareVerifiedCheckpoint(
      {
        ...input,
        budget: {
          consumed: { ...input.budget.consumed, providerOutputTokens: 100_001 },
          remaining: { ...input.budget.remaining, providerOutputTokens: 0 },
        },
        runState: {
          kind: 'Active',
          phase: { kind: 'Blocked', reason: 'BudgetExhausted' },
          verification: input.runState.verification,
        },
        continuation: { kind: 'ExternalResolutionRequired', reason: 'BudgetExhausted' },
      },
      ['public-tests'],
    );
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') throw new Error('exhausted checkpoint must prepare');
    expect(decodeVerifiedCheckpoint(prepared.checkpoint, ['public-tests'])).toEqual({
      kind: 'Accepted',
      checkpoint: prepared.checkpoint,
    });
  });

  it('round-trips revoked calibration authority without continuation', () => {
    const input = draft(receipt());
    const prepared = prepareVerifiedCheckpoint(
      {
        ...input,
        purpose: {
          kind: 'PreparedCompatibilityCalibration',
          campaignId: '57ed9f1a-b444-44b2-95c9-fd780c90a7dd',
          ordinal: 1,
        },
        runState: {
          kind: 'Ended',
          outcome: { kind: 'AuthorityRevoked', mandateSaid: input.taskMandateSaid },
          verification: input.runState.verification,
        },
        continuation: { kind: 'NoContinuation' },
      },
      ['public-tests'],
    );
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') throw new Error('revocation checkpoint must prepare');
    expect(decodeVerifiedCheckpoint(prepared.checkpoint, ['public-tests'])).toEqual({
      kind: 'Accepted',
      checkpoint: prepared.checkpoint,
    });
  });
  it.each([
    { kind: 'Retained' },
    {
      kind: 'PreparedCompatibilityCalibration',
      campaignId: '57ed9f1a-b444-44b2-95c9-fd780c90a7dd',
      ordinal: 1,
    },
  ] as const)(
    'binds a $kind secret-detection block to its external-resolution reason',
    (purpose) => {
      const input = draft(receipt());
      const prepared = prepareVerifiedCheckpoint(
        {
          ...input,
          purpose,
          runState: {
            kind: 'Active',
            phase: { kind: 'Blocked', reason: 'SecretDetected' },
            verification: input.runState.verification,
          },
          continuation: { kind: 'ExternalResolutionRequired', reason: 'SecretDetected' },
        },
        ['public-tests'],
      );
      expect(prepared.kind).toBe('Prepared');
      if (prepared.kind !== 'Prepared') throw new Error('privacy checkpoint must prepare');
      expect(decodeVerifiedCheckpoint(prepared.checkpoint, ['public-tests'])).toEqual({
        kind: 'Accepted',
        checkpoint: prepared.checkpoint,
      });
    },
  );
  it('identifies exact changed-file bytes without the evidence-artifact size ceiling', () => {
    const bytes = new Uint8Array(600 * 1_024).fill(97);
    const first = identifyCheckpointFileContent(bytes);
    const second = identifyCheckpointFileContent(bytes);
    const changed = identifyCheckpointFileContent(new Uint8Array(bytes.length).fill(98));

    expect(first).toMatchObject({ kind: 'Identified', byteLength: bytes.byteLength });
    expect(second).toEqual(first);
    expect(changed).not.toEqual(first);
  });

  it('content-binds a typed public-condition receipt', () => {
    const verifierReceipt = receipt();

    expect(decodePublicVerifierReceipt(verifierReceipt)).toEqual({
      kind: 'Accepted',
      receipt: verifierReceipt,
    });
    expect(
      decodePublicVerifierReceipt({
        ...verifierReceipt,
        completionConditionId: 'different-condition',
      }),
    ).toEqual({ kind: 'Rejected', reason: 'SaidMismatch' });
  });

  it('binds every normative checkpoint field and exact blocked continuation', () => {
    const verifierReceipt = receipt();
    const prepared = prepareVerifiedCheckpoint(draft(verifierReceipt), ['public-tests']);

    expect(prepared).toMatchObject({
      kind: 'Prepared',
      checkpoint: {
        version: 1,
        runState: {
          kind: 'Active',
          phase: { kind: 'Blocked', reason: 'HarnessCompatibilityFailure' },
          verification: { kind: 'Rejected' },
        },
        continuation: { kind: 'LaterHarnessCompatibilityResolutionRequired' },
        evidence: { eventCount: 12, finalSequence: 11, chainHeadSaid: said('i') },
      },
    });
    if (prepared.kind !== 'Prepared') {
      throw new Error('fixture checkpoint must prepare');
    }
    expect(prepared.checkpoint.d).toMatch(/^[A-Z][A-Za-z0-9_-]{43}$/u);
    expect(decodeVerifiedCheckpoint(prepared.checkpoint, ['public-tests'])).toEqual({
      kind: 'Accepted',
      checkpoint: prepared.checkpoint,
    });
  });

  it('rejects incomplete receipts, unsorted changed files, and an incompatible continuation', () => {
    const verifierReceipt = receipt();
    const completeDraft = draft(verifierReceipt);

    expect(prepareVerifiedCheckpoint(completeDraft, ['public-tests', 'tamper-tests'])).toEqual({
      kind: 'Rejected',
      reason: 'VerifierReceiptSetIncomplete',
    });
    expect(
      prepareVerifiedCheckpoint(
        {
          ...completeDraft,
          repository: {
            ...completeDraft.repository,
            changedFiles: [
              {
                path: 'z-last',
                disposition: 'Added',
                mode: '100644',
                contentSaid: said('l'),
              },
              {
                path: 'a-first',
                disposition: 'Added',
                mode: '100644',
                contentSaid: said('m'),
              },
            ],
          },
        },
        ['public-tests'],
      ),
    ).toEqual({ kind: 'Rejected', reason: 'ChangedFileManifestInvalid' });
    expect(
      prepareVerifiedCheckpoint(
        { ...completeDraft, continuation: { kind: 'CurrentIncarnationMayContinue' } },
        ['public-tests'],
      ),
    ).toEqual({ kind: 'Rejected', reason: 'ContinuationMismatch' });
  });

  it('binds a terminal calibration outcome to calibration purpose and no continuation', () => {
    const verifierReceipt = receipt();
    const category = {
      version: 1 as const,
      taskId: '4df838a8-5109-49fd-bdad-805880a3ecee',
      taskRevisionSaid: said('a'),
      harnessRevisionSaid: said('b'),
      currentCommandSaid: said('m'),
      tamperCommandSaid: said('n'),
      legacyCommandSaid: said('o'),
      legacyObservedExitCode: 101 as const,
    };
    const calibration = {
      ...draft(verifierReceipt),
      purpose: {
        kind: 'PreparedCompatibilityCalibration' as const,
        campaignId: '850a99ae-b187-45ca-8f54-5afedb48f977',
        ordinal: 1 as const,
      },
      runState: {
        kind: 'Ended' as const,
        outcome: { kind: 'CalibrationConfirmed' as const, category },
        verification: { kind: 'Rejected' as const },
      },
      continuation: { kind: 'NoContinuation' as const },
    };

    expect(prepareVerifiedCheckpoint(calibration, ['public-tests'])).toMatchObject({
      kind: 'Prepared',
      checkpoint: { purpose: calibration.purpose, runState: calibration.runState },
    });
    expect(
      prepareVerifiedCheckpoint({ ...calibration, purpose: { kind: 'Retained' } }, [
        'public-tests',
      ]),
    ).toEqual({ kind: 'Rejected', reason: 'RunPurposeMismatch' });
  });

  it('permits zero verifier receipts only for a truthful calibration exclusion', () => {
    const excluded = {
      ...draft(receipt()),
      purpose: {
        kind: 'PreparedCompatibilityCalibration' as const,
        campaignId: '850a99ae-b187-45ca-8f54-5afedb48f977',
        ordinal: 2 as const,
      },
      verifierReceipts: [],
      runState: {
        kind: 'Ended' as const,
        outcome: {
          kind: 'CalibrationExcluded' as const,
          reason: 'ProviderUnavailable' as const,
        },
        verification: { kind: 'NotSubmitted' as const },
      },
      continuation: { kind: 'NoContinuation' as const },
    };

    expect(prepareVerifiedCheckpoint(excluded, ['public-tests'])).toMatchObject({
      kind: 'Prepared',
      checkpoint: { verifierReceipts: [], runState: excluded.runState },
    });
    expect(
      prepareVerifiedCheckpoint(
        {
          ...excluded,
          runState: {
            kind: 'Ended',
            outcome: { kind: 'CalibrationRejected', reason: 'ReceiptPatternMismatch' },
            verification: { kind: 'Rejected' },
          },
        },
        ['public-tests'],
      ),
    ).toEqual({ kind: 'Rejected', reason: 'VerifierReceiptSetIncomplete' });
    expect(
      prepareVerifiedCheckpoint(
        {
          ...excluded,
          runState: {
            ...excluded.runState,
            verification: { kind: 'Rejected' },
          },
        },
        ['public-tests'],
      ),
    ).toEqual({ kind: 'Rejected', reason: 'VerifierReceiptSetIncomplete' });
    expect(
      prepareVerifiedCheckpoint(
        {
          ...excluded,
          purpose: { kind: 'Retained' },
          runState: {
            kind: 'Active',
            phase: { kind: 'Blocked', reason: 'HarnessCompatibilityFailure' },
            verification: { kind: 'Rejected' },
          },
          continuation: { kind: 'LaterHarnessCompatibilityResolutionRequired' },
        },
        ['public-tests'],
      ),
    ).toEqual({ kind: 'Rejected', reason: 'VerifierReceiptSetIncomplete' });
  });
});
