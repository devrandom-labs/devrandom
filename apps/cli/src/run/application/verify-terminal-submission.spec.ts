import { expect, it } from 'vitest';
import type { Run } from '@devrandom/domain';
import { prepareEvidenceArtifact } from '@devrandom/protocol';
import type { RunPredecessorCustody } from './run-predecessor-custody.js';
import { verifyTerminalSubmission } from './verify-terminal-submission.js';
const said = (letter: string) => 'E' + letter.repeat(43);
function fixture() {
  const runId = '10000000-0000-4000-8000-000000000001';
  const receipt = {
    version: 1,
    kind: 'RunTerminalVerification',
    runId,
    taskRevisionSaid: said('t'),
    harnessRevisionSaid: said('h'),
    segmentSaid: said('s'),
    evaluationId: '10000000-0000-4000-8000-000000000002',
    manifestSaid: said('m'),
    submittedSourceSaid: said('a'),
    verificationSourceSaid: said('a'),
    executableSaid: said('e'),
    buildReceiptSaid: said('b'),
    buildCleanupReceiptSaid: said('c'),
    publicCases: [
      {
        conditionId: 'public-api',
        verdict: 'Pass',
        rawObservationSaid: said('r'),
        cleanupReceiptSaid: said('q'),
      },
    ],
    terminalCaseArtifactSaid: said('f'),
    encryptedObservationSaid: said('o'),
    terminalCleanupReceiptSaid: said('z'),
    terminalVerdict: 'Pass',
    verdict: 'Pass',
  };
  const bytes = Buffer.from(JSON.stringify(receipt));
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  if (artifact.kind !== 'Prepared') throw new Error('artifact');
  const run = {
    binding: { runId, taskRevisionSaid: said('t') },
    lifecycle: { kind: 'Ended', outcome: { kind: 'Submitted', checkpointSaid: said('k') } },
    submissionVerification: { kind: 'Accepted' },
    currentExecution: { harnessRevisionSaid: said('h'), segmentSaid: said('s') },
  } as unknown as Run;
  const custody = {
    stream: { seal: { kind: 'Sealed' } },
    checkpoint: {
      d: said('k'),
      runState: {
        kind: 'Ended',
        outcome: { kind: 'Submitted' },
        verification: { kind: 'Accepted' },
      },
      outputArtifactSaids: [artifact.artifact.d],
    },
    artifacts: [{ artifact: artifact.artifact, bytes }],
    events: [
      {
        producer: { kind: 'RunSupervisor' },
        event: { kind: 'ResultSubmitted', artifactSaids: [said('a')] },
      },
      {
        producer: { kind: 'ProtectedTaskVerifier' },
        event: { kind: 'Observation', artifactSaid: artifact.artifact.d },
      },
    ],
  } as unknown as RunPredecessorCustody;
  return { run, custody };
}
it('verifies only the already sealed same-source terminal receipt and returns stable retry identity', () => {
  const f = fixture();
  expect(verifyTerminalSubmission(f.run, f.custody)).toMatchObject({
    kind: 'Verified',
    submittedSourceSaid: said('a'),
    verificationSourceSaid: said('a'),
    manifestSaid: said('m'),
  });
  expect(verifyTerminalSubmission(f.run, f.custody)).toEqual(
    verifyTerminalSubmission(f.run, f.custody),
  );
  expect(
    verifyTerminalSubmission(f.run, { ...f.custody, events: f.custody.events.slice(1) }),
  ).toEqual({ kind: 'Rejected' });
  expect(
    verifyTerminalSubmission(f.run, {
      ...f.custody,
      stream: { ...f.custody.stream, seal: { kind: 'Unsealed' } },
    }),
  ).toEqual({ kind: 'Rejected' });
});
