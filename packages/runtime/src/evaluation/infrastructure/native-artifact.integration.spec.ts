import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareEvidenceArtifact, prepareEvaluationExecutionProfile } from '@devrandom/protocol';
import { describe, expect, it } from 'vitest';

import { assessProtectedCesrCase } from '../application/assess-protected-cesr-case.js';
import { AesGcmProtectedCaseCustody } from './aes-gcm-protected-case-custody.js';
import {
  DockerReceiptObservation,
  DockerTaskArtifactConstruction,
  ExecutableCustody,
} from './native-artifact.js';
import { SourceCustody } from './source-custody.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const payload = 'EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRST';
const correctParser = `pub fn parse_receipt_stream(stream: &str) -> Result<Vec<VerifiedReceipt<'_>>, ReceiptError> {
    let mut rest = stream;
    let mut receipts = Vec::new();
    while !rest.is_empty() {
        let (kind, body, next) = short_frame(rest)?;
        rest = next;
        if kind != b'A' { return Err(ReceiptError::InvalidFrame); }
        let (version, payloads) = if let Some(value) = body.strip_prefix("-_AAABAA") {
            (ReceiptVersion::Legacy, value)
        } else if let Some(value) = body.strip_prefix("-_AAACAA") {
            (ReceiptVersion::Current, value)
        } else if body.starts_with("-_AA") {
            return Err(ReceiptError::UnsupportedVersion);
        } else {
            (ReceiptVersion::Current, body)
        };
        if payloads.is_empty() || payloads.len() % 44 != 0 { return Err(ReceiptError::InvalidPayload); }
        for chunk in payloads.as_bytes().chunks(44) {
            let value = std::str::from_utf8(chunk).map_err(|_| ReceiptError::InvalidPayload)?;
            if !value.starts_with('E') || !value.bytes().all(is_base64url) {
                return Err(ReceiptError::InvalidPayload);
            }
            receipts.push(VerifiedReceipt { version, payload: value });
        }
    }
    Ok(receipts)
}

`;

