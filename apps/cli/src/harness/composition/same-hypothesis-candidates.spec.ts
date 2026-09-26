import { bindC1TrialBehavior } from '../../../../../packages/runtime/src/evaluation/application/bind-c1-trial-behavior.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvaluationExecutionBinding } from '@devrandom/domain';
import { digestRunRuntimePrompt } from '@devrandom/runtime';
import { prepareEvaluationManifest } from '@devrandom/protocol';
import { expect, it } from 'vitest';
import {
  nativeCandidateRepository,
  nativeComparisonCandidates,
} from '../../../test/locked-comparison-candidates-fixture.js';
import {
  nativeComparisonFixture,
  nativeSaid,
} from '../../../test/locked-comparison-native-fixture.js';

it.each(['Workflow', 'ContextSelection'] as const)(
  'binds distinct C2/C3 remedies to the same frozen %s hypothesis and rejects substitution',
  async (component) => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'same-hypothesis-fixture-'));
    try {
      const repository = await nativeCandidateRepository(root);
      const fixture = await nativeComparisonFixture(
        root,
        `sha256:${'1'.repeat(64)}`,
        `sha256:${'2'.repeat(64)}`,
        {
          ...repository,
          runtimePromptDigest: digestRunRuntimePrompt('fixture-system', 'fixture-task'),
        },
      );
      const { manifest, candidates, hypothesis } = await nativeComparisonCandidates(
        fixture,
        repository,
        component,
      );
      const binding = (arm: 'C2' | 'C3'): EvaluationExecutionBinding => ({
        kind: 'Evaluation',
        evaluationId: manifest.evaluationId,
        evidenceStreamId: randomUUID(),
        originRunId: manifest.originRunId,
        taskId: manifest.taskId,
        taskRevisionSaid: manifest.taskRevisionSaid,
        personalAgentAid: manifest.personalAgentAid,
        taskMandateSaid: manifest.taskMandateSaid,
        harnessRevisionSaid: manifest.revisions[arm],
        evaluationLeaseId: randomUUID(),
        phase: { kind: 'Trial', manifestSaid: manifest.d, arm, repetition: 1, attempt: 1 },
      });
      const signal = new AbortController().signal;
      const treatment = await candidates.C1.custody.read({
        repositoryDirectory: candidates.C1.repositoryDirectory,
        candidateCommit: candidates.C1.candidateCommit,
        candidateTree: candidates.C1.candidateTree,
        parentCommit: fixture.baseline.repository.commit,
        parentTree: fixture.baseline.repository.tree,
        arm: 'C1',
        signal,
      });
      expect(treatment.kind).toBe('Read');
      if (treatment.kind !== 'Read') throw new Error('C1 custody');
      expect(
        bindC1TrialBehavior({
          ...candidates.C1,
          treatmentBytes: treatment.bytes,
          manifest,
          profile: fixture.profile,
          baseSystemPrompt: 'fixture-system',
          taskPrompt: 'fixture-task',
        }),
      ).toMatchObject({ kind: 'Bound' });

      expect(hypothesis.implicatedComponent).toBe(component);
      expect(candidates.C2.reviewed.binding.h0Said).toBe(manifest.hypothesisSaid);
      const c2 = await candidates.C2.transition.prepare({
        binding: binding('C2'),
        manifest,
        slot: { arm: 'C2', repetition: 1, attempt: 1 },
        successorRevisionSaid: manifest.revisions.C2,
        candidateCommit: candidates.C2.candidateCommit,
        candidateTree: candidates.C2.candidateTree,
        signal,
      });
      expect(c2).toMatchObject({ kind: 'Prepared', hypothesisSaid: manifest.hypothesisSaid });
      const c3Input = {
        binding: binding('C3'),
        manifest,
        slot: { arm: 'C3' as const, repetition: 1 as const, attempt: 1 as const },
        profile: fixture.profile,
        baseSystemPrompt: 'fixture-system',
        taskPrompt: 'fixture-task',
        signal,
      };
      for (const repetition of [1, 2, 3] as const) {
        const selection = candidates.C3();
        expect(
          await selection.bind({
            ...c3Input,
            binding: {
              ...c3Input.binding,
              phase: { kind: 'Trial', manifestSaid: manifest.d, arm: 'C3', repetition, attempt: 1 },
            },
            slot: { ...c3Input.slot, repetition },
          }),
        ).toMatchObject({ kind: 'Bound' });
        expect(await selection.bind(c3Input)).toEqual({ kind: 'Blocked' });
      }
      const fields = Object.fromEntries(
        Object.entries(manifest).filter(
          ([name]) => !['d', 'version', 'kind', 'slots'].includes(name),
        ),
      );
      const other = prepareEvaluationManifest({ ...fields, hypothesisSaid: nativeSaid('Z') });
      if (other.kind !== 'Prepared') throw new Error('substitution fixture');
      expect(
        await candidates.C3().bind({
          ...c3Input,
          manifest: other.manifest,
          binding: {
            ...c3Input.binding,
            phase: {
              kind: 'Trial',
              manifestSaid: other.manifest.d,
              arm: 'C3',
              repetition: 1,
              attempt: 1,
            },
          },
        }),
      ).toEqual({ kind: 'Blocked' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
