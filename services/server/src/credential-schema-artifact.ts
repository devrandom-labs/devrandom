import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { credentialSchema, promotionMandateSchema, taskMandateSchema } from '@devrandom/protocol';

const schemaDirectory = resolve(import.meta.dirname, '../../../schemas');

await Promise.all([
  writeFile(
    resolve(schemaDirectory, 'devrandom-credential.json'),
    `${JSON.stringify(credentialSchema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-task-mandate.json'),
    `${JSON.stringify(taskMandateSchema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-promotion-mandate.json'),
    `${JSON.stringify(promotionMandateSchema, undefined, 2)}\n`,
  ),
]);
