import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { comparisonSlots, tamperAuditObligations, tamperLifecycleRoles } from '@devrandom/domain';
import {
  decodePromotionSelectionRecord,
  prepareEvaluationClosure,
  prepareEvaluationClosureEvidenceIndex,
  preparePromotionSelectionRecord,
} from '@devrandom/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { PromotionEvidenceFile } from './promotion-evidence-file.js';

const said = (letter: string) => `E${letter.repeat(43)}`;
const scopes = ['Shared', 'H1', 'C1', 'C2', 'C3', 'H1TaskSearch'] as const;
const dimensions = [
  'providerRequests',
  'providerInputTokens',
  'providerOutputTokens',
  'providerSpendMicroUsd',
  'runWallTimeSeconds',
  'toolProposals',
  'aggregateChildCommandTimeSeconds',
  'changedFiles',
  'changedWorktreeBytes',
] as const;
const evaluationId = '11111111-1111-4111-8111-111111111111';
const streamId = '33333333-3333-4333-8333-333333333333';
const originRunId = '44444444-4444-4444-8444-444444444444';
const taskId = '55555555-5555-4555-8555-555555555555';
const lineageId = '66666666-6666-4666-8666-666666666666';

function fixture() {
  let serial = 0;
  const nextSaid = () => `E${String(++serial).padStart(43, '0')}`;
  const index = prepareEvaluationClosureEvidenceIndex({
    version: 1,
    kind: 'EvaluationClosureEvidenceIndex',
    evaluationId,
    manifestSaid: said('M'),
    sourceInventorySaid: said('S'),
    hypothesisSaid: said('H'),
    lease: { leaseId: '22222222-2222-4222-8222-222222222222', version: 3 },
    observations: comparisonSlots().map((slot) => ({ slot, artifactSaid: nextSaid() })),
    measurements: comparisonSlots()
      .filter((slot) => slot.attempt === 1)
      .map((slot) => ({ slot, artifactSaid: nextSaid() })),
    audits: scopes.map((scope) => ({
      scope,
      assessmentArtifactSaid: nextSaid(),
      proofs: tamperAuditObligations.map((obligation) => ({
        scope,
        obligation,
        proofSaid: nextSaid(),
        finding: 'Pass' as const,
      })),
      attemptCoverage: {
        scope,
        proofSaid: nextSaid(),
        complete: true,
        coveredRoles: [...tamperLifecycleRoles],
        attempts: [],
      },
      obligations: Object.fromEntries(
        tamperAuditObligations.map((obligation) => [obligation, 'Pass']),
      ),
      verdict: 'Pass' as const,
    })),
    budget: {
      coverageEventSaid: nextSaid(),
      totals: Object.fromEntries(dimensions.map((dimension) => [dimension, 1])),
      anchors: dimensions.map((dimension) => ({
        dimension,
        finalDebitEventSaid: nextSaid(),
        receiptArtifactSaid: nextSaid(),
        sourceEventSaid: nextSaid(),
      })),
    },
  });
  if (index.kind !== 'Prepared') throw new Error(`index fixture: ${index.reason}`);
  const [shared, h1, c1, c2, c3, search] = index.index.audits;
  if (!shared || !h1 || !c1 || !c2 || !c3 || !search) throw new Error('audit fixture missing');
  const closure = prepareEvaluationClosure({
    evaluationId,
    evidenceStreamId: streamId,
    originRunId,
    manifestSaid: index.index.manifestSaid,
    evidenceIndexSaid: index.artifact.d,
    acceptedEventCount: 42,
    acceptedHeadSaid: said('Q'),
    observationSaids: index.index.observations.map((item) => item.artifactSaid),
    measurementSaids: index.index.measurements.map((item) => item.artifactSaid),
    sharedAuditSaid: shared.assessmentArtifactSaid,
    armAuditSaids: {
      H1: h1.assessmentArtifactSaid,
      C1: c1.assessmentArtifactSaid,
      C2: c2.assessmentArtifactSaid,
      C3: c3.assessmentArtifactSaid,
      H1TaskSearch: search.assessmentArtifactSaid,
    },
    protectedCustodySaid: said('P'),
    agentSealSaid: said('A'),
  });
  if (closure.kind !== 'Prepared') throw new Error(`closure fixture: ${closure.reason}`);
  const command = {
    version: 1 as const,
    commandId: '77777777-7777-4777-8777-777777777777',
    fingerprint: `sha256:${'a'.repeat(64)}`,
    expectedEvaluationVersion: 42,
    closure: closure.closure,
    evidenceIndex: {
      artifact: index.artifact,
      bytesBase64Url: Buffer.from(index.bytes).toString('base64url'),
    },
  };
  const selection = preparePromotionSelectionRecord({
    taskId,
    taskRevisionSaid: said('T'),
    harnessLineageId: lineageId,
    expectedIncumbentRevisionSaid: said('R'),
    expectedPointerVersion: 1,
    evaluationManifestSaid: index.index.manifestSaid,
    evaluationClosureSaid: closure.closure.d,
    hypothesisSaid: index.index.hypothesisSaid,
    selection: { kind: 'RetainIncumbent' },
  });
  if (selection.kind !== 'Prepared') throw new Error(`selection fixture: ${selection.reason}`);
  return { command, selection: selection.record };
}

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('promotion evidence local pre-network custody', () => {
  it('refuses an ancestor symlink before retaining a closure command', async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'devrandom-promotion-parent-'));
    directories.push(root);
    const real = join(root, 'real');
    await mkdir(real, { mode: 0o700 });
    await symlink(real, join(root, 'alias'));
    const { command } = fixture();
    expect(
      await new PromotionEvidenceFile(join(root, 'alias', 'promotion')).stageClosure(command),
    ).toBe('Unavailable');
  });

  it('retains exact closure/index and selection across process loss, never calling them verified', async () => {
    const directory = await mkdtemp(
      join(await realpath(tmpdir()), 'devrandom-promotion-evidence-'),
    );
    directories.push(directory);
    await rm(directory, { recursive: true });
    const { command, selection } = fixture();
    const first = new PromotionEvidenceFile(directory);
    expect(await first.stageClosure(command)).toBe('Staged');
    expect(await first.stageSelection(selection)).toBe('Staged');
    const restarted = new PromotionEvidenceFile(directory);
    expect(await restarted.inspect(command.closure.d)).toMatchObject({
      kind: 'Staged',
      closureCommand: command,
      selectionRecord: selection,
    });
    expect(await restarted.stageClosure(command)).toBe('Staged');
    expect(await restarted.stageSelection(selection)).toBe('Staged');
    expect(
      await restarted.stageClosure({
        ...command,
        commandId: '88888888-8888-4888-8888-888888888888',
      }),
    ).toBe('Conflict');
  });

  it('rejects substituted index, wrong-M selection and altered durable bytes after restart', async () => {
    const directory = await mkdtemp(
      join(await realpath(tmpdir()), 'devrandom-promotion-evidence-'),
    );
    directories.push(directory);
    await rm(directory, { recursive: true });
    const { command, selection } = fixture();
    const custody = new PromotionEvidenceFile(directory);
    expect(
      await custody.stageClosure({
        ...command,
        evidenceIndex: { ...command.evidenceIndex, bytesBase64Url: 'AA' },
      }),
    ).toBe('Unavailable');
    expect(await custody.stageClosure(command)).toBe('Staged');
    const wrong = preparePromotionSelectionRecord({
      taskId: selection.taskId,
      taskRevisionSaid: selection.taskRevisionSaid,
      harnessLineageId: selection.harnessLineageId,
      expectedIncumbentRevisionSaid: selection.expectedIncumbentRevisionSaid,
      expectedPointerVersion: selection.expectedPointerVersion,
      evaluationManifestSaid: said('X'),
      evaluationClosureSaid: selection.evaluationClosureSaid,
      hypothesisSaid: selection.hypothesisSaid,
      selection: selection.selection,
    });
    if (wrong.kind !== 'Prepared') throw new Error('wrong selection fixture rejected');
    expect(await custody.stageSelection(wrong.record)).toBe('Conflict');
    expect(await custody.stageSelection(selection)).toBe('Staged');
    const path = join(directory, `${command.closure.d}.selection.json`);
    const stored: unknown = JSON.parse(await readFile(path, 'utf8'));
    const decoded = decodePromotionSelectionRecord(stored);
    if (decoded.kind !== 'Accepted') throw new Error('stored selection fixture invalid');
    await writeFile(path, JSON.stringify({ ...decoded.record, hypothesisSaid: said('X') }));
    expect(await new PromotionEvidenceFile(directory).inspect(command.closure.d)).toEqual({
      kind: 'Unavailable',
    });
  });
});
