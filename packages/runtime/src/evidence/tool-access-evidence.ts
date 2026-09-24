import type { ToolAccessDisposition } from '../tool-access/authorizer.js';
import type { ToolAccessRequest, ToolCallOrigin } from '../tool-access/request.js';

export type ToolAccessEvidence =
  | {
      readonly kind: 'access_disposition';
      readonly request: ToolAccessRequest;
      readonly disposition: ToolAccessDisposition;
    }
  | (ToolCallOrigin & {
      readonly kind: 'mediation_failure';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly reason: string;
    });

export interface ToolAccessEvidenceRecorder {
  record(evidence: ToolAccessEvidence): Promise<void> | void;
}
