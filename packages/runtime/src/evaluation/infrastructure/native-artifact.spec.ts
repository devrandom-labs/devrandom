import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  prepareEvidenceArtifact,
  prepareProtectedEvaluationArtifact,
  type EvaluationExecutionProfile,
} from '@devrandom/protocol';

import { DockerEvaluationCompartment } from './docker-compartment.js';
import { DockerReceiptObservation, type ExecutableCustody } from './native-artifact.js';

describe('protected CESR observation custody', () => {
  it('rejects a protected case before executable access when no encrypted parent custody is bound', async () => {
    const open = vi.fn(() => Promise.resolve('/tmp/should-not-open'));
    const record = vi.fn(() => Promise.resolve({ kind: 'Unavailable' as const }));
    const observation = new DockerReceiptObservation({
      executables: { open } as unknown as ExecutableCustody,
      profile: {} as EvaluationExecutionProfile,
      image: `sha256:${'a'.repeat(64)}`,
      artifacts: { record },
    });

    await expect(
      observation.observe({
        executableSaid: `E${'e'.repeat(43)}`,
        stimulus: Buffer.from('private case'),
        stimulusSaid: `E${'s'.repeat(43)}`,
        caseScope: 'Protected',
        evaluationId: '11111111-1111-4111-8111-111111111111',
        objectSaid: `E${'o'.repeat(43)}`,
        segment: 0,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'Invalid', reason: 'EvidenceUnavailable' });
    expect(open).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('seals protected output before recording only non-sensitive cleanup metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-protected-observer-'));
    const executable = join(root, 'executable');
    await writeFile(executable, 'frozen executable bytes');
    const evaluationId = '11111111-1111-4111-8111-111111111111';
    const objectSaid = `E${'o'.repeat(43)}`;
    const executableSaid = `E${'e'.repeat(43)}`;
    const payload = `E${'p'.repeat(43)}`;
    const stimulus = Buffer.from('private case bytes');
    const stimulusArtifact = prepareEvidenceArtifact(stimulus, 'text/plain; charset=utf-8');
    const prepared = prepareProtectedEvaluationArtifact({
      evaluationId,
      objectSaid,
      purpose: 'OracleObservation',
      segment: 0,
      nonce: 'AAAAAAAAAAAAAAAA',
      tag: 'AAAAAAAAAAAAAAAAAAAAAA',
      ciphertext: 'AQ',
      plaintextByteCount: 1,
    });
    expect(stimulusArtifact.kind).toBe('Prepared');
    expect(prepared.kind).toBe('Prepared');
    if (stimulusArtifact.kind !== 'Prepared' || prepared.kind !== 'Prepared') return;
    const recorded: string[] = [];
    const seal = vi.fn((input: { readonly plaintext: Uint8Array }) => {
      expect(recorded).toEqual([]);
      expect(Buffer.from(input.plaintext).toString('utf8')).toContain(payload);
      return Promise.resolve({ kind: 'Sealed' as const, artifact: prepared.artifact });
    });
    const record = vi.fn((input: { readonly bytes: Uint8Array }) => {
      const value = Buffer.from(input.bytes).toString('utf8');
      recorded.push(value);
      const artifact = prepareEvidenceArtifact(input.bytes, 'application/json');
      if (artifact.kind !== 'Prepared') throw new Error('Invalid cleanup metadata.');
      return Promise.resolve({ kind: 'Stored' as const, artifact: artifact.artifact });
    });
    const compartment = {
      copyInto: vi.fn(() => Promise.resolve()),
      prepareCopiedSource: vi.fn(() => Promise.resolve()),
      execute: vi.fn(() => {
        const child = new EventEmitter();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const stdin = new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
          final(done) {
            queueMicrotask(() => {
              stdout.end(`DV1|P|Current:${payload}\n`);
              stderr.end();
              child.emit('close', 0);
            });
            done();
          },
        });
        return Object.assign(child, { stdout, stderr, stdin, kill: vi.fn() });
      }),
      close: vi.fn(() => Promise.resolve(true)),
    };
    const opened = vi.spyOn(DockerEvaluationCompartment, 'open').mockResolvedValue({
      kind: 'Opened',
      compartment: compartment as unknown as DockerEvaluationCompartment,
      effectiveLimitsReceipt: '{}',
    });
    try {
      const observation = new DockerReceiptObservation({
        executables: {
          open: vi.fn(() => Promise.resolve(executable)),
        } as unknown as ExecutableCustody,
        profile: { limits: { outputBytes: 4096 } } as EvaluationExecutionProfile,
        image: `sha256:${'a'.repeat(64)}`,
        artifacts: { record },
        protectedCases: { seal } as never,
      });
      await expect(
        observation.observe({
          executableSaid,
          stimulus,
          stimulusSaid: stimulusArtifact.artifact.d,
          caseScope: 'Protected',
          evaluationId,
          objectSaid,
          segment: 0,
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({
        kind: 'Observed',
        observation: { kind: 'Parsed', receipts: [{ version: 'Current', payload }] },
        protectedObservation: prepared.artifact,
      });
      expect(seal).toHaveBeenCalledOnce();
      expect(record).toHaveBeenCalledOnce();
      expect(recorded.join('')).not.toContain(payload);
      expect(recorded.join('')).not.toContain('private case bytes');
    } finally {
      opened.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
