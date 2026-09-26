import {
  decodeEvidenceArtifact,
  decodeEvaluationManifest,
  prepareEvidenceArtifact,
} from '@devrandom/protocol';
import type { EvaluationManifestLock, EvaluationRawArtifacts } from '@devrandom/runtime';

import type { ServerEvaluationHttp } from './server-evaluation-http.js';

/** Translates a fresh authenticated hosted lock read into parent-owned evidence custody. */
export class HostedEvaluationManifestLock implements EvaluationManifestLock {
  readonly #hosted: Pick<ServerEvaluationHttp, 'inspectManifestLock'>;
  readonly #artifacts: EvaluationRawArtifacts;

  constructor(
    hosted: Pick<ServerEvaluationHttp, 'inspectManifestLock'>,
    artifacts: EvaluationRawArtifacts,
  ) {
    this.#hosted = hosted;
    this.#artifacts = artifacts;
  }

  async inspect(
    input: Parameters<EvaluationManifestLock['inspect']>[0],
  ): ReturnType<EvaluationManifestLock['inspect']> {
    const { manifest, lease } = input;
    if (
      decodeEvaluationManifest(manifest).kind !== 'Accepted' ||
      lease.evaluationId !== manifest.evaluationId
    )
      return { kind: 'Unlocked' };
    let reading: Awaited<ReturnType<ServerEvaluationHttp['inspectManifestLock']>>;
    try {
      reading = await this.#hosted.inspectManifestLock(
        manifest.evaluationId,
        manifest.d,
        lease.leaseId,
      );
    } catch {
      return { kind: 'Unavailable' };
    }
    if (reading.kind === 'Unavailable' || reading.kind === 'ResponseInvalid')
      return { kind: 'Unavailable' };
    if (reading.kind !== 'Locked') return { kind: 'Unlocked' };
    const receipt = reading.receipt;
    if (
      receipt.evaluationId !== manifest.evaluationId ||
      receipt.manifestSaid !== manifest.d ||
      receipt.ownerAid !== manifest.ownerAid ||
      receipt.policySaid !== manifest.policySaid ||
      receipt.leaseId !== lease.leaseId ||
      receipt.currentLeaseVersion !== lease.version ||
      receipt.currentEvaluationVersion < receipt.lockedAtEvaluationVersion ||
      receipt.currentLeaseVersion < receipt.lockedAtLeaseVersion
    )
      return { kind: 'Unlocked' };
    const bytes = new TextEncoder().encode(JSON.stringify(receipt));
    const prepared = prepareEvidenceArtifact(bytes, 'application/json');
    if (prepared.kind !== 'Prepared') return { kind: 'Unavailable' };
    try {
      const stored = await this.#artifacts.record({ bytes, mediaType: 'application/json' });
      if (
        stored.kind !== 'Stored' ||
        stored.artifact.d !== prepared.artifact.d ||
        decodeEvidenceArtifact(stored.artifact, bytes).kind !== 'Accepted'
      )
        return { kind: 'Unavailable' };
    } catch {
      return { kind: 'Unavailable' };
    }
    return {
      kind: 'Acknowledged',
      evaluationId: receipt.evaluationId,
      manifestSaid: receipt.manifestSaid,
      ownerAid: receipt.ownerAid,
      policySaid: receipt.policySaid,
      leaseId: receipt.leaseId,
      leaseVersion: receipt.currentLeaseVersion,
      acknowledgementSaid: prepared.artifact.d,
    };
  }
}
