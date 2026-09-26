import type { CapturedChildOutput } from './exact-child-command.js';

export type ProcessOutputEvidenceRecording =
  | {
      readonly kind: 'Recorded';
      readonly stdoutArtifactSaid: string;
      readonly stderrArtifactSaid: string;
      readonly feedback: string;
    }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'EvidenceIntegrityFailure' }
  | { readonly kind: 'CleanupUnavailable' }
  | { readonly kind: 'DependencyUnavailable' };

export interface ProcessOutputEvidence {
  record(output: CapturedChildOutput): Promise<ProcessOutputEvidenceRecording>;
}
