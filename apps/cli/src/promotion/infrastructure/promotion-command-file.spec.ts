import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareActivationCommitCommand } from '@devrandom/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { fixture, said } from '../../../test/promotion-evidence-fixture.js';
import { PromotionCommandFile } from './promotion-command-file.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function command(governorExchangeSaid = said('g')) {
  const selection = fixture().selection;
  const prepared = prepareActivationCommitCommand({
    version: 1,
    commandId: '6eb93221-1ad0-4555-9aa3-b2ff2ed541a6',
    taskId: selection.taskId,
    taskRevisionSaid: selection.taskRevisionSaid,
    harnessLineageId: selection.harnessLineageId,
    expectedIncumbentRevisionSaid: selection.expectedIncumbentRevisionSaid,
    expectedPointerVersion: selection.expectedPointerVersion,
    evaluationManifestSaid: selection.evaluationManifestSaid,
    evaluationClosureSaid: selection.evaluationClosureSaid,
    exactPromotionMandateSaid: said('a'),
    agentProposalExchangeSaid: said('p'),
    governorDecisionExchangeSaid: governorExchangeSaid,
    selectionRecord: selection,
    disposition: { kind: 'RetainIncumbent', selectionEvidenceSaid: selection.d },
  });
  if (prepared.kind !== 'Prepared') throw new Error('invalid fixture');
  return prepared.command;
}

describe('private activation command custody', () => {
  it('reopens the exact signed command after restart and refuses a conflicting retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-activation-command-'));
    roots.push(root);
    const directory = join(root, 'private');
    const original = command();
    const first = new PromotionCommandFile(directory);
    expect(await first.inspect(original.commandId)).toEqual({ kind: 'Absent' });
    expect(await first.stage(original)).toBe('Staged');
    const reopened = new PromotionCommandFile(directory);
    expect(await reopened.inspect(original.commandId)).toEqual({
      kind: 'Staged',
      command: original,
    });
    expect(await reopened.stage(original)).toBe('Same');
    expect(await reopened.stage(command(said('z')))).toBe('Conflict');
    expect(await reopened.inspect(original.commandId)).toEqual({
      kind: 'Staged',
      command: original,
    });
  });

  it('refuses a symlink or forged stored command instead of falling through to network', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devrandom-activation-command-'));
    roots.push(root);
    const directory = join(root, 'private');
    const original = command();
    const custody = new PromotionCommandFile(directory);
    expect(await custody.stage(original)).toBe('Staged');
    const path = join(directory, `${original.commandId}.json`);
    await rm(path);
    const target = join(root, 'forged.json');
    await writeFile(target, JSON.stringify(original));
    await symlink(target, path);
    expect(await custody.inspect(original.commandId)).toEqual({ kind: 'Unavailable' });
    expect(await custody.stage(original)).toBe('Unavailable');
  });
});
