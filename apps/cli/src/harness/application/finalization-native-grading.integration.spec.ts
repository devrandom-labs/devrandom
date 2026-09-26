/** Disposable native grading proof; no campaign, provider call, or live authority. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { prepareEvidenceArtifact } from '@devrandom/protocol';
import {
  DockerTaskArtifactConstruction,
  DockerReceiptObservation,
  ExecutableCustody,
  type EvaluationRawArtifacts,
} from '@devrandom/runtime';
import { nativeComparisonFixture } from '../../../test/locked-comparison-native-fixture.js';
import {
  FinalizationNativeGrading,
  type FinalizationNativeMeasurement,
} from './finalization-native-grading.js';
describe.skipIf(process.env.DEVRANDOM_EVAL_IMAGE === undefined)(
  'real finalization native allowance',
  () => {
    it('records actual stopped build and public observation before release, then denies an exhausted native effect', async () => {
      const root = await mkdtemp(join(tmpdir(), 'devrandom-finalization-native-'));
      try {
        const fixture = await nativeComparisonFixture(root, process.env.DEVRANDOM_EVAL_IMAGE ?? '');
        const raws = new Map<string, Uint8Array>();
        const artifacts: EvaluationRawArtifacts = {
          record: ({ bytes, mediaType }) => {
            const prepared = prepareEvidenceArtifact(bytes, mediaType);
            if (prepared.kind !== 'Prepared') return Promise.resolve({ kind: 'Unavailable' });
            raws.set(prepared.artifact.d, bytes);
            return Promise.resolve({ kind: 'Stored', artifact: prepared.artifact });
          },
        };
        const executables = new ExecutableCustody(join(root, 'executables'));
        const construction = new DockerTaskArtifactConstruction({
          source: fixture.source,
          executables,
          profile: fixture.profile,
          image: fixture.image,
          recipeSaid: fixture.verifier.reviewedRecipeSaid,
          toolchainSaid: fixture.verifier.toolchainSaid,
          artifacts,
        });
        const observation = new DockerReceiptObservation({
          executables,
          profile: fixture.profile,
          image: fixture.image,
          artifacts,
        });
        const receipts: FinalizationNativeMeasurement[] = [];
        const grading = new FinalizationNativeGrading({
          maximumSeconds: 120,
          construction,
          observation,
          nowMicroseconds: () => Math.floor(performance.now() * 1000),
          record: (receipt) => {
            expect(raws.has(receipt.rawReceiptSaid)).toBe(true);
            expect(raws.has(receipt.cleanupReceiptSaid)).toBe(true);
            receipts.push(receipt);
            return Promise.resolve(true);
          },
        });
        const signal = new AbortController().signal;
        const built = await grading.build({
          capturedSourceSaid: fixture.cleanSourceSaid,
          reviewedRecipeSaid: fixture.verifier.reviewedRecipeSaid,
          toolchainSaid: fixture.verifier.toolchainSaid,
          containerProfileSaid: fixture.profile.d,
          signal,
        });
        expect(built.kind).toBe('Frozen');
        if (built.kind !== 'Frozen') throw new Error('native build failed');
        const condition = fixture.verifier.publicConditions[0];
        if (condition === undefined) throw new Error('fixture');
        const stimulus = Buffer.from(condition.stimulusBase64Url, 'base64url');
        const prepared = prepareEvidenceArtifact(stimulus, 'text/plain; charset=utf-8');
        if (prepared.kind !== 'Prepared') throw new Error('fixture');
        const request = {
          executableSaid: built.executableSaid,
          stimulus,
          stimulusSaid: prepared.artifact.d,
          caseScope: 'Public' as const,
          signal,
        };
        expect((await grading.observe(request)).kind).toBe('Observed');
        expect(receipts.map((item) => item.operation)).toEqual(['Build', 'PublicObservation']);
        expect(
          receipts.every(
            (item) =>
              item.childCommandDebitedSeconds > 0 &&
              item.finishedMonotonicMicroseconds >= item.startedMonotonicMicroseconds,
          ),
        ).toBe(true);
        const called = vi.spyOn(observation, 'observe');
        const exhausted = new FinalizationNativeGrading({
          maximumSeconds: 0,
          construction,
          observation,
          nowMicroseconds: () => 0,
          record: () => Promise.resolve(true),
        });
        expect(await exhausted.observe(request)).toEqual({
          kind: 'Invalid',
          reason: 'EvidenceUnavailable',
        });
        expect(called).not.toHaveBeenCalled();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 60000);
  },
);
