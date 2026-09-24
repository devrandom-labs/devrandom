import { relative, resolve, sep } from 'node:path';

import type { ToolAccessMapping } from '../tool-access/request.js';

function stringProperty(input: unknown, name: string): string {
  if (typeof input !== 'object' || input === null || !(name in input)) {
    throw new Error(`Pi ${name} must be a string`);
  }
  const value: unknown = Reflect.get(input, name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Pi ${name} must be a non-empty string`);
  }
  return value;
}

function workspaceResourceId(workspace: string, input: unknown): string {
  const resourceId = resolve(workspace, stringProperty(input, 'path'));
  const fromWorkspace = relative(workspace, resourceId);
  if (fromWorkspace === '..' || fromWorkspace.startsWith(`..${sep}`)) {
    throw new Error('Pi workspace resource escapes the active workspace');
  }
  return resourceId;
}

export function piBuiltinAccessMappings(workspaceInput: string): readonly ToolAccessMapping[] {
  const workspace = resolve(workspaceInput);
  return [
    {
      toolName: 'read',
      requiredCapability: 'workspace.read',
      identifyResource: (input) => workspaceResourceId(workspace, input),
    },
    {
      toolName: 'write',
      requiredCapability: 'workspace.write',
      identifyResource: (input) => workspaceResourceId(workspace, input),
    },
    {
      toolName: 'edit',
      requiredCapability: 'workspace.write',
      identifyResource: (input) => workspaceResourceId(workspace, input),
    },
    {
      toolName: 'bash',
      requiredCapability: 'process.execute',
      identifyResource: (input) => {
        stringProperty(input, 'command');
        return `process:${workspace}`;
      },
    },
  ];
}
