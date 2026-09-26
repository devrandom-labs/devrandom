import { describe, expect, it } from 'vitest';
import {
  identifyCheckpointFileContent,
  prepareEvidenceArtifact,
  prepareEvidenceEvent,
  type EvidenceEvent,
  type EvidenceEventDetail,
} from '@devrandom/protocol';
import { recordedWorktreeWritesMatch } from './recorded-worktree-writes.js';

const said = (character: string) => `E${character.repeat(43)}`;
const id = '1cc482f1-98e9-4454-8e4c-5566cb47ce3d';
function fixture() {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      message: {
        content: [
          {
            type: 'toolCall',
            id: 'write-1',
            name: 'write_file',
            arguments: { path: 'src/lib.rs', content: 'original source' },
          },
        ],
      },
    }),
  );
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  const content = identifyCheckpointFileContent(new TextEncoder().encode('original source'));
  if (artifact.kind !== 'Prepared' || content.kind !== 'Identified') throw new Error('fixture');
  const events: EvidenceEvent[] = [];
  const record = (event: EvidenceEventDetail) => {
    const previous = events.at(-1);
    const prepared = prepareEvidenceEvent({
      version: 1,
      sequence: events.length,
      predecessor:
        previous === undefined ? { kind: 'Genesis' } : { kind: 'Previous', eventSaid: previous.d },
      taskId: id,
      taskRevisionSaid: said('t'),
      runId: id,
      incarnationId: id,
      harnessRevisionSaid: said('h'),
      personalAgentAid: said('p'),
      taskMandateSaid: said('m'),
      occurredAt: '2026-09-26T15:00:00.000Z',
      recordedAt: '2026-09-26T15:00:00.000Z',
      producer: { kind: event.kind === 'ModelMessageCompleted' ? 'PiExecutor' : 'ToolGateway' },
      event,
    });
    if (prepared.kind !== 'Prepared') throw new Error(prepared.kind);
    events.push(prepared.event);
  };
  record({
    kind: 'ModelMessageCompleted',
    piSessionId: id,
    modelTurnId: 'turn-1',
    messageArtifactSaid: artifact.artifact.d,
    disposition: 'Completed',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      spendMicroUsd: 0,
    },
  });
  const attribution = {
    piSessionId: id,
    modelTurnId: 'turn-1',
    toolCallId: 'write-1',
    proposalIndex: 0,
    tool: 'write_file' as const,
    requiredCapability: 'EditRepository' as const,
    resource: 'repository://src/lib.rs',
  };
  record({ kind: 'ToolAuthorized', ...attribution, mandateSaid: said('m') });
  record({ kind: 'EffectCompleted', ...attribution, outputArtifactSaids: [] });
  // Submission authorization is not evidence of submission or a new repository write.
  record({
    kind: 'ToolAuthorized',
    ...attribution,
    toolCallId: 'submit-1',
    tool: 'submit_result',
    requiredCapability: 'SubmitResult',
    resource: 'task://result',
    mandateSaid: said('m'),
  });
  return {
    events,
    evidence: { artifact: () => ({ kind: 'Read' as const, artifact: artifact.artifact, bytes }) },
    repository: {
      objectFormat: 'sha1' as const,
      baseCommit: '1'.repeat(40),
      baseTree: '2'.repeat(40),
      changedFiles: [
        {
          path: 'src/lib.rs',
          disposition: 'Modified' as const,
          mode: '100644',
          contentSaid: content.contentSaid,
        },
      ],
    },
  };
}

describe('original interrupted worktree writes', () => {
  it('checks current source against exact completed write arguments without running the tool', () => {
    expect(recordedWorktreeWritesMatch(fixture())).toBe(true);
  });
  it.each([
    'ChangedSource',
    'MissingArtifact',
    'TamperedArtifact',
    'UncompletedWrite',
    'ChangedMode',
    'SubstitutedArtifact',
  ] as const)('rejects %s', (mismatch) => {
    const input = fixture();
    const first = input.repository.changedFiles[0];
    if (first === undefined) throw new Error('fixture');
    if (mismatch === 'ChangedSource') first.contentSaid = said('x');
    if (mismatch === 'ChangedMode') first.mode = '100755';
    if (mismatch === 'UncompletedWrite') input.events.splice(2, 1);
    const replacement = prepareEvidenceArtifact(
      new TextEncoder().encode('different valid artifact'),
      'application/json',
    );
    if (replacement.kind !== 'Prepared') throw new Error('fixture');
    const evidence =
      mismatch === 'SubstitutedArtifact'
        ? {
            artifact: () => ({
              kind: 'Read' as const,
              artifact: replacement.artifact,
              bytes: new TextEncoder().encode('different valid artifact'),
            }),
          }
        : mismatch === 'MissingArtifact'
          ? { artifact: () => ({ kind: 'ArtifactNotFound' as const }) }
          : mismatch === 'TamperedArtifact'
            ? { artifact: () => ({ ...input.evidence.artifact(), bytes: new Uint8Array([1]) }) }
            : input.evidence;
    expect(recordedWorktreeWritesMatch({ ...input, evidence })).toBe(false);
  });
});
