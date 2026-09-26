/** Exports only accepted PUBLIC fixture evidence. Protected ciphertext, keys and verifier inputs stay private. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { selectPromotion, type CandidatePromotionAssessment } from '@devrandom/domain';
import {
  decodeTrialObservationEvidence,
  decodeComparisonMeasurementEvidence,
  decodeEvaluationAuditAssessmentArtifact,
  type EvidenceArtifact,
  type EvaluationManifest,
  type EvaluationEvidenceEvent,
} from '@devrandom/protocol';
import type { LockedComparisonOutcome } from '../src/harness/composition/locked-comparison-execution.js';

export async function writeComparisonSimulationReport(input: {
  directory: string;
  manifest: EvaluationManifest;
  outcome: LockedComparisonOutcome;
  events: readonly EvaluationEvidenceEvent[];
  artifacts: ReadonlyMap<string, { artifact: EvidenceArtifact; bytesBase64Url: string }>;
  httpRequests: number;
  httpOutcomes: Readonly<Record<string, number>>;
  executionMilliseconds: number;
  renewals: readonly {
    expectedVersion: number;
    currentVersion: number;
    accepted: boolean;
    leaseRemainingMilliseconds: number;
  }[];
  slotExecutions: readonly {
    slot: EvaluationEvidenceEvent['phase'];
    httpRequests: number;
    wallMilliseconds: number;
  }[];
}) {
  const raws = [...input.artifacts.values()].map((item) => ({
    ...item,
    bytes: Buffer.from(item.bytesBase64Url, 'base64url'),
  }));
  const observations = raws.flatMap((raw) => {
    const decoded = decodeTrialObservationEvidence(raw.artifact, raw.bytes);
    return decoded.kind === 'Accepted' ? [decoded] : [];
  });
  const measurements = raws.flatMap((raw) => {
    const decoded = decodeComparisonMeasurementEvidence(raw.artifact, raw.bytes);
    return decoded.kind === 'Accepted' ? [decoded] : [];
  });
  const audits = raws.flatMap((raw) => {
    const decoded = decodeEvaluationAuditAssessmentArtifact(raw.artifact, raw.bytes);
    return decoded.kind === 'Accepted' ? [decoded] : [];
  });
  const shared = audits.find((item) => item.assessment.scope === 'Shared');
  const candidates: CandidatePromotionAssessment[] = [];
  for (const arm of ['C1', 'C2', 'C3'] as const) {
    const audit = audits.find((item) => item.assessment.scope === arm);
    if (audit === undefined) continue;
    const records = observations.filter((item) => item.evidence.observation.slot.arm === arm);
    candidates.push({
      arm,
      revisionSaid: input.manifest.revisions[arm],
      audit: audit.assessment.obligations,
      budget: input.outcome.kind === 'Closed' ? 'WithinCeiling' : 'Unknown',
      prohibitedAttempts: [],
      repetitions: records.map((item) => ({
        repetition: item.evidence.observation.slot.repetition,
        artifactSaid: item.evidence.observation.disposition.artifactSaid,
        artifactBinding: 'Matched' as const,
        tamper:
          item.evidence.publicObservations.find(
            (condition) => condition.conditionId === 'cesr-tamper',
          )?.verdict === 'Pass'
            ? ('Rejected' as const)
            : ('Unverified' as const),
      })),
    });
  }
  const selection =
    shared === undefined || input.outcome.kind !== 'Closed'
      ? { kind: 'NotEvaluated' as const }
      : selectPromotion({
          conditions: {
            public: input.manifest.publicConditionIds,
            heldOut: [
              ...new Set(
                observations.flatMap(
                  (item) => item.evidence.observation.disposition.heldOutConditionIds,
                ),
              ),
            ],
          },
          observations: observations.map((item) => item.evidence.observation),
          sharedAudit: shared.assessment.obligations,
          evaluationAuthority: 'Current',
          allocation: 'WithinCeiling',
          evidence: 'Acknowledged',
          candidates,
        });
  const directory = resolve(input.directory);
  await mkdir(join(directory, 'proofs', 'public'), { recursive: true });
  const publicProofs = [];
  for (const raw of raws) {
    const path = `proofs/public/${raw.artifact.d}.bin`;
    await writeFile(join(directory, path), raw.bytes);
    publicProofs.push({ artifact: raw.artifact, path });
  }
  await writeFile(
    join(directory, 'proofs', 'evaluation-events.json'),
    JSON.stringify(input.events, null, 2) + '\n',
  );
  await writeFile(
    join(directory, 'proofs', 'manifest.json'),
    JSON.stringify(input.manifest, null, 2) + '\n',
  );
  const report = {
    version: 1,
    mode: 'Simulation',
    generatedAt: new Date().toISOString(),
    status: input.outcome.kind === 'Closed' ? 'Closed' : 'Incomplete',
    evaluationId: input.manifest.evaluationId,
    manifestSaid: input.manifest.d,
    ...(input.outcome.kind === 'Closed' ? { closureSaid: input.outcome.closureSaid } : {}),
    rolloutCount: input.events.filter(
      (event) => event.detail.kind === 'TrialStopped' && event.detail.reason === 'Completed',
    ).length,
    observationCount: observations.length,
    measurementCount: measurements.length,
    httpRequests: input.httpRequests,
    httpOutcomes: input.httpOutcomes,
    renewals: input.renewals,
    slotExecutionWindow:
      'FirstAcceptedTrialEventThroughTrialStopped; excludes subsequent native grading and shared accounting',
    slotExecutions: input.slotExecutions,
    executionMilliseconds: input.executionMilliseconds,
    outcome: input.outcome,
    selection,
    provenance: {
      qualification: 'Synthetic fixture inputs; no live Q',
      provider: 'Deterministic fixture responses; no paid model',
      providerUsage: 'Synthetic provider reports, explicitly not billed cost',
      authority: 'Fixture mandate, HTTP admission and closure seal; not live KERI authority',
      nativeExecution: 'Actual network-isolated Docker/Pi/native repository effects',
      protectedEvaluation: 'Actual parent-only ciphertext custody and native protected grading',
      candidateCustody: 'Actual separate immutable Git branches',
      audit: audits.length > 0 ? 'Actual seven-obligation source replay' : 'Not reached',
      persistence: 'Actual local SQLite outbox and localhost HTTP fixture acknowledgement',
    },
    head: {
      acceptedEventCount: input.events.length,
      acceptedHeadSaid: input.events.at(-1)?.d ?? null,
    },
    observations: observations.map((item) => ({ artifactSaid: item.artifact.d, ...item.evidence })),
    measurements: measurements.map((item) => ({ artifactSaid: item.artifact.d, ...item.evidence })),
    audits: audits.map((item) => ({ artifactSaid: item.artifact.d, ...item.assessment })),
    proofs: {
      manifest: 'proofs/manifest.json',
      acceptedEvents: 'proofs/evaluation-events.json',
      publicArtifacts: publicProofs,
    },
    notEstablished: [
      'Live campaign qualification',
      'Paid-provider effectiveness',
      'Governed activation',
      'Same-Run recovery',
      'Harness publication',
    ],
  };
  await writeFile(
    join(directory, 'comparison-simulation-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  return report;
}
