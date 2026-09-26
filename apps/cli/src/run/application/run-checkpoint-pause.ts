import { isDeepStrictEqual } from 'node:util';
import type { VerifiedCheckpoint } from '@devrandom/protocol';
import type { PiExecutionGateway } from '@devrandom/runtime';

/** A successful Gateway edit is the sole trigger; subsequent effects are disabled before checkpointing. */
export class RunCheckpointPause {
  readonly #stop = new AbortController();
  #reached = false;
  get reached(): boolean {
    return this.#reached;
  }
  get signal(): AbortSignal {
    return this.#stop.signal;
  }
  hasProgress(
    repository: Extract<VerifiedCheckpoint, { readonly version: 1 }>['repository'],
    predecessor: Extract<VerifiedCheckpoint, { readonly version: 1 }>['repository'],
  ): boolean {
    return this.#reached && !isDeepStrictEqual(repository, predecessor);
  }
  gateway(gateway: PiExecutionGateway): PiExecutionGateway {
    return {
      propose: async (proposal, signal) => {
        if (this.#reached) return { kind: 'DependencyUnavailable' };
        const outcome = await gateway.propose(proposal, signal);
        if (
          outcome.kind === 'Completed' &&
          (proposal.input.kind === 'WriteFile' || proposal.input.kind === 'ReplaceText')
        ) {
          this.#reached = true;
          this.#stop.abort();
        }
        return outcome;
      },
    };
  }
}
