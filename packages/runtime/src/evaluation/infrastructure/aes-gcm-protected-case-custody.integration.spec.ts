import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareEvidenceArtifact, prepareEvaluationExecutionProfile } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { AesGcmProtectedCaseCustody } from './aes-gcm-protected-case-custody.js';
import {
  DockerReceiptObservation,
  DockerTaskArtifactConstruction,
  ExecutableCustody,
} from './native-artifact.js';
import { SourceCustody } from './source-custody.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const payload = 'EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRST';

describe.skipIf(process.env.DEVRANDOM_EVAL_IMAGE === undefined)(
  'protected parent custody across the real native build boundary',
  () => {
    it('keeps protected cases outside a malicious build and observes only public CESR stimuli', async () => {
      const image = process.env.DEVRANDOM_EVAL_IMAGE ?? '';
      const root = await mkdtemp(join(tmpdir(), 'devrandom-protected-case-'));
      const source = join(root, 'source');
      await cp(resolve('fixtures/cesr-receipt-service'), source, { recursive: true });
      const secret = 'parent-private-legacy-and-tamper-oracle';
      const terminalSecret = 'locked-terminal-case-never-feedback';
      const parentCanary = join(root, 'parent-canary');
      const terminalCanary = join(root, 'terminal-canary');
      await writeFile(parentCanary, secret);
      await writeFile(terminalCanary, terminalSecret);
      await writeFile(
        join(source, 'build.rs'),
        `fn main() {
          for path in [${JSON.stringify(parentCanary)}, ${JSON.stringify(terminalCanary)}] {
            if std::fs::read_to_string(path).is_ok() || std::fs::write(path, b"attacker").is_ok() {
              panic!("protected parent case escaped containment");
            }
          }
        }`,
      );

      const caseCustody = new AesGcmProtectedCaseCustody(randomBytes(32));
      const evaluationId = '11111111-1111-4111-8111-111111111111';
      const protectedScope = {
        evaluationId,
        objectSaid: said('h'),
        purpose: 'TrialHoldout' as const,
        segment: 0,
      };
      const terminalScope = {
        evaluationId,
        objectSaid: said('f'),
        purpose: 'TerminalCase' as const,
        segment: 1,
      };
      const holdout = await caseCustody.seal({
        ...protectedScope,
        plaintext: Buffer.from(secret),
      });
      const terminal = await caseCustody.seal({
        ...terminalScope,
        plaintext: Buffer.from(terminalSecret),
      });
      expect(holdout.kind).toBe('Sealed');
      expect(terminal.kind).toBe('Sealed');
      if (holdout.kind !== 'Sealed' || terminal.kind !== 'Sealed') return;
      expect(JSON.stringify([holdout.artifact, terminal.artifact])).not.toContain(secret);
      expect(JSON.stringify([holdout.artifact, terminal.artifact])).not.toContain(terminalSecret);

      const sourceCustody = new SourceCustody(join(root, 'captured'), {
        maximumFiles: 64,
        maximumBytes: 1024 * 1024,
        maximumPathBytes: 256,
      });
      const captured = await sourceCustody.capture(source, () => Promise.resolve(false));
      expect(captured.kind).toBe('Captured');
      if (captured.kind !== 'Captured') return;
      const profile = prepareEvaluationExecutionProfile({
        os: 'linux',
        architecture: 'aarch64',
        imageDigest: image,
        runtimeDigest: `sha256:${'1'.repeat(64)}`,
        toolchainDigest: `sha256:${'2'.repeat(64)}`,
        sourceGitCommit: '3'.repeat(40),
        sourceGitTree: '4'.repeat(40),
        h1InstructionSaid: said('i'),
        h1RuntimePromptDigest: `sha256:${'5'.repeat(64)}`,
        effectiveLimitsReceiptSaid: said('l'),
        parentDeathCleanupReceiptSaid: said('p'),
        modelProvider: 'fixture',
        modelId: 'fixture',
        thinkingLevel: 'low',
        maximumOutputTokens: 64,
        limits: {
          cpuCount: 1,
          memoryBytes: 512 * 1024 * 1024,
          processCount: 32,
          scratchBytes: 128 * 1024 * 1024,
          outputBytes: 128 * 1024,
          wallTimeSeconds: 120,
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
      expect(profile.kind).toBe('Prepared');
      if (profile.kind !== 'Prepared') return;
      const recordedArtifactSaids: string[] = [];
      const artifacts = {
        async record(input: {
          readonly bytes: Uint8Array;
          readonly mediaType: 'application/json' | 'text/plain; charset=utf-8';
        }) {
          const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
          if (prepared.kind !== 'Prepared') return { kind: 'Rejected' as const };
          await writeFile(join(root, prepared.artifact.d), input.bytes);
          recordedArtifactSaids.push(prepared.artifact.d);
          return { kind: 'Stored' as const, artifact: prepared.artifact };
        },
      };
      const executables = new ExecutableCustody(join(root, 'executables'));
      const construction = new DockerTaskArtifactConstruction({
        source: sourceCustody,
        executables,
        profile: profile.profile,
        image,
        recipeSaid: said('r'),
        toolchainSaid: said('t'),
        artifacts,
      });
      const built = await construction.build({
        capturedSourceSaid: captured.sourceSaid,
        reviewedRecipeSaid: said('r'),
        toolchainSaid: said('t'),
        containerProfileSaid: profile.profile.d,
        signal: new AbortController().signal,
      });
      expect(built).toMatchObject({ kind: 'Frozen' });
      if (built.kind !== 'Frozen') return;
      expect(await readFile(parentCanary, 'utf8')).toBe(secret);
      expect(await readFile(terminalCanary, 'utf8')).toBe(terminalSecret);
      const observation = new DockerReceiptObservation({
        executables,
        profile: profile.profile,
        image,
        artifacts,
      });
      for (const [stimulus, expected] of [
        [`-AAL${payload}`, { kind: 'Parsed', receipts: [{ version: 'Current', payload }] }],
        [`-AAN-_AAABAA${payload}`, { kind: 'Rejected', error: 'UnsupportedVersion' }],
        [`-AAM-_AAACAA${payload}`, { kind: 'Rejected' }],
      ] as const) {
        const bytes = Buffer.from(stimulus);
        const identified = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
        expect(identified.kind).toBe('Prepared');
        if (identified.kind !== 'Prepared') return;
        const observed = await observation.observe({
          executableSaid: built.executableSaid,
          stimulus: bytes,
          stimulusSaid: identified.artifact.d,
          caseScope: 'Public',
          signal: new AbortController().signal,
        });
        expect(observed).toMatchObject({ kind: 'Observed', observation: expected });
      }
      await expect(
        caseCustody.open({ artifact: holdout.artifact, ...protectedScope }),
      ).resolves.toMatchObject({ kind: 'Opened', plaintext: new Uint8Array(Buffer.from(secret)) });
      await expect(
        caseCustody.open({ artifact: terminal.artifact, ...terminalScope }),
      ).resolves.toMatchObject({
        kind: 'Opened',
        plaintext: new Uint8Array(Buffer.from(terminalSecret)),
      });
      for (const artifactSaid of recordedArtifactSaids) {
        const rawArtifact = await readFile(join(root, artifactSaid), 'utf8');
        expect(rawArtifact).not.toContain(secret);
        expect(rawArtifact).not.toContain(terminalSecret);
      }
    }, 180_000);
  },
);
