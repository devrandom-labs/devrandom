import type { RunLeaseProjection } from '@devrandom/protocol';
import type {
  RunLeaseAuthority,
  RunLeaseReceipt,
  RunLeaseRenewal,
  RunLeaseRenewalCommand,
} from '@devrandom/runtime';

import type { HostedRuns } from '../application/baseline-run-admission.js';

export function initialRunLeaseReceipt(projection: RunLeaseProjection): RunLeaseReceipt {
  return {
    runId: projection.runId,
    incarnationId: projection.incarnationId,
    runVersion: projection.runVersion,
    serverTime: projection.serverTime,
    expiresAt: projection.expiresAt,
  };
}

export class HostedRunLeaseAuthority implements RunLeaseAuthority {
  readonly #hosted: Pick<HostedRuns, 'renewLease'>;

  constructor(hosted: Pick<HostedRuns, 'renewLease'>) {
    this.#hosted = hosted;
  }

  async renew(command: RunLeaseRenewalCommand): Promise<RunLeaseRenewal> {
    try {
      const renewal = await this.#hosted.renewLease(command.runId, command.incarnationId, {
        version: 1,
        expectedRunVersion: command.expectedRunVersion,
      });
      switch (renewal.kind) {
        case 'Renewed':
          return {
            kind: 'Renewed',
            receipt: {
              runId: renewal.receipt.runId,
              incarnationId: renewal.receipt.incarnationId,
              runVersion: renewal.receipt.runVersion,
              serverTime: renewal.receipt.serverTime,
              expiresAt: renewal.receipt.expiresAt,
            },
          };
        case 'InputInvalid':
        case 'RequestRejected':
          return { kind: 'Rejected' };
        case 'ServerUnavailable':
        case 'ResponseInvalid':
          return { kind: 'Unavailable' };
      }
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
