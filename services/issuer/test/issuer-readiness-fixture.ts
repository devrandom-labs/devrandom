import type { IssuerReadinessProbe } from '../src/route/health-route.js';

export function issuerReadinessFixture(): IssuerReadinessProbe {
  return { verify: () => Promise.resolve() };
}
