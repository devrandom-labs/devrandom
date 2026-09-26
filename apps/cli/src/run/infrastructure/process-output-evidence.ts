import { readFile, stat } from 'node:fs/promises';

import type { EvidenceRecorder } from '@devrandom/runtime';

import type { CapturedChildOutput } from '../application/exact-child-command.js';
import type {
  ProcessOutputEvidence,
  ProcessOutputEvidenceRecording,
} from '../application/process-output-evidence.js';

const maximumStreamFeedbackBytes = 4 * 1_024;

function streamFeedback(
  stream: 'stdout' | 'stderr',
  artifactSaid: string,
  bytes: Uint8Array,
): string {
  const source = `${stream} [${artifactSaid}]`;
  try {
    const extent = bytes.byteLength > maximumStreamFeedbackBytes ? 'Prefix' : 'Complete';
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(0, maximumStreamFeedbackBytes),
      { stream: extent === 'Prefix' },
    );
    const description =
      extent === 'Prefix'
        ? `truncated UTF-8 prefix; full output ${String(bytes.byteLength)} bytes`
        : `${String(bytes.byteLength)} bytes`;
    return `${source} (${description}):\n${text}`;
  } catch {
    return `${source}: non-UTF-8 output (${String(bytes.byteLength)} bytes); full bytes retained in artifact.`;
  }
}

export class EvidenceRecorderProcessOutput implements ProcessOutputEvidence {
  readonly #evidence: Pick<EvidenceRecorder, 'withhold' | 'storeArtifact'>;
  readonly #now: () => string;

  constructor(evidence: Pick<EvidenceRecorder, 'withhold' | 'storeArtifact'>, now: () => string) {
    this.#evidence = evidence;
    this.#now = now;
  }

  async record(output: CapturedChildOutput): Promise<ProcessOutputEvidenceRecording> {
    try {
      if (output.disclosure.kind === 'WithheldSecret') {
        const recorded = this.#evidence.withhold({
          occurredAt: this.#now(),
          producer: { kind: 'EvidenceRecorder' },
          disclosure: output.disclosure,
        });
        if (recorded.kind !== 'SecretDetected') return { kind: 'EvidenceIntegrityFailure' };
        const acknowledgement = await output.acknowledge();
        return acknowledgement.kind === 'Unavailable'
          ? { kind: 'CleanupUnavailable' }
          : { kind: 'SecretDetected' };
      }
      const [stdoutMetadata, stderrMetadata] = await Promise.all([
        stat(output.stdout.path),
        stat(output.stderr.path),
      ]);
      if (
        !stdoutMetadata.isFile() ||
        !stderrMetadata.isFile() ||
        stdoutMetadata.size !== output.stdout.byteLength ||
        stderrMetadata.size !== output.stderr.byteLength ||
        stdoutMetadata.size + stderrMetadata.size > 512 * 1_024
      ) {
        return { kind: 'EvidenceIntegrityFailure' };
      }
      const [stdout, stderr] = await Promise.all([
        readFile(output.stdout.path),
        readFile(output.stderr.path),
      ]);
      const first = this.#evidence.storeArtifact({
        bytes: stdout,
        mediaType: 'text/plain; charset=utf-8',
      });
      if (first.kind === 'SecretDetected') return first;
      if (first.kind !== 'Stored' && first.kind !== 'AlreadyStored') {
        return { kind: 'EvidenceIntegrityFailure' };
      }
      const second = this.#evidence.storeArtifact({
        bytes: stderr,
        mediaType: 'text/plain; charset=utf-8',
      });
      if (second.kind === 'SecretDetected') return second;
      if (second.kind !== 'Stored' && second.kind !== 'AlreadyStored') {
        return { kind: 'EvidenceIntegrityFailure' };
      }
      const acknowledgement = await output.acknowledge();
      if (acknowledgement.kind === 'Unavailable') {
        return { kind: 'CleanupUnavailable' };
      }
      return {
        kind: 'Recorded',
        stdoutArtifactSaid: first.artifact.d,
        stderrArtifactSaid: second.artifact.d,
        feedback: `${streamFeedback('stdout', first.artifact.d, stdout)}\n\n${streamFeedback('stderr', second.artifact.d, stderr)}`,
      };
    } catch {
      return { kind: 'DependencyUnavailable' };
    }
  }
}
