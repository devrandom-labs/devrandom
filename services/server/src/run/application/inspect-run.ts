import { projectRun, type RunProjection } from '@devrandom/protocol';

import type { Runs } from './runs.js';

export interface InspectRunInput {
  readonly ownerAid: string;
  readonly runId: string;
}

export type InspectRunOutcome =
  | { readonly kind: 'RunFound'; readonly projection: RunProjection }
  | { readonly kind: 'RunResourceNotFound'; readonly resource: 'Run' }
  | { readonly kind: 'DependencyUnavailable'; readonly dependency: 'HostedMongoDB' };

export async function inspectRun(
  input: InspectRunInput,
  runs: Pick<Runs, 'findById'>,
): Promise<InspectRunOutcome> {
  const inspected = await runs.findById(input.ownerAid, input.runId);
  switch (inspected.kind) {
    case 'RunFound':
      return { kind: 'RunFound', projection: projectRun(inspected.run) };
    case 'RunNotFound':
      return { kind: 'RunResourceNotFound', resource: 'Run' };
    case 'DependencyUnavailable':
      return inspected;
  }
}
