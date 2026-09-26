import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prepareEvaluationSourceInventory } from '@devrandom/protocol';
import { expect, it } from 'vitest';

import { QualifiedSourceInventoryFile } from './qualified-source-inventory-file.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

it('durably records only exact inventory bytes and denies a symlinked custody directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devrandom-q-inventory-'));
  try {
    const prepared = prepareEvaluationSourceInventory({
      taskId: 'bbb13317-1c5e-4472-842e-692da01386cf',
      taskRevisionSaid: said('t'),
      ownerAid: said('o'),
      repositoryResourceSaid: said('r'),
      corpusSaid: said('c'),
      experienceMandateSaid: said('m'),
      sources: [
        {
          episodeSaid: said('e'),
          rawEvidenceSaid: said('f'),
          ownerAid: said('o'),
          repositoryResourceSaid: said('r'),
          corpusSaid: said('c'),
          disclosure: 'AuthorizedAnalogy',
        },
      ],
    });
    if (prepared.kind !== 'Prepared') throw new Error('inventory fixture rejected');
    const directory = join(root, 'reviewed');
    const storage = new QualifiedSourceInventoryFile(directory);
    const first = await storage.commit(prepared.inventory);
    expect(first).toEqual({
      kind: 'Recorded',
      inventorySaid: prepared.inventory.d,
      path: join(directory, `${prepared.inventory.d}.json`),
    });
    expect(await readFile(join(directory, `${prepared.inventory.d}.json`), 'utf8')).toBe(
      JSON.stringify(prepared.inventory),
    );
    expect(await storage.commit(prepared.inventory)).toEqual(first);
    const linked = join(root, 'linked');
    await symlink(directory, linked);
    expect((await new QualifiedSourceInventoryFile(linked).commit(prepared.inventory)).kind).toBe(
      'Unavailable',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
