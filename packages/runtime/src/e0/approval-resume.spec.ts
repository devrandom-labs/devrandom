import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ToolAccessEvidence } from '../evidence/tool-access-evidence.js';
import { createToolAccessRequest } from '../tool-access/request.js';

type ApprovalDispatchState =
  | {
      readonly status: 'ready';
      readonly approvalRequestId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly status: 'started';
      readonly approvalRequestId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly status: 'completed';
      readonly approvalRequestId: string;
      readonly idempotencyKey: string;
      readonly receipt: string;
    };

type ApprovalResume =
  | { readonly outcome: 'completed'; readonly receipt: string }
  | { readonly outcome: 'reconciliation_required'; readonly idempotencyKey: string };

function storeDispatch(path: string, state: ApprovalDispatchState): void {
  writeFileSync(path, JSON.stringify(state));
}

function loadDispatch(path: string): ApprovalDispatchState {
  return JSON.parse(readFileSync(path, 'utf8')) as ApprovalDispatchState;
}

async function resumeApprovedDispatch(
  path: string,
  execute: (idempotencyKey: string) => Promise<string>,
): Promise<ApprovalResume> {
  const state = loadDispatch(path);
  switch (state.status) {
    case 'completed':
      return { outcome: 'completed', receipt: state.receipt };
    case 'started':
      return { outcome: 'reconciliation_required', idempotencyKey: state.idempotencyKey };
    case 'ready': {
      storeDispatch(path, { ...state, status: 'started' });
      const receipt = await execute(state.idempotencyKey);
      storeDispatch(path, { ...state, status: 'completed', receipt });
      return { outcome: 'completed', receipt };
    }
  }
}

describe('E0 approval resume contract', () => {
  it('never repeats a completed or uncertain effect after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'devrandom-approval-'));
    const completedPath = join(root, 'completed.json');
    const uncertainPath = join(root, 'uncertain.json');
    const request = createToolAccessRequest(
      {
        runId: 'run-resume',
        taskRevisionId: 'task-revision-1',
        harnessRevisionId: 'harness-revision-1',
        modelTurnId: 'model-turn-1',
      },
      {
        toolCallId: 'tool-call-resume',
        toolName: 'external_write',
        input: { resource: 'record-resume', value: 'approved value' },
      },
      {
        toolName: 'external_write',
        requiredCapability: 'external.write',
        identifyResource: () => 'external://record-resume',
      },
    );
    const evidence = {
      kind: 'access_disposition',
      request,
      disposition: {
        kind: 'pending_approval',
        approvalRequestId: 'approval-request-resume',
        reason: 'human approval required',
      },
    } satisfies ToolAccessEvidence;
    const ready = {
      status: 'ready',
      approvalRequestId: evidence.disposition.approvalRequestId,
      idempotencyKey: `${evidence.disposition.approvalRequestId}:${evidence.request.argumentsDigest}`,
    } as const;

    try {
      storeDispatch(completedPath, ready);
      let completedEffects = 0;
      const first = await resumeApprovedDispatch(completedPath, () => {
        completedEffects += 1;
        return Promise.resolve('receipt-1');
      });
      const afterRestart = await resumeApprovedDispatch(completedPath, () => {
        completedEffects += 1;
        return Promise.resolve('must-not-run');
      });

      expect(first).toEqual({ outcome: 'completed', receipt: 'receipt-1' });
      expect(afterRestart).toEqual(first);
      expect(completedEffects).toBe(1);

      storeDispatch(uncertainPath, ready);
      let uncertainEffects = 0;
      await expect(
        resumeApprovedDispatch(uncertainPath, () => {
          uncertainEffects += 1;
          return Promise.reject(new Error('process lost after external effect'));
        }),
      ).rejects.toThrow('process lost after external effect');
      const uncertainAfterRestart = await resumeApprovedDispatch(uncertainPath, () => {
        uncertainEffects += 1;
        return Promise.resolve('must-not-run');
      });

      expect(uncertainAfterRestart).toEqual({
        outcome: 'reconciliation_required',
        idempotencyKey: ready.idempotencyKey,
      });
      expect(uncertainEffects).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
