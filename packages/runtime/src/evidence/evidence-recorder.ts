import type { CredentialDisclosure, Run } from '@devrandom/domain';
import type {
  EvidenceArtifact,
  EvidenceArtifactMediaType,
  EvidenceBatch,
  EvidenceBatchAcknowledgement,
  EvidenceEvent,
  EvidenceEventDetail,
  EvidenceStreamProjection,
  VerifiedCheckpoint,
} from '@devrandom/protocol';

export type EvidenceProducer =
  | { readonly kind: 'RunSupervisor' }
  | { readonly kind: 'PiExecutor' }
  | { readonly kind: 'ToolGateway' }
  | { readonly kind: 'PublicTaskVerifier' }
  | { readonly kind: 'EvidenceRecorder' };

export interface EvidenceObservation {
  readonly occurredAt: string;
  readonly producer: EvidenceProducer;
  readonly event: EvidenceEventDetail;
}

export interface EvidenceBudgetDebit {
  readonly occurredAt: string;
  readonly producer: EvidenceProducer;
  readonly debits: readonly Extract<EvidenceEventDetail, { readonly kind: 'BudgetDebited' }>[];
}

export type EvidenceReadiness =
  | { readonly kind: 'Genesis'; readonly streamId: string }
  | {
      readonly kind: 'Continued';
      readonly streamId: string;
      readonly nextSequence: number;
      readonly previousEventSaid: string;
    };

export type EvidenceReadinessInspection =
  | { readonly kind: 'Ready'; readonly readiness: EvidenceReadiness }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'Unavailable' };

export type EvidenceRecording =
  | { readonly kind: 'Recorded'; readonly event: EvidenceEvent }
  | { readonly kind: 'ObservationRejected' }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'OutboxBackpressure' }
  | { readonly kind: 'OutboxBoundReached' }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'Unavailable' };

export type EvidenceWithholding =
  | {
      readonly kind: 'SecretDetected';
      readonly dataWithheldEventSaid: string;
      readonly securityViolationEventSaid: string;
    }
  | Exclude<EvidenceRecording, { readonly kind: 'Recorded' | 'SecretDetected' }>;

export interface EvidencePage {
  readonly batch: EvidenceBatch;
  readonly events: readonly EvidenceEvent[];
  readonly encodedBytes: number;
}

export type EvidencePaging =
  | { readonly kind: 'Page'; readonly page: EvidencePage }
  | { readonly kind: 'Empty' }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'Unavailable' };

export type EvidenceAcknowledgementRecording =
  | {
      readonly kind: 'Acknowledged';
      readonly acknowledgement: EvidenceBatchAcknowledgement;
    }
  | {
      readonly kind: 'AlreadyAcknowledged';
      readonly acknowledgement: EvidenceBatchAcknowledgement;
    }
  | { readonly kind: 'AcknowledgementRejected' }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'Unavailable' };

export interface EvidenceArtifactInput {
  readonly bytes: Uint8Array;
  readonly mediaType: EvidenceArtifactMediaType;
}

export type EvidenceArtifactRecording =
  | { readonly kind: 'Stored'; readonly artifact: EvidenceArtifact }
  | { readonly kind: 'AlreadyStored'; readonly artifact: EvidenceArtifact }
  | { readonly kind: 'ArtifactRejected' }
  | { readonly kind: 'SecretDetected' }
  | { readonly kind: 'OutboxBackpressure' }
  | { readonly kind: 'OutboxBoundReached' }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'Unavailable' };

export type EvidenceArtifactReading =
  | {
      readonly kind: 'Read';
      readonly artifact: EvidenceArtifact;
      readonly bytes: Uint8Array;
    }
  | { readonly kind: 'ArtifactNotFound' }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'Unavailable' };

export interface EvidenceCheckpointInput {
  readonly checkpoint: VerifiedCheckpoint;
  readonly completionConditionIds: readonly string[];
}

export type EvidenceCheckpointRecording =
  | { readonly kind: 'Stored'; readonly checkpoint: VerifiedCheckpoint }
  | { readonly kind: 'AlreadyStored'; readonly checkpoint: VerifiedCheckpoint }
  | { readonly kind: 'CheckpointRejected' }
  | { readonly kind: 'OutboxBackpressure' }
  | { readonly kind: 'OutboxBoundReached' }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'Unavailable' };

export type EvidenceCheckpointReading =
  | { readonly kind: 'Read'; readonly checkpoint: VerifiedCheckpoint }
  | { readonly kind: 'CheckpointNotFound' }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'Unavailable' };

export type EvidenceCheckpointAcceptanceRecording =
  EvidenceRecording | { readonly kind: 'AlreadyRecorded'; readonly event: EvidenceEvent };

export type EvidenceSealAcknowledgementRecording =
  | { readonly kind: 'Recorded'; readonly projection: EvidenceStreamProjection }
  | { readonly kind: 'AlreadyRecorded'; readonly projection: EvidenceStreamProjection }
  | { readonly kind: 'AcknowledgementRejected' }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'Unavailable' };

export type EvidenceSealAcknowledgementReading =
  | { readonly kind: 'Read'; readonly projection: EvidenceStreamProjection }
  | { readonly kind: 'NotFound' }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'Unavailable' };

export interface EvidenceRecorder {
  readonly run: Run;
  readiness(): EvidenceReadinessInspection;
  record(observation: EvidenceObservation): EvidenceRecording;
  /** Commits every dimension together; Recorded identifies the final event. */
  recordBudgetDebit(debit: EvidenceBudgetDebit): EvidenceRecording;
  /** SecretDetected confirms atomic commitment of both withholding and security markers. */
  withhold(observation: {
    readonly occurredAt: string;
    readonly producer: EvidenceProducer;
    readonly disclosure: Extract<CredentialDisclosure, { readonly kind: 'WithheldSecret' }>;
  }): EvidenceWithholding;
  page(): EvidencePaging;
  acknowledge(acknowledgement: EvidenceBatchAcknowledgement): EvidenceAcknowledgementRecording;
  storeArtifact(input: EvidenceArtifactInput): EvidenceArtifactRecording;
  artifact(artifactSaid: string): EvidenceArtifactReading;
  storeCheckpoint(input: EvidenceCheckpointInput): EvidenceCheckpointRecording;
  checkpoint(checkpointSaid: string): EvidenceCheckpointReading;
  recordCheckpointAcceptance(checkpointSaid: string): EvidenceCheckpointAcceptanceRecording;
  recordSealAcknowledgement(
    projection: EvidenceStreamProjection,
  ): EvidenceSealAcknowledgementRecording;
  sealAcknowledgement(): EvidenceSealAcknowledgementReading;
  close(): void;
}

export interface EvidenceRecorderOpening {
  readonly run: Run;
  readonly stateRoot: string;
}

export type EvidenceRecorderAcquisition<Recorder extends EvidenceRecorder = EvidenceRecorder> =
  | { readonly kind: 'Opened'; readonly recorder: Recorder }
  | { readonly kind: 'ExistingOutboxRequiresLaterResume' }
  | { readonly kind: 'LocalStateCorruption' }
  | { readonly kind: 'Unavailable' };

export interface EvidenceRecorders<Recorder extends EvidenceRecorder = EvidenceRecorder> {
  open(input: EvidenceRecorderOpening): EvidenceRecorderAcquisition<Recorder>;
}
