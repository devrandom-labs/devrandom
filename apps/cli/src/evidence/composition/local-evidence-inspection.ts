import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { BaselineHarnessAdmissionFile } from '../../harness/infrastructure/baseline-harness-admission-file.js';
import { FileSuccessorTreatmentCustody } from '../../evolution/infrastructure/file-successor-treatment-custody.js';
import { PromotionEvidenceFile } from '../../promotion/infrastructure/promotion-evidence-file.js';
import type { HostedWorkAuthorityAcquisition } from '../../task/application/user-tasks.js';

export type LocalEvidenceInspection =
  | { readonly kind: 'Inspected'; readonly document: unknown }
  | { readonly kind: 'NotFound' | 'Unavailable' | 'Rejected' };
const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
async function entries(root: string): Promise<readonly string[]> {
  try {
    const found = await readdir(root, { withFileTypes: true });
    if (found.length > 1024) throw new Error('Inspection limit');
    return found
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && uuid.test(entry.name))
      .map((entry) => entry.name);
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') return [];
    throw cause;
  }
}
/** Composes existing exact custody readers; it creates no alternate evidence index. */
export async function inspectLocalHarness(
  stateRoot: string,
  harnessSaid: string,
): Promise<LocalEvidenceInspection> {
  if (!said.test(harnessSaid)) return { kind: 'Rejected' };
  try {
    const baseline = await new BaselineHarnessAdmissionFile(
      join(stateRoot, 'harness-admissions'),
    ).inspectRevision(harnessSaid);
    if (baseline.kind === 'Read') return { kind: 'Inspected', document: baseline.projection };
    const custody = new FileSuccessorTreatmentCustody(stateRoot);
    for (const evaluationId of await entries(join(stateRoot, 'evaluations'))) {
      const candidate = await custody.read(evaluationId, harnessSaid);
      if (candidate.kind !== 'Read') continue;
      return {
        kind: 'Inspected',
        document: {
          revision: candidate.candidate.revision,
          configuration: JSON.parse(
            Buffer.from(candidate.candidate.configuration.bytes).toString('utf8'),
          ) as unknown,
          ...(candidate.candidate.implementation === undefined
            ? {}
            : {
                implementation: JSON.parse(
                  Buffer.from(candidate.candidate.implementation.bytes).toString('utf8'),
                ) as unknown,
              }),
          branch: candidate.candidate.branch,
        },
      };
    }
    return { kind: 'NotFound' };
  } catch {
    return { kind: 'Unavailable' };
  }
}
export async function inspectLocalEvidence(input: {
  readonly stateRoot: string;
  readonly artifactSaid: string;
  readonly hosted: Extract<HostedWorkAuthorityAcquisition, { kind: 'Authorized' }>;
  readonly signal: AbortSignal;
}): Promise<LocalEvidenceInspection> {
  if (!said.test(input.artifactSaid)) return { kind: 'Rejected' };
  try {
    const closed = await new PromotionEvidenceFile(
      join(input.stateRoot, 'promotion-evidence'),
    ).inspect(input.artifactSaid);
    if (closed.kind === 'Staged') {
      const measurements = await Promise.all(
        closed.index.measurements.map(async (measurement) => {
          const raw = await input.hosted.evaluations.readPublicArtifact({
            evaluationId: closed.closureCommand.closure.evaluationId,
            artifactSaid: measurement.artifactSaid,
          });
          return raw.kind === 'Read'
            ? {
                ...measurement,
                kind: 'Read',
                record: JSON.parse(Buffer.from(raw.bytes).toString('utf8')) as unknown,
              }
            : { ...measurement, kind: raw.kind };
        }),
      );
      return {
        kind: 'Inspected',
        document: {
          custody: 'LocallyStaged',
          closure: closed.closureCommand.closure,
          index: closed.index,
          measurements,
          ...(closed.selectionRecord === undefined ? {} : { selection: closed.selectionRecord }),
        },
      };
    }
    for (const runId of await entries(join(input.stateRoot, 'runs'))) {
      input.signal.throwIfAborted();
      const raw = await input.hosted.evidence.readArtifact(runId, input.artifactSaid, input.signal);
      if (raw.kind === 'Read')
        return {
          kind: 'Inspected',
          document: {
            artifact: raw.artifact,
            bytesBase64Url: Buffer.from(raw.bytes).toString('base64url'),
            text: Buffer.from(raw.bytes).toString('utf8'),
          },
        };
    }
    for (const evaluationId of await entries(join(input.stateRoot, 'evaluations'))) {
      input.signal.throwIfAborted();
      const raw = await input.hosted.evaluations.readPublicArtifact({
        evaluationId,
        artifactSaid: input.artifactSaid,
      });
      if (raw.kind === 'Read')
        return {
          kind: 'Inspected',
          document: {
            artifact: raw.artifact,
            bytesBase64Url: Buffer.from(raw.bytes).toString('base64url'),
            text: Buffer.from(raw.bytes).toString('utf8'),
          },
        };
    }
    return { kind: 'NotFound' };
  } catch {
    return { kind: 'Unavailable' };
  }
}
