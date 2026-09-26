import { describe, expect, it } from 'vitest';
import { TerminalRunSubmission } from './terminal-run-submission.js';
const source = 'E' + 's'.repeat(43),
  receipt = 'E' + 'r'.repeat(43);
function fixture(verdict: 'Pass' | 'Fail' = 'Pass') {
  const calls: string[] = [];
  const submissions = new TerminalRunSubmission({
    source: {
      freeze: () => {
        calls.push('freeze');
        return Promise.resolve({ kind: 'Frozen', sourceSaid: source });
      },
      unchanged: () => Promise.resolve(true),
    },
    publicVerification: {
      verify: (input) => {
        calls.push('public');
        expect(input.artifactSaids).toContain(source);
        return Promise.resolve({ kind: 'Accepted', receipts: [], outputArtifactSaids: [] });
      },
    },
    terminalVerification: {
      assess: (sourceSaid) => {
        calls.push('terminal');
        expect(sourceSaid).toBe(source);
        return Promise.resolve({ kind: 'Assessed', verdict, receiptArtifactSaid: receipt });
      },
    },
  });
  return { submissions, calls };
}
describe('immutable final Run submission', () => {
  it('accepts only the same frozen source through original public and protected terminal proof', async () => {
    const f = fixture();
    expect(await f.submissions.verify({ artifactSaids: [] }, new AbortController().signal)).toEqual(
      { kind: 'Accepted', receipts: [], outputArtifactSaids: [source, receipt] },
    );
    expect(f.calls).toEqual(['freeze', 'public', 'terminal']);
    expect(f.submissions.transferSubmittedVerification()).toMatchObject({
      kind: 'Transferred',
      verification: { kind: 'Accepted' },
    });
    expect(f.submissions.transferSubmittedVerification()).toEqual({ kind: 'AlreadyTransferred' });
  });
  it('retains a final failure receipt without returning held-out feedback to the executor', async () => {
    const f = fixture('Fail');
    expect(await f.submissions.verify({ artifactSaids: [] }, new AbortController().signal)).toEqual(
      { kind: 'DependencyUnavailable' },
    );
    expect(f.submissions.transferSubmittedVerification()).toMatchObject({
      kind: 'Transferred',
      verification: { kind: 'Blocked', outputArtifactSaids: [source, receipt] },
    });
  });
  it('never calls the protected case when source bytes changed after public verification', async () => {
    let assessments = 0;
    const submissions = new TerminalRunSubmission({
      source: {
        freeze: () => Promise.resolve({ kind: 'Frozen', sourceSaid: source }),
        unchanged: () => Promise.resolve(false),
      },
      publicVerification: {
        verify: () => Promise.resolve({ kind: 'Accepted', receipts: [], outputArtifactSaids: [] }),
      },
      terminalVerification: {
        assess: () => {
          assessments++;
          return Promise.resolve({ kind: 'Unavailable' });
        },
      },
    });
    expect(await submissions.verify({ artifactSaids: [] }, new AbortController().signal)).toEqual({
      kind: 'EvidenceIntegrityFailure',
    });
    expect(assessments).toBe(0);
  });
});
