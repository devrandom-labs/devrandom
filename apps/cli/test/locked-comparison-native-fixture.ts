/** Explicit synthetic enforcement fixture. No campaign, model call, or live authority. */
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  prepareEvaluationExecutionProfile,
  prepareBaselineHarnessRevision,
  identifyHarnessInstruction,
  identifyHarnessCompletionCommand,
  taskBudgetCeilings,
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
  encodeEvaluationVerifierBundle,
} from '@devrandom/protocol';
import {
  AesGcmProtectedCaseCustody,
  SourceCustody,
  FileEvaluationCaseInventory,
} from '@devrandom/runtime';

export const nativeSaid = (letter: string) => `E${letter.repeat(43)}`;
export const nativeAllowance = {
  providerRequests: 20,
  providerInputTokens: 200_000,
  providerOutputTokens: 20_000,
  providerSpendMicroUsd: 100_000,
  runWallTimeSeconds: 300,
  toolProposals: 30,
  aggregateChildCommandTimeSeconds: 120,
  changedFiles: 10,
  changedWorktreeBytes: 100_000,
  evidencePlusArtifactsPerRunBytes: 2_000_000,
};
export async function nativeComparisonFixture(
  root: string,
  image: string,
  runtimeDigest = `sha256:${'2'.repeat(64)}`,
  repository?: {
    readonly commit: string;
    readonly tree: string;
    readonly runtimePromptDigest: string;
    readonly taskBudgets?: typeof taskBudgetCeilings;
  },
) {
  const profile = prepareEvaluationExecutionProfile({
    os: 'linux',
    architecture: 'aarch64',
    imageDigest: image.slice(image.lastIndexOf('@') + 1),
    runtimeDigest,
    toolchainDigest: `sha256:${'3'.repeat(64)}`,
    sourceGitCommit: repository?.commit ?? '4'.repeat(40),
    sourceGitTree: repository?.tree ?? '5'.repeat(40),
    h1InstructionSaid: nativeSaid('i'),
    h1RuntimePromptDigest: repository?.runtimePromptDigest ?? `sha256:${'6'.repeat(64)}`,
    effectiveLimitsReceiptSaid: nativeSaid('l'),
    parentDeathCleanupReceiptSaid: nativeSaid('p'),
    modelProvider: 'concentrate',
    modelId: 'deepinfra/deepseek-v4-flash-0731',
    thinkingLevel: 'low',
    maximumOutputTokens: 512,
    limits: {
      cpuCount: 1,
      memoryBytes: 512 * 1024 * 1024,
      processCount: 64,
      scratchBytes: 128 * 1024 * 1024,
      outputBytes: 128 * 1024,
      wallTimeSeconds: 300,
    },
    containment: {
      nonRoot: true,
      readOnlyRuntime: true,
      networkDisabled: true,
      privilegesDropped: true,
      restrictedIpc: true,
      parentDeathCleanup: true,
    },
  });
  if (profile.kind !== 'Prepared') throw new Error('native profile fixture');
  const sourceDirectory = join(root, 'source');
  await cp(resolve('fixtures/cesr-receipt-service'), sourceDirectory, { recursive: true });
  await mkdir(join(sourceDirectory, 'src/private'), { recursive: true });
  await writeFile(join(sourceDirectory, 'src/private/canary.txt'), 'fixture-private-canary');
  const source = new SourceCustody(join(root, 'source-custody'), {
    maximumFiles: 64,
    maximumBytes: 1024 * 1024,
    maximumPathBytes: 256,
  });
  const clean = await source.capture(sourceDirectory, () => Promise.resolve(false));
  if (clean.kind !== 'Captured') throw new Error('native source fixture');
  const evaluationId = randomUUID();
  const taskId = randomUUID();
  const instruction = identifyHarnessInstruction({
    path: 'AGENTS.md',
    content: '# Synthetic native smoke\n',
  });
  const command = identifyHarnessCompletionCommand(
    {
      id: 'fixture-native-test',
      argv: ['node', '-e', 'console.log("native fixture command")'],
      timeoutSeconds: 10,
      expected: { kind: 'exitCode', code: 0 },
    },
    '/usr/local/bin/node',
  );
  if (instruction.kind !== 'Identified' || command.kind !== 'Identified')
    throw new Error('baseline resources fixture');
  const capabilities = ['ReadRepository', 'EditRepository', 'RunTests', 'SubmitResult'] as const;
  const baseline = prepareBaselineHarnessRevision({
    task: {
      taskId,
      revisionSaid: nativeSaid('t'),
      harnessLineageId: randomUUID(),
      requestedCapabilities: capabilities,
    },
    authority: {
      personalAgentAid: nativeSaid('a'),
      taskMandateSaid: nativeSaid('m'),
      allowedCapabilities: capabilities,
    },
    repository: {
      objectFormat: 'sha1',
      commit: profile.profile.sourceGitCommit,
      tree: profile.profile.sourceGitTree,
      instructionResources: [instruction.resource],
    },
    completionCommands: [command.command],
    toolCommands: [],
    modelCompatibility: {
      provider: profile.profile.modelProvider,
      model: profile.profile.modelId,
      contextWindowTokens: 131072,
      maximumOutputTokens: 512,
      thinkingLevel: 'low',
      credentialSource: 'FIXTURE_ONLY_NO_CREDENTIAL',
      toolCalls: 'Supported',
      usageAccounting: 'Required',
    },
    environmentCompatibility: {
      operatingSystem: 'linux',
      architecture: 'arm64',
      nodeVersion: '24.20.0',
      gitVersion: '2.51.0',
      piSdkVersion: '0.87.1',
      xstateVersion: '5.33.2',
    },
    capabilities: { available: capabilities, unavailable: [] },
    budgetCeilings: {
      task: repository?.taskBudgets ?? taskBudgetCeilings,
      server: taskBudgetCeilings,
      mandate: repository?.taskBudgets ?? taskBudgetCeilings,
    },
  });
  if (baseline.kind !== 'Prepared') throw new Error('baseline fixture');
  const custody = new AesGcmProtectedCaseCustody(randomBytes(32));
  const seal = async (
    objectSaid: string,
    purpose: 'TrialHoldout' | 'TerminalCase',
    segment: number,
  ) => {
    const stimulus = await custody.seal({
      evaluationId,
      objectSaid,
      purpose,
      segment,
      plaintext: Buffer.from(`-AAL${nativeSaid('q')}`),
    });
    const expected = await custody.seal({
      evaluationId,
      objectSaid,
      purpose: 'OracleObservation',
      segment,
      plaintext: Buffer.from(
        JSON.stringify({
          kind: 'Parsed',
          receipts: [{ version: 'Current', payload: nativeSaid('q') }],
        }),
      ),
    });
    if (stimulus.kind !== 'Sealed' || expected.kind !== 'Sealed')
      throw new Error('native case fixture');
    return { objectSaid, stimulus: stimulus.artifact, expected: expected.artifact };
  };
  const oracleDigest = `sha256:${'a'.repeat(64)}`;
  const verifier = prepareEvaluationVerifierBundle({
    evaluationId,
    taskId,
    taskRevisionSaid: nativeSaid('t'),
    ownerAid: nativeSaid('o'),
    personalAgentAid: nativeSaid('a'),
    policySaid: nativeSaid('P'),
    executionProfileSaid: profile.profile.d,
    oracleAdapterDigest: oracleDigest,
    reviewedRecipeSaid: nativeSaid('r'),
    toolchainSaid: nativeSaid('T'),
    publicConditions: [
      {
        id: 'cesr-current',
        stimulusBase64Url: Buffer.from(`-AAL${nativeSaid('x')}`).toString('base64url'),
        expected: { kind: 'Parsed', receipts: [{ version: 'Current', payload: nativeSaid('x') }] },
      },
      {
        id: 'cesr-legacy',
        stimulusBase64Url: Buffer.from(`-AAN-_AAABAA${nativeSaid('x')}`).toString('base64url'),
        expected: { kind: 'Parsed', receipts: [{ version: 'Legacy', payload: nativeSaid('x') }] },
      },
      {
        id: 'cesr-tamper',
        stimulusBase64Url: Buffer.from('-AAA').toString('base64url'),
        expected: { kind: 'Rejected', error: 'AnyRejection' },
      },
    ],
    protectedCase: await seal(nativeSaid('H'), 'TrialHoldout', 0),
    terminalCase: await seal(nativeSaid('F'), 'TerminalCase', 1),
  });
  if (verifier.kind !== 'Prepared') throw new Error('native verifier fixture');
  const manifest = prepareEvaluationManifest({
    evaluationId,
    taskId,
    taskRevisionSaid: nativeSaid('t'),
    originRunId: randomUUID(),
    ownerAid: nativeSaid('o'),
    personalAgentAid: nativeSaid('a'),
    taskMandateSaid: nativeSaid('m'),
    retainedCheckpointSaid: nativeSaid('c'),
    retainedSealSaid: nativeSaid('s'),
    policySaid: nativeSaid('P'),
    revisions: {
      H1: baseline.revision.d,
      C1: nativeSaid('j'),
      C2: nativeSaid('k'),
      C3: nativeSaid('n'),
    },
    executionProfileSaid: profile.profile.d,
    sourceInventorySaid: nativeSaid('I'),
    hypothesisSaid: nativeSaid('Y'),
    verifierSaid: verifier.bundle.d,
    protectedCaseArtifactSaid: verifier.bundle.protectedCase.stimulus.d,
    finalCaseArtifactSaid: verifier.bundle.terminalCase.stimulus.d,
    publicConditionIds: verifier.bundle.publicConditions.map((c) => c.id),
    heldOutCaseCount: 1,
    allocation: {
      diagnosis: nativeAllowance,
      perEntry: nativeAllowance,
      finalization: nativeAllowance,
    },
  });
  if (manifest.kind !== 'Prepared') throw new Error('native manifest fixture');
  const encoded = encodeEvaluationVerifierBundle(verifier.bundle);
  if (encoded.kind !== 'Encoded') throw new Error('native bundle fixture');
  const casesDirectory = join(root, 'private-cases');
  await mkdir(casesDirectory, { mode: 0o700 });
  await writeFile(join(casesDirectory, verifier.bundle.d), encoded.bytes, { mode: 0o600 });
  return {
    image,
    baseline: baseline.revision,
    profile: profile.profile,
    manifest: manifest.manifest,
    verifier: verifier.bundle,
    source,
    sourceDirectory,
    cleanSourceSaid: clean.sourceSaid,
    custody,
    cases: new FileEvaluationCaseInventory(casesDirectory),
    oracle: { inspect: () => Promise.resolve({ kind: 'Reviewed' as const, digest: oracleDigest }) },
  };
}
