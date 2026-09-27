import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  credentialSchema,
  promotionMandateSchema,
  promotionMandateV2Schema,
  promotionMandateV3Schema,
  taskMandateSchema,
  taskMandateV2Schema,
  taskMandateV3Schema,
  taskMandateV4Schema,
  promotionMandateV4Schema,
  promotionMandateV6Schema,
  promotionMandateV5Schema,
  promotionMandateV7Schema,
} from '@devrandom/protocol';

const schemaDirectory = resolve(import.meta.dirname, '../../../schemas');

await Promise.all([
  writeFile(
    resolve(schemaDirectory, 'devrandom-promotion-mandate-v5.json'),
    `${JSON.stringify(promotionMandateV5Schema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-promotion-mandate-v7.json'),
    `${JSON.stringify(promotionMandateV7Schema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-promotion-mandate-v4.json'),
    `${JSON.stringify(promotionMandateV4Schema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-promotion-mandate-v6.json'),
    `${JSON.stringify(promotionMandateV6Schema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-task-mandate-v3.json'),
    `${JSON.stringify(taskMandateV3Schema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-task-mandate-v4.json'),
    `${JSON.stringify(taskMandateV4Schema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-credential.json'),
    `${JSON.stringify(credentialSchema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-task-mandate.json'),
    `${JSON.stringify(taskMandateSchema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-task-mandate-v2.json'),
    `${JSON.stringify(taskMandateV2Schema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-promotion-mandate.json'),
    `${JSON.stringify(promotionMandateSchema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-promotion-mandate-v2.json'),
    `${JSON.stringify(promotionMandateV2Schema, undefined, 2)}\n`,
  ),
  writeFile(
    resolve(schemaDirectory, 'devrandom-promotion-mandate-v3.json'),
    `${JSON.stringify(promotionMandateV3Schema, undefined, 2)}\n`,
  ),
]);
