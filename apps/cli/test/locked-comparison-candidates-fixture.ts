/** Explicit synthetic Q/retrieval inputs with real immutable Git treatment custody.
 * This fixture never admits or claims a live qualified campaign. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  prepareEvaluationSourceInventory,
  prepareQualifiedFailureWindow,
  prepareEvolutionHypothesis,
  prepareEvidenceArtifact,
  prepareSuccessorHarnessRevision,
  prepareEvaluationManifest,
} from '@devrandom/protocol';
import {
  GitCandidateTreatmentCustody,
  GitC2WorkflowTreatmentCustody,
  ReviewedC3ContextSelection,
  reviewEvolutionHypothesisInfluence,
  type ExecutableSuccessorDescriptor,
} from '@devrandom/runtime';
import { QualifiedC2WorkflowTransition } from '../src/evolution/application/qualified-c2-workflow-transition.js';
import type { LockedComparisonInput } from '../src/harness/composition/locked-comparison-execution.js';
import {
  type nativeComparisonFixture,
  nativeSaid as said,
} from './locked-comparison-native-fixture.js';
const execute = promisify(execFile);
async function git(directory: string, ...args: string[]) {
  return (await execute('git', ['-C', directory, ...args])).stdout.trim();
}
export async function nativeCandidateRepository(root: string) {
  const directory = join(root, 'candidate-custody');
  await cp(resolve('fixtures/cesr-receipt-service'), directory, { recursive: true });
  await git(directory, 'init', '--object-format=sha1');
  await git(directory, 'add', '.');
  await git(
    directory,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'Synthetic H1 source',
  );
  return {
    directory,
    commit: await git(directory, 'rev-parse', 'HEAD'),
    tree: await git(directory, 'rev-parse', 'HEAD^{tree}'),
  };
}
export async function nativeComparisonCandidates(
  fixture: Awaited<ReturnType<typeof nativeComparisonFixture>>,
  repository: Awaited<ReturnType<typeof nativeCandidateRepository>>,
  implicatedComponent: 'Workflow' | 'ContextSelection' = 'Workflow',
) {
  const { manifest: initial, baseline: h1, profile } = fixture;
  const inventory = prepareEvaluationSourceInventory({
    taskId: initial.taskId,
    taskRevisionSaid: initial.taskRevisionSaid,
    ownerAid: initial.ownerAid,
    repositoryResourceSaid: said('g'),
    corpusSaid: said('c'),
    experienceMandateSaid: said('M'),
    sources: [
      {
        episodeSaid: said('e'),
        rawEvidenceSaid: said('r'),
        ownerAid: initial.ownerAid,
        repositoryResourceSaid: said('g'),
        corpusSaid: said('c'),
        disclosure: 'AuthorizedAnalogy',
      },
    ],
  });
  const window = prepareQualifiedFailureWindow({
    version: 1,
    kind: 'QualifiedFailureWindow',
    taskId: initial.taskId,
    taskRevisionSaid: initial.taskRevisionSaid,
    originRunId: initial.originRunId,
    retainedCheckpointSaid: initial.retainedCheckpointSaid,
    retainedSealSaid: initial.retainedSealSaid,
    failureEventSaid: said('f'),
    verifierReceiptSaid: said('b'),
    precedingEventSaids: [said('P')],
  });
  if (inventory.kind !== 'Prepared' || window.kind !== 'Prepared')
    throw new Error('Synthetic Q inputs');
  const hypothesis = prepareEvolutionHypothesis({
    taskId: initial.taskId,
    taskRevisionSaid: initial.taskRevisionSaid,
    originRunId: initial.originRunId,
    retainedCheckpointSaid: initial.retainedCheckpointSaid,
    retainedSealSaid: initial.retainedSealSaid,
    parentRevisionSaid: h1.d,
    personalAgentAid: initial.personalAgentAid,
    sourceInventorySaid: inventory.inventory.d,
    retrievalReceiptSaid: said('q'),
    failure: { eventSaid: said('f'), rawEvidenceSaid: said('b') },
    source: { episodeSaid: said('e'), rawEvidenceSaid: said('r') },
    implicatedComponent,
    predictedCorrection: 'Recheck original public conditions after stopped source capture.',
    publicReplay: {
      failureWindowSaid: window.artifact.d,
      configurationSaid: said('x'),
      nonTreatmentInputsSaid: said('n'),
      failureQuery: 'CESR legacy mismatch',
      predictedAction: 'replan-correctly',
      predictedSourceChoiceSaid: said('h'),
      assertion: 'The source changes the parent action.',
    },
    falsifier: 'The action stays unchanged without the source.',
    regressionRisks: ['More public verification costs time.'],
    rejectedExplanations: ['The prior model had no receipt issue.'],
  });
  if (hypothesis.kind !== 'Prepared') throw new Error('Synthetic H0');
  const ports = {
    retrieval: {
      retrieve: () =>
        Promise.resolve({
          kind: 'Retrieved' as const,
          sources: [{ episodeSaid: said('e'), rawEvidenceSaid: said('r'), score: 0.9 }],
          queryReceiptSaid: said('q'),
          chargedMicroUsd: 1,
        }),
    },
    reading: {
      read: () =>
        Promise.resolve({
          kind: 'Read' as const,
          bytes: Buffer.from('raw authorized fixture episode'),
          totalBytes: 30,
          sourceSaid: said('e'),
          readReceiptSaid: said('d'),
        }),
    },
    projection: {
      project: () =>
        Promise.resolve({
          kind: 'Projected' as const,
          episodeSaid: said('e'),
          rawEvidenceSaid: said('r'),
          readReceiptSaid: said('d'),
          observation: 'legacy marker mismatch',
          recoveryHint: 'verify current marker',
        }),
    },
    choice: {
      recalculate: ({ view }: { view: { sources: readonly unknown[] } }) =>
        Promise.resolve(
          view.sources.length > 0
            ? {
                kind: 'Chosen' as const,
                action: 'replan-correctly',
                sourceChoiceSaid: said('h'),
                citationSaids: [said('e')],
              }
            : {
                kind: 'Chosen' as const,
                action: 'submit-now',
                sourceChoiceSaid: said('u'),
                citationSaids: [],
              },
        ),
    },
  };
  const influence = await reviewEvolutionHypothesisInfluence(
    {
      hypothesis: hypothesis.hypothesis,
      inventory: inventory.inventory,
      retained: {
        taskId: initial.taskId,
        taskRevisionSaid: initial.taskRevisionSaid,
        originRunId: initial.originRunId,
        retainedCheckpointSaid: initial.retainedCheckpointSaid,
        retainedSealSaid: initial.retainedSealSaid,
        parentRevisionSaid: h1.d,
        personalAgentAid: initial.personalAgentAid,
        failureEventSaid: said('f'),
        failureRawEvidenceSaid: said('b'),
      },
    },
    ports,
  );
  if (influence.kind !== 'Influenced') throw new Error('Synthetic causal influence');
  const build = async (arm: 'C1' | 'C2' | 'C3') => {
    await git(repository.directory, 'checkout', '-B', `fixture-${arm}`, repository.commit);
    const configurationBytes = Buffer.from(
      JSON.stringify(
        arm === 'C1'
          ? {
              version: 1,
              arm,
              instructionText: 'Verify public compatibility after each focused edit.',
            }
          : arm === 'C2'
            ? { version: 1, arm }
            : {
                version: 1,
                arm,
                formatMarker: 'Current',
                triggerPaths: ['src/lib.rs'],
                priority: ['Failure', 'Contract', 'Edit'],
                maximumItems: 3,
                maximumContextBytes: 4096,
              },
      ),
    );
    const implementationBytes = Buffer.from(
      JSON.stringify(
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
      ),
    );
    const configuration = prepareEvidenceArtifact(configurationBytes, 'application/json');
    const implementation = prepareEvidenceArtifact(implementationBytes, 'application/octet-stream');
    const replay = prepareEvidenceArtifact(
      Buffer.from('{"version":1,"kind":"FixtureReviewedPublicReplay"}'),
      'application/json',
    );
    if (
      configuration.kind !== 'Prepared' ||
      implementation.kind !== 'Prepared' ||
      replay.kind !== 'Prepared'
    )
      throw new Error('Fixture treatment bytes');
    const binding = {
      parentRevisionSaid: h1.d,
      arm,
      h0Said: hypothesis.hypothesis.d,
      taskRevisionSaid: initial.taskRevisionSaid,
      sourceInventorySaid: inventory.inventory.d,
      executionProfileSaid: profile.d,
    };
    const successor = prepareSuccessorHarnessRevision({
      ...binding,
      configurationArtifactSaid: configuration.artifact.d,
      treatment:
        arm === 'C1'
          ? { kind: 'Instruction' }
          : {
              kind: arm === 'C2' ? 'ReviewedWorkflow' : 'ContextSelection',
              reviewedImplementationSaid: implementation.artifact.d,
              publicReplayReceiptSaid: replay.artifact.d,
            },
    });
    if (successor.kind !== 'Prepared') throw new Error('Fixture successor');
    const directory = join(repository.directory, '.devrandom/evolution');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'treatment.json'), configurationBytes);
    if (arm !== 'C1') await writeFile(join(directory, 'implementation.bin'), implementationBytes);
    await git(repository.directory, 'add', '-f', '.devrandom/evolution');
    await git(
      repository.directory,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '-m',
      `Synthetic ${arm} treatment`,
    );
    const reviewed: ExecutableSuccessorDescriptor = {
      h1,
      successorRevisionSaid: successor.revision.d,
      binding,
      treatment: successor.revision.treatment,
      configuration: configuration.artifact,
      ...(arm === 'C1' ? {} : { implementation: implementation.artifact, replay: replay.artifact }),
    };
    return {
      reviewed,
      successorBytes: Buffer.from(JSON.stringify(successor.revision)),
      repositoryDirectory: repository.directory,
      candidateCommit: await git(repository.directory, 'rev-parse', 'HEAD'),
      candidateTree: await git(repository.directory, 'rev-parse', 'HEAD^{tree}'),
    };
  };
  const C1 = await build('C1');
  const C2 = await build('C2');
  const C3 = await build('C3');
  const manifestFields = Object.fromEntries(
    Object.entries(initial).filter(([name]) => !['d', 'version', 'kind', 'slots'].includes(name)),
  );
  const prepared = prepareEvaluationManifest({
    ...manifestFields,
    allocation: {
      ...initial.allocation,
      perEntry: {
        ...initial.allocation.perEntry,
        providerRequests: 10,
        providerInputTokens: 100_000,
      },
      finalization: {
        ...initial.allocation.finalization,
        runWallTimeSeconds: 1800,
        aggregateChildCommandTimeSeconds: 1800,
      },
    },
    revisions: {
      H1: h1.d,
      C1: C1.reviewed.successorRevisionSaid,
      C2: C2.reviewed.successorRevisionSaid,
      C3: C3.reviewed.successorRevisionSaid,
    },
    hypothesisSaid: hypothesis.hypothesis.d,
    sourceInventorySaid: inventory.inventory.d,
  });
  if (prepared.kind !== 'Prepared') throw new Error('Fixture comparison manifest');
  const historyBytes = Buffer.from('Public current CESR compatibility requirement.');
  const history = prepareEvidenceArtifact(historyBytes, 'text/plain; charset=utf-8');
  if (history.kind !== 'Prepared') throw new Error('Fixture public history');
  const candidates: LockedComparisonInput['candidates'] = {
    C1: { ...C1, custody: new GitCandidateTreatmentCustody() },
    C2: {
      hypothesis: hypothesis.hypothesis,
      reviewed: C2.reviewed,
      candidateCommit: C2.candidateCommit,
      candidateTree: C2.candidateTree,
      transition: new QualifiedC2WorkflowTransition({
        ...C2,
        constructed: { kind: 'Constructed', hypothesis: hypothesis.hypothesis, window, influence },
        inventory: inventory.inventory,
        custody: new GitC2WorkflowTreatmentCustody(),
        ...ports,
      }),
    },
    C3: () =>
      new ReviewedC3ContextSelection({
        ...C3,
        hypothesis: hypothesis.hypothesis,
        custody: new GitC2WorkflowTreatmentCustody(),
        history: {
          read: () =>
            Promise.resolve({
              kind: 'Read',
              taskId: initial.taskId,
              taskRevisionSaid: initial.taskRevisionSaid,
              sourceInventorySaid: inventory.inventory.d,
              sources: [
                {
                  sourceId: history.artifact.d,
                  artifact: history.artifact,
                  bytes: historyBytes,
                  kind: 'Failure',
                  version: 'Current',
                  custody: 'Public',
                },
              ],
            }),
        },
        projection: {
          project: (source) =>
            Promise.resolve({
              kind: 'Projected',
              sourceId: source.sourceId,
              text: 'Read exact public compatibility evidence before editing.',
            }),
        },
      }),
  };
  return { manifest: prepared.manifest, candidates, hypothesis: hypothesis.hypothesis };
}
