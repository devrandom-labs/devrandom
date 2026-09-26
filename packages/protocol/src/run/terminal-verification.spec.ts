import { expect, it } from 'vitest';
import { prepareEvidenceArtifact } from '../evidence/evidence-artifact.js';
import { decodeRunTerminalVerification } from './terminal-verification.js';
const said = (letter: string) => 'E' + letter.repeat(43);
function receipt() {
  return {
    version: 1,
    kind: 'RunTerminalVerification',
    runId: '10000000-0000-4000-8000-000000000001',
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
}
function decode(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value));
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  if (artifact.kind !== 'Prepared') throw new Error('fixture');
  return decodeRunTerminalVerification(artifact.artifact, bytes);
}
it('binds original submission and terminal verifier to the same immutable source', () => {
  expect(decode(receipt()).kind).toBe('Accepted');
  expect(decode({ ...receipt(), verificationSourceSaid: said('x') })).toEqual({ kind: 'Rejected' });
  expect(decode({ ...receipt(), terminalVerdict: 'Fail' })).toEqual({ kind: 'Rejected' });
  expect(decode({ ...receipt(), terminalVerdict: 'Fail', verdict: 'Fail' }).kind).toBe('Accepted');
});
