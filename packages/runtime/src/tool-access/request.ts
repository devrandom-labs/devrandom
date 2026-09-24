import { createHash } from 'node:crypto';

export interface ToolCallOrigin {
  readonly runId: string;
  readonly taskRevisionId: string;
  readonly harnessRevisionId: string;
  readonly modelTurnId: string;
}

export interface ToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface ToolAccessRequest extends ToolCallOrigin {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly requiredCapability: string;
  readonly resourceId: string;
  readonly argumentsDigest: string;
}

export interface ToolAccessMapping {
  readonly toolName: string;
  readonly requiredCapability: string;
  identifyResource(input: unknown): string;
}

function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Tool arguments must contain finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('Tool arguments must not be cyclic');
    ancestors.add(value);
    const encoded = `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    ancestors.delete(value);
    return encoded;
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) throw new Error('Tool arguments must not be cyclic');
    ancestors.add(value);
    const entries = Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => {
        const item: unknown = Reflect.get(value, key);
        return `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`;
      });
    ancestors.delete(value);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`Tool arguments cannot contain ${typeof value}`);
}

function digestArguments(input: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(input)).digest('hex')}`;
}

export function createToolAccessRequest(
  origin: ToolCallOrigin,
  call: ToolCall,
  mapping: ToolAccessMapping,
): ToolAccessRequest {
  return {
    ...origin,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    requiredCapability: mapping.requiredCapability,
    resourceId: mapping.identifyResource(call.input),
    argumentsDigest: digestArguments(call.input),
  };
}

export function hasSameAuthorizationBinding(
  left: ToolAccessRequest,
  right: ToolAccessRequest,
): boolean {
  return (
    left.runId === right.runId &&
    left.taskRevisionId === right.taskRevisionId &&
    left.harnessRevisionId === right.harnessRevisionId &&
    left.modelTurnId === right.modelTurnId &&
    left.toolCallId === right.toolCallId &&
    left.toolName === right.toolName &&
    left.requiredCapability === right.requiredCapability &&
    left.resourceId === right.resourceId &&
    left.argumentsDigest === right.argumentsDigest
  );
}
