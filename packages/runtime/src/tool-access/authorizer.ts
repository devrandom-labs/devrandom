import type { ToolAccessRequest } from './request.js';

export type ToolAccessDisposition =
  | { readonly kind: 'permitted' }
  | { readonly kind: 'denied'; readonly reason: string }
  | {
      readonly kind: 'pending_approval';
      readonly approvalRequestId: string;
      readonly reason: string;
    };

export interface ToolAuthorizer {
  authorize(request: ToolAccessRequest): Promise<ToolAccessDisposition>;
}
