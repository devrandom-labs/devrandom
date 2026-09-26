import { prepareEvaluationSourceInventory } from '@devrandom/protocol';
import { expect, it } from 'vitest';

import { decodeDevrandomServerOrigin } from '../../infrastructure/devrandom-server-http.js';
import { HostedH0Context } from './hosted-h0-context.js';

const said = (letter: string): string => `E${letter.repeat(43)}`;

it('keeps H0 Atlas and exact raw reads scoped to the prepared inventory', async () => {
  const prepared = prepareEvaluationSourceInventory({
    taskId: '11111111-1111-4111-8111-111111111111',
    taskRevisionSaid: said('t'),
    ownerAid: said('o'),
    repositoryResourceSaid: said('r'),
    corpusSaid: said('c'),
    experienceMandateSaid: said('m'),
    sources: [
      {
        episodeSaid: said('e'),
        rawEvidenceSaid: said('a'),
        ownerAid: said('o'),
        repositoryResourceSaid: said('r'),
        corpusSaid: said('c'),
        disclosure: 'AuthorizedAnalogy',
      },
    ],
  });
  const origin = decodeDevrandomServerOrigin('http://127.0.0.1:3211');
  if (prepared.kind !== 'Prepared' || origin.kind !== 'Accepted') throw new Error('fixture');
  let requests = 0;
  const context = new HostedH0Context(origin.origin, 'b'.repeat(43), () => {
    requests += 1;
    throw new Error('wrong scope reached network');
  }).open(prepared.inventory);
  expect(
    await context.retrieval.retrieve({
      taskId: prepared.inventory.taskId,
      taskRevisionSaid: said('x'),
      sourceInventorySaid: prepared.inventory.d,
      corpusSaid: prepared.inventory.corpusSaid,
      failureQuery: 'public legacy failure',
      maximumResults: 3,
    }),
  ).toEqual({ kind: 'Denied' });
  expect(
    await context.reading.read({
      taskId: prepared.inventory.taskId,
      sourceInventorySaid: prepared.inventory.d,
      evidenceSaid: said('x'),
      offset: 0,
      maximumBytes: 100,
    }),
  ).toEqual({ kind: 'NotFound' });
  expect(requests).toBe(0);
});
