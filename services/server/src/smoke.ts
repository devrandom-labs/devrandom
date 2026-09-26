import { verifiedIssuerFixture } from '../test/verified-issuer-fixture.js';
import { registrationRoutesFixture } from '../test/registration-routes-fixture.js';
import { buildDevrandomServer } from './server.js';
import { issuerReadinessFixture } from '../test/issuer-readiness-fixture.js';

const server = buildDevrandomServer(
  verifiedIssuerFixture(),
  registrationRoutesFixture(),
  issuerReadinessFixture(),
  { verify: () => Promise.resolve() },
);

try {
  const address = await server.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(`${address}/health`);
  const body: unknown = await response.json();

  if (!response.ok) {
    throw new Error(`issuer health returned ${String(response.status)}`);
  }

  if (
    typeof body !== 'object' ||
    body === null ||
    !('service' in body) ||
    body.service !== 'issuer' ||
    !('status' in body) ||
    body.status !== 'ready'
  ) {
    throw new Error('issuer health returned an unexpected body');
  }
  const experience = await fetch(`${address}/api/experience/query`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${'s'.repeat(43)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      version: 1,
      taskId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
      sourceInventorySaid: `E${'i'.repeat(43)}`,
      corpusSaid: `E${'c'.repeat(43)}`,
      failureQuery: 'receipt grammar mismatch',
      maximumResults: 3,
    }),
  });
  if (experience.status !== 503) {
    throw new Error(`unavailable hosted experience returned ${String(experience.status)}`);
  }
} finally {
  await server.close();
}
