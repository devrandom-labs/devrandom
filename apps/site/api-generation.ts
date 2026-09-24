import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { generateIssuerEndpoints } from './openapi.config.ts';

const generated = await generateIssuerEndpoints();
await writeFile(resolve(import.meta.dirname, 'src/api/issuer-endpoints.ts'), generated);
