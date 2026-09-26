import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decodePromotionSelectionRecord,
  preparePromotionSelectionRecord,
} from '@devrandom/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { PromotionEvidenceFile } from './promotion-evidence-file.js';
import { fixture, said } from '../../../test/promotion-evidence-fixture.js';

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
