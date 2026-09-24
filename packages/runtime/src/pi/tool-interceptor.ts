import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';

import type { ToolAccessEvidenceRecorder } from '../evidence/tool-access-evidence.js';
import type { ToolAuthorizer } from '../tool-access/authorizer.js';
import {
  createToolAccessRequest,
  hasSameAuthorizationBinding,
  type ToolAccessMapping,
  type ToolAccessRequest,
  type ToolCall,
  type ToolCallOrigin,
} from '../tool-access/request.js';
import { piBuiltinAccessMappings } from './builtin-access-mappings.js';

export interface PiToolBlock {
  readonly block: true;
  readonly kind: 'denied' | 'pending_approval' | 'mediation_failed';
  readonly reason: string;
}

export interface PiToolInterceptor {
  assertAllActiveToolsMediated(toolNames: readonly string[]): void;
  consumeExecutionGrant(call: ToolCall): ToolAccessRequest;
  intercept(call: ToolCall): Promise<PiToolBlock | undefined>;
}

export interface PiToolInterceptorOptions {
  readonly origin: ToolCallOrigin;
  readonly authorizer: ToolAuthorizer;
  readonly evidenceRecorder?: ToolAccessEvidenceRecorder;
  readonly mappings?: readonly ToolAccessMapping[];
  readonly workspace?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createPiToolInterceptor(options: PiToolInterceptorOptions): PiToolInterceptor {
  const mappings = new Map<string, ToolAccessMapping>();
  for (const mapping of [
    ...piBuiltinAccessMappings(options.workspace ?? '/workspace'),
    ...(options.mappings ?? []),
  ]) {
    if (mappings.has(mapping.toolName)) {
      throw new Error(`Pi tool ${mapping.toolName} has more than one access mapping`);
    }
    mappings.set(mapping.toolName, mapping);
  }
  const executionGrants = new Map<string, ToolAccessRequest>();

  function accessRequestFor(call: ToolCall): ToolAccessRequest {
    const mapping = mappings.get(call.toolName);
    if (!mapping) throw new Error(`Pi tool ${call.toolName} has no access mapping`);
    return createToolAccessRequest(options.origin, call, mapping);
  }

  return {
    assertAllActiveToolsMediated(toolNames) {
      const unmediated = toolNames.filter((toolName) => !mappings.has(toolName));
      if (unmediated.length > 0) {
        throw new Error(`Active Pi tools without an access mapping: ${unmediated.join(', ')}`);
      }
    },
    consumeExecutionGrant(call) {
      const grantedRequest = executionGrants.get(call.toolCallId);
      if (!grantedRequest) {
        throw new Error(`Pi tool call ${call.toolCallId} has no unconsumed execution grant`);
      }
      executionGrants.delete(call.toolCallId);
      const currentRequest = accessRequestFor(call);
      if (!hasSameAuthorizationBinding(grantedRequest, currentRequest)) {
        throw new Error(`Pi tool call ${call.toolCallId} changed after authorization`);
      }
      return currentRequest;
    },
    async intercept(call) {
      try {
        const request = accessRequestFor(call);
        if (executionGrants.has(call.toolCallId)) {
          throw new Error(`Pi tool call ${call.toolCallId} was permitted more than once`);
        }
        const disposition = await options.authorizer.authorize(request);
        await options.evidenceRecorder?.record({
          kind: 'access_disposition',
          request,
          disposition,
        });
        switch (disposition.kind) {
          case 'permitted': {
            executionGrants.set(call.toolCallId, request);
            return undefined;
          }
          case 'denied':
          case 'pending_approval': {
            if (disposition.kind === 'pending_approval') executionGrants.clear();
            return { block: true, kind: disposition.kind, reason: disposition.reason };
          }
        }
      } catch (error) {
        executionGrants.clear();
        const reason = errorMessage(error);
        await options.evidenceRecorder?.record({
          ...options.origin,
          kind: 'mediation_failure',
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          reason,
        });
        return {
          block: true,
          kind: 'mediation_failed',
          reason: `Tool access mediation failed: ${reason}`,
        };
      }
    },
  };
}

export function createPiToolInterceptorExtension(interceptor: PiToolInterceptor): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event, context) => {
      const block = await interceptor.intercept(event);
      if (!block) return undefined;
      const terminate = block.kind === 'pending_approval' || block.kind === 'mediation_failed';
      if (terminate) context.abort();
      return { block: true, reason: block.reason, terminate };
    });
  };
}
