import { expect, it, vi } from 'vitest';
import { FinalizationNativeGrading } from './finalization-native-grading.js';
const request = {
  capturedSourceSaid: 'source',
  reviewedRecipeSaid: 'recipe',
  toolchainSaid: 'toolchain',
  containerProfileSaid: 'profile',
  signal: new AbortController().signal,
};
it('prevents native grading before an exhausted F allowance and accounts negative builds before releasing them', async () => {
  const build = vi
    .fn()
    .mockResolvedValue({
      kind: 'BuildFailed',
      buildReceiptSaid: 'raw',
      cleanupReceiptSaid: 'cleanup',
    });
  const record = vi.fn().mockResolvedValue(true);
  let time = 0;
  const grading = new FinalizationNativeGrading({
    maximumSeconds: 1,
    construction: { build },
    observation: { observe: vi.fn() },
    record,
    nowMicroseconds: () => time++ * 1000,
  });
  expect(await grading.build(request)).toMatchObject({ kind: 'BuildFailed' });
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'Build',
      rawReceiptSaid: 'raw',
      cleanupReceiptSaid: 'cleanup',
      elapsedMilliseconds: 1,
      childCommandDebitedSeconds: 1,
    }),
  );
  expect(await grading.build(request)).toEqual({ kind: 'Invalid', reason: 'EvidenceUnavailable' });
  expect(build).toHaveBeenCalledTimes(1);
});
it('does not release a grading result when durable accounting fails', async () => {
  const build = vi
    .fn()
    .mockResolvedValue({
      kind: 'Frozen',
      sourceSaid: 'source',
      executableSaid: 'exe',
      buildReceiptSaid: 'raw',
      cleanupReceiptSaid: 'cleanup',
    });
  const grading = new FinalizationNativeGrading({
    maximumSeconds: 10,
    construction: { build },
    observation: { observe: vi.fn() },
    record: () => Promise.resolve(false),
    nowMicroseconds: () => 1000,
  });
  expect(await grading.build(request)).toEqual({ kind: 'Invalid', reason: 'EvidenceUnavailable' });
  expect(await grading.build(request)).toEqual({ kind: 'Invalid', reason: 'EvidenceUnavailable' });
  expect(build).toHaveBeenCalledTimes(1);
});
