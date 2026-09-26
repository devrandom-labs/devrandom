import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  encodeEvaluationVerifierBundle,
  prepareEvidenceArtifact,
  prepareEvaluationExecutionProfile,
  prepareEvaluationManifest,
  prepareEvaluationVerifierBundle,
} from '@devrandom/protocol';
import { describe, expect, it, vi } from 'vitest';

import { assessProtectedCesrCase } from '../application/assess-protected-cesr-case.js';
import { observeProtectedTrialArtifact } from '../application/observe-protected-trial-artifact.js';
import { AesGcmProtectedCaseCustody } from './aes-gcm-protected-case-custody.js';
import { FileEvaluationCaseInventory } from './file-evaluation-case-inventory.js';
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

      // Fixture-only lock, trial stop and oracle identity; the build and all four
      // observations below cross real pinned OCI/Cargo/native boundaries.
      const terminalObjectSaid = said('f');
      const terminalStimulus = await protectedCases.seal({
        evaluationId,
        objectSaid: terminalObjectSaid,
        purpose: 'TerminalCase',
        segment: 1,
        plaintext: Buffer.from(`-AAL${said('z')}`),
      });
      const terminalExpected = await protectedCases.seal({
        evaluationId,
        objectSaid: terminalObjectSaid,
        purpose: 'OracleObservation',
        segment: 1,
        plaintext: Buffer.from(
          JSON.stringify({
            kind: 'Parsed',
            receipts: [
              {
                version: 'Current',
                payload: said('z'),
              },
            ],
          }),
        ),
      });
      expect(terminalStimulus.kind).toBe('Sealed');
      expect(terminalExpected.kind).toBe('Sealed');
      if (terminalStimulus.kind !== 'Sealed' || terminalExpected.kind !== 'Sealed') return;
      const oracleAdapterDigest = `sha256:${'a'.repeat(64)}`;
      const bundlePreparation = prepareEvaluationVerifierBundle({
        evaluationId,
        taskId: '22222222-2222-4222-8222-222222222222',
        taskRevisionSaid: said('t'),
        ownerAid: said('o'),
        personalAgentAid: said('a'),
        policySaid: said('p'),
        executionProfileSaid: prepared.profile.d,
        oracleAdapterDigest,
        reviewedRecipeSaid: said('r'),
        toolchainSaid: said('t'),
        publicConditions: [
          {
            id: 'cesr-current',
            stimulusBase64Url: current.toString('base64url'),
            expected: { kind: 'Parsed', receipts: [{ version: 'Current', payload }] },
          },
          {
            id: 'cesr-legacy',
            stimulusBase64Url: legacy.toString('base64url'),
            expected: { kind: 'Parsed', receipts: [{ version: 'Legacy', payload }] },
          },
          {
            id: 'cesr-tamper',
            stimulusBase64Url: tamper.toString('base64url'),
            expected: { kind: 'Rejected', error: 'AnyRejection' },
          },
        ],
        protectedCase: {
          objectSaid,
          stimulus: sealedStimulus.artifact,
          expected: sealedExpected.artifact,
        },
        terminalCase: {
          objectSaid: terminalObjectSaid,
          stimulus: terminalStimulus.artifact,
          expected: terminalExpected.artifact,
        },
      });
      expect(bundlePreparation.kind).toBe('Prepared');
      if (bundlePreparation.kind !== 'Prepared') return;
      const bundleEncoding = encodeEvaluationVerifierBundle(bundlePreparation.bundle);
      expect(bundleEncoding.kind).toBe('Encoded');
      if (bundleEncoding.kind !== 'Encoded') return;
      const manifestPreparation = prepareEvaluationManifest({
        evaluationId,
        taskId: '22222222-2222-4222-8222-222222222222',
        taskRevisionSaid: said('t'),
        originRunId: '33333333-3333-4333-8333-333333333333',
        ownerAid: said('o'),
        personalAgentAid: said('a'),
        taskMandateSaid: said('m'),
        retainedCheckpointSaid: said('c'),
        retainedSealSaid: said('s'),
        policySaid: said('p'),
        revisions: { H1: said('h'), C1: said('j'), C2: said('k'), C3: said('l') },
        executionProfileSaid: prepared.profile.d,
        sourceInventorySaid: said('i'),
        hypothesisSaid: said('H'),
        verifierSaid: bundlePreparation.bundle.d,
        protectedCaseArtifactSaid: sealedStimulus.artifact.d,
        finalCaseArtifactSaid: terminalStimulus.artifact.d,
        publicConditionIds: ['cesr-current', 'cesr-legacy', 'cesr-tamper'],
        heldOutCaseCount: 1,
        allocation: {
          diagnosis: {
            providerRequests: 0,
            providerInputTokens: 0,
            providerOutputTokens: 0,
            providerSpendMicroUsd: 0,
            runWallTimeSeconds: 120,
            toolProposals: 0,
            aggregateChildCommandTimeSeconds: 0,
            changedFiles: 0,
            changedWorktreeBytes: 0,
            evidencePlusArtifactsPerRunBytes: 65536,
          },
          perEntry: {
            providerRequests: 0,
            providerInputTokens: 0,
            providerOutputTokens: 0,
            providerSpendMicroUsd: 0,
            runWallTimeSeconds: 120,
            toolProposals: 0,
            aggregateChildCommandTimeSeconds: 0,
            changedFiles: 0,
            changedWorktreeBytes: 0,
            evidencePlusArtifactsPerRunBytes: 65536,
          },
          finalization: {
            providerRequests: 0,
            providerInputTokens: 0,
            providerOutputTokens: 0,
            providerSpendMicroUsd: 0,
            runWallTimeSeconds: 120,
            toolProposals: 0,
            aggregateChildCommandTimeSeconds: 0,
            changedFiles: 0,
            changedWorktreeBytes: 0,
            evidencePlusArtifactsPerRunBytes: 65536,
          },
        },
      });
      expect(manifestPreparation.kind).toBe('Prepared');
      if (manifestPreparation.kind !== 'Prepared') return;
      const manifest = manifestPreparation.manifest;
      const caseDirectory = join(root, 'private-case-inventory');
      await mkdir(caseDirectory, { mode: 0o700 });
      await writeFile(join(caseDirectory, manifest.verifierSaid), bundleEncoding.bytes, {
        mode: 0o600,
      });
      const retained = vi.fn().mockResolvedValue({ kind: 'Unavailable' as const });
      const realObserve = vi.spyOn(protectedObserver, 'observe');
      const trialBinding = {
        kind: 'Evaluation' as const,
        evaluationId,
        taskId: manifest.taskId,
        taskRevisionSaid: manifest.taskRevisionSaid,
        originRunId: manifest.originRunId,
        personalAgentAid: manifest.personalAgentAid,
        taskMandateSaid: manifest.taskMandateSaid,
        harnessRevisionSaid: manifest.revisions.C2,
        evaluationLeaseId: '44444444-4444-4444-8444-444444444444',
        evidenceStreamId: '55555555-5555-4555-8555-555555555555',
        phase: {
          kind: 'Trial' as const,
          manifestSaid: manifest.d,
          arm: 'C2' as const,
          repetition: 1 as const,
          attempt: 1 as const,
        },
      };
      const trialLease = {
        evaluationId,
        leaseId: '44444444-4444-4444-8444-444444444444',
        version: 1,
        serverTime: '2026-09-26T03:00:00.000Z',
        expiresAt: '2026-09-26T03:00:45.000Z',
      };
      const composed = await observeProtectedTrialArtifact(
        {
          manifest,
          binding: trialBinding,
          lease: trialLease,
          leaseRequestStartedAt: 1000,
          now: 2000,
          cleanSourceSaid: said('n'),
          reviewedBehaviorSaid: said('b'),
          modelProfileSaid: said('d'),
          containerProfileSaid: prepared.profile.d,
          signal: new AbortController().signal,
        },
        {
          lock: {
            inspect: () =>
              Promise.resolve({
                kind: 'Acknowledged',
                evaluationId,
                manifestSaid: manifest.d,
                ownerAid: manifest.ownerAid,
                policySaid: manifest.policySaid,
                leaseId: '44444444-4444-4444-8444-444444444444',
                leaseVersion: 1,
                acknowledgementSaid: said('a'),
              }),
          },
          cases: new FileEvaluationCaseInventory(caseDirectory),
          oracle: {
            inspect: () => Promise.resolve({ kind: 'Reviewed', digest: oracleAdapterDigest }),
          },
          execution: {
            run: () =>
              Promise.resolve({
                kind: 'Stopped',
                capturedSourceSaid: corrected.sourceSaid,
                evidenceHeadSaid: said('e'),
                providerUsageEventSaids: [],
                cleanupReceiptSaid: said('u'),
              }),
          },
          construction,
          observation: protectedObserver,
          custody: protectedCases,
          protectedArtifacts: { retain: retained },
        },
      );
      expect(composed).toMatchObject({
        kind: 'Incomplete',
        frontier: 'ProtectedCustody',
        frozenArtifact: { sourceSaid: corrected.sourceSaid },
      });
      expect(realObserve).toHaveBeenCalledTimes(4);
      expect(retained).toHaveBeenCalledWith({
        binding: trialBinding,
        manifest,
        lease: trialLease,
        expectedHeadSaid: said('e'),
        artifacts: [
          sealedStimulus.artifact,
          sealedExpected.artifact,
          expect.objectContaining({ purpose: 'OracleObservation', segment: 0 }),
        ],
      });
      expect(realObserve).not.toHaveBeenCalledWith(expect.objectContaining({ segment: 1 }));

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
    }, 240_000);
  },
);