describe.skipIf(process.env.DEVRANDOM_EVAL_IMAGE === undefined)(
  'real offline CESR API observation',
  () => {
    it('builds stopped source in a separate compartment and observes the actual API', async () => {
      const image = process.env.DEVRANDOM_EVAL_IMAGE ?? '';
      const root = await mkdtemp(join(tmpdir(), 'devrandom-native-'));
      const source = join(root, 'source');
      await cp(resolve('fixtures/cesr-receipt-service'), source, { recursive: true });
      const custody = new SourceCustody(join(root, 'captured'), {
        maximumFiles: 64,
        maximumBytes: 1024 * 1024,
        maximumPathBytes: 256,
      });
      const captured = await custody.capture(source, () => Promise.resolve(false));
      expect(captured.kind).toBe('Captured');
      if (captured.kind !== 'Captured') return;
      const prepared = prepareEvaluationExecutionProfile({
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
      expect(prepared.kind).toBe('Prepared');
      if (prepared.kind !== 'Prepared') return;
      const executables = new ExecutableCustody(join(root, 'executables'));
      const artifacts = {
        async record(input: {
          readonly bytes: Uint8Array;
          readonly mediaType: 'application/json' | 'text/plain; charset=utf-8';
        }) {
          const prepared = prepareEvidenceArtifact(input.bytes, input.mediaType);
          if (prepared.kind !== 'Prepared') return { kind: 'Rejected' as const };
          await writeFile(join(root, prepared.artifact.d), input.bytes);
          return { kind: 'Stored' as const, artifact: prepared.artifact };
        },
      };
      const construction = new DockerTaskArtifactConstruction({
        source: custody,
        executables,
        profile: prepared.profile,
        image,
        recipeSaid: said('r'),
        toolchainSaid: said('t'),
        artifacts,
      });
      const built = await construction.build({
        capturedSourceSaid: captured.sourceSaid,
        reviewedRecipeSaid: said('r'),
        toolchainSaid: said('t'),
        containerProfileSaid: prepared.profile.d,
        signal: new AbortController().signal,
      });
      expect(built).toMatchObject({ kind: 'Frozen' });
      if (built.kind !== 'Frozen') return;
      const observation = new DockerReceiptObservation({
        executables,
        profile: prepared.profile,
        image,
        artifacts,
      });
      const current = Buffer.from(`-AAL${payload}`);
      const legacy = Buffer.from(`-AAN-_AAABAA${payload}`);
      const currentSaid = prepareEvidenceArtifact(current, 'text/plain; charset=utf-8');
      const legacySaid = prepareEvidenceArtifact(legacy, 'text/plain; charset=utf-8');
      expect(currentSaid.kind).toBe('Prepared');
      expect(legacySaid.kind).toBe('Prepared');
      if (currentSaid.kind !== 'Prepared' || legacySaid.kind !== 'Prepared') return;
      const currentResult = await observation.observe({
        executableSaid: built.executableSaid,
        stimulus: current,
        stimulusSaid: currentSaid.artifact.d,
        caseScope: 'Public',
        signal: new AbortController().signal,
      });
      const legacyResult = await observation.observe({
        executableSaid: built.executableSaid,
        stimulus: legacy,
        stimulusSaid: legacySaid.artifact.d,
        caseScope: 'Public',
        signal: new AbortController().signal,
      });
      expect(currentResult).toMatchObject({
        kind: 'Observed',
        observation: { kind: 'Parsed', receipts: [{ version: 'Current', payload }] },
      });
      if (currentResult.kind === 'Observed') {
        expect(await readFile(join(root, currentResult.rawObservationSaid), 'utf8')).toContain(
          `"stimulusSaid":"${currentSaid.artifact.d}"`,
        );
        expect(await readFile(join(root, currentResult.cleanupReceiptSaid), 'utf8')).toContain(
          '"stopped":true',
        );
      }
      expect(legacyResult).toMatchObject({
        kind: 'Observed',
        observation: { kind: 'Rejected', error: 'UnsupportedVersion' },
      });

      const original = await readFile(join(source, 'src/lib.rs'), 'utf8');
      const start = original.indexOf('pub fn parse_receipt_stream');
      const end = original.indexOf('fn short_frame');
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      await writeFile(
        join(source, 'src/lib.rs'),
        `${original.slice(0, start)}${correctParser}${original.slice(end)}`,
      );
      const corrected = await custody.capture(source, () => Promise.resolve(false));
      expect(corrected.kind).toBe('Captured');
      if (corrected.kind !== 'Captured') return;
      const correctedBuild = await construction.build({
        capturedSourceSaid: corrected.sourceSaid,
        reviewedRecipeSaid: said('r'),
        toolchainSaid: said('t'),
        containerProfileSaid: prepared.profile.d,
        signal: new AbortController().signal,
      });
      expect(correctedBuild.kind).toBe('Frozen');
      if (correctedBuild.kind !== 'Frozen') return;
      const evaluationId = '11111111-1111-4111-8111-111111111111';
      const objectSaid = said('h');
      const hiddenPayload = said('q');
      const hiddenStimulus = Buffer.from(`-AAN-_AAABAA${hiddenPayload}`);
      const protectedCases = new AesGcmProtectedCaseCustody(randomBytes(32));
      const sealedStimulus = await protectedCases.seal({
        evaluationId,
        objectSaid,
        purpose: 'TrialHoldout',
        segment: 0,
        plaintext: hiddenStimulus,
      });
      const sealedExpected = await protectedCases.seal({
        evaluationId,
        objectSaid,
        purpose: 'OracleObservation',
        segment: 0,
        plaintext: Buffer.from(
          JSON.stringify({
            kind: 'Parsed',
            receipts: [{ version: 'Legacy', payload: hiddenPayload }],
          }),
        ),
      });
      expect(sealedStimulus.kind).toBe('Sealed');
      expect(sealedExpected.kind).toBe('Sealed');
      if (sealedStimulus.kind !== 'Sealed' || sealedExpected.kind !== 'Sealed') return;
      const publicProtectedRecords: string[] = [];
      const protectedObserver = new DockerReceiptObservation({
        executables,
        profile: prepared.profile,
        image,
        protectedCases,
        artifacts: {
          async record(input) {
            publicProtectedRecords.push(Buffer.from(input.bytes).toString('utf8'));
            const mediaType = input.mediaType;
            if (mediaType !== 'application/json' && mediaType !== 'text/plain; charset=utf-8')
              return { kind: 'Rejected' as const };
            return artifacts.record({ bytes: input.bytes, mediaType });
          },
        },
      });
      const protectedCase = {
        evaluationId,
        objectSaid,
        segment: 0,
        stimulusArtifact: sealedStimulus.artifact,
        expectedArtifact: sealedExpected.artifact,
        signal: new AbortController().signal,
      };
      const correctedAssessment = await assessProtectedCesrCase(
        { ...protectedCase, executableSaid: correctedBuild.executableSaid },
        protectedCases,
        protectedObserver,
      );
      expect(correctedAssessment).toMatchObject({ kind: 'Assessed', verdict: 'Pass' });
      if (correctedAssessment.kind === 'Assessed') {
        const openedObservation = await protectedCases.open({
          artifact: correctedAssessment.observationArtifact,
          evaluationId,
          objectSaid,
          purpose: 'OracleObservation',
          segment: 0,
        });
        expect(openedObservation.kind).toBe('Opened');
        if (openedObservation.kind === 'Opened')
          expect(Buffer.from(openedObservation.plaintext).toString('utf8')).toContain(
            hiddenPayload,
          );
      }
      const originalAssessment = await assessProtectedCesrCase(
        { ...protectedCase, executableSaid: built.executableSaid },
        protectedCases,
        protectedObserver,
      );
      expect(originalAssessment).toMatchObject({ kind: 'Assessed', verdict: 'Fail' });
      expect(publicProtectedRecords).toHaveLength(2);
      for (const recorded of publicProtectedRecords) {
        expect(recorded).not.toContain(hiddenPayload);
        expect(recorded).not.toContain(hiddenStimulus.toString('utf8'));
        expect(recorded).toContain('"stopped":true');
      }
      const correctedLegacy = await observation.observe({
        executableSaid: correctedBuild.executableSaid,
        stimulus: legacy,
        stimulusSaid: legacySaid.artifact.d,
        caseScope: 'Public',
        signal: new AbortController().signal,
      });
      expect(correctedLegacy).toMatchObject({
        kind: 'Observed',
        observation: { kind: 'Parsed', receipts: [{ version: 'Legacy', payload }] },
      });
      const tamper = Buffer.from(`-AAM-_AAACAA${payload}`);
      const tamperSaid = prepareEvidenceArtifact(tamper, 'text/plain; charset=utf-8');
      expect(tamperSaid.kind).toBe('Prepared');
      if (tamperSaid.kind !== 'Prepared') return;
      const correctedTamper = await observation.observe({
        executableSaid: correctedBuild.executableSaid,
        stimulus: tamper,
        stimulusSaid: tamperSaid.artifact.d,
        caseScope: 'Public',
        signal: new AbortController().signal,
      });
      expect(correctedTamper).toMatchObject({
        kind: 'Observed',
        observation: { kind: 'Rejected' },
      });

      const forgedParser = `pub fn parse_receipt_stream(_stream: &str) -> Result<Vec<VerifiedReceipt<'_>>, ReceiptError> {
    println!("DV1|P|Current:${payload}");
    Err(ReceiptError::InvalidFrame)
}

`;
      await writeFile(
        join(source, 'src/lib.rs'),
        `${original.slice(0, start)}${forgedParser}${original.slice(end)}`,
      );
      const forged = await custody.capture(source, () => Promise.resolve(false));
      expect(forged.kind).toBe('Captured');
      if (forged.kind !== 'Captured') return;
      const forgedBuild = await construction.build({
        capturedSourceSaid: forged.sourceSaid,
        reviewedRecipeSaid: said('r'),
        toolchainSaid: said('t'),
        containerProfileSaid: prepared.profile.d,
        signal: new AbortController().signal,
      });
      expect(forgedBuild.kind).toBe('Frozen');
      if (forgedBuild.kind !== 'Frozen') return;
      const forgedObservation = await observation.observe({
        executableSaid: forgedBuild.executableSaid,
        stimulus: current,
        stimulusSaid: currentSaid.artifact.d,
        caseScope: 'Public',
        signal: new AbortController().signal,
      });
      expect(forgedObservation).toMatchObject({ kind: 'Invalid' });

      const parentCanary = join(root, 'parent-canary');
      const holdoutCanary = join(root, 'holdout-canary');
      await writeFile(parentCanary, 'parent-private');
      await writeFile(holdoutCanary, 'holdout-private');
      await writeFile(
        join(source, 'src/lib.rs'),
        `${original.slice(0, start)}${correctParser}${original.slice(end)}`,
      );
      await writeFile(
        join(source, 'build.rs'),
        `fn main() {
        for path in [${JSON.stringify(parentCanary)}, ${JSON.stringify(holdoutCanary)}] {
            if std::fs::read_to_string(path).is_ok() || std::fs::write(path, b"attacker").is_ok() {
                panic!("canary escaped containment");
            }
        }
    }
    `,
      );
      const malicious = await custody.capture(source, () => Promise.resolve(false));
      expect(malicious.kind).toBe('Captured');
      if (malicious.kind !== 'Captured') return;
      const maliciousBuild = await construction.build({
        capturedSourceSaid: malicious.sourceSaid,
        reviewedRecipeSaid: said('r'),
        toolchainSaid: said('t'),
        containerProfileSaid: prepared.profile.d,
        signal: new AbortController().signal,
      });
      expect(maliciousBuild.kind).toBe('Frozen');
      expect(await readFile(parentCanary, 'utf8')).toBe('parent-private');
      expect(await readFile(holdoutCanary, 'utf8')).toBe('holdout-private');
    }, 180_000);
  },
);
