import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { credentialSchema } from '@devrandom/protocol';

const destination = resolve(import.meta.dirname, '../../../schemas/devrandom-credential.json');
await writeFile(destination, `${JSON.stringify(credentialSchema, undefined, 2)}\n`);
