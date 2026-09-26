import { isDeepStrictEqual } from 'node:util';
import type { HostedEvaluationPosition } from './server-evaluation-http.js';

type Position = Extract<HostedEvaluationPosition, { kind: 'Read' }>['position'];

/** A hosted read may renew the same lease, but cannot substitute admission or evidence. */
export function preservesEvaluationPosition(before: Position, after: Position): boolean {
  const { lease: previousLease, currentEvaluationVersion: previousVersion, ...previous } = before;
  const { lease, currentEvaluationVersion: version, ...current } = after;
  if (
    ![previousVersion, version, previousLease.version, lease.version].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    ![previousLease.serverTime, previousLease.expiresAt, lease.serverTime, lease.expiresAt].every(
      (value) => Number.isFinite(Date.parse(value)),
    ) ||
    Date.parse(lease.expiresAt) <= Date.parse(lease.serverTime) ||
    !isDeepStrictEqual(previous, current) ||
    lease.evaluationId !== previousLease.evaluationId ||
    lease.leaseId !== previousLease.leaseId ||
    Date.parse(lease.expiresAt) <= Date.now()
  )
    return false;
  if (lease.version === previousLease.version)
    return version === previousVersion && isDeepStrictEqual(lease, previousLease);
  return (
    lease.version > previousLease.version &&
    version - previousVersion >= lease.version - previousLease.version &&
    Date.parse(lease.serverTime) >= Date.parse(previousLease.serverTime) &&
    Date.parse(lease.expiresAt) > Date.parse(previousLease.expiresAt)
  );
}
