import type { PiExecutionGateway } from '@devrandom/runtime';

export interface RunSubmissionSourceCustody {
  writersStopped(): boolean;
}

/** The only writer is the parent Gateway. Submission closes its admission after earlier effects settle. */
export class RunEffectQuiescence implements RunSubmissionSourceCustody {
  #active = false;
  #submission = false;
  writersStopped(): boolean {
    return this.#submission;
  }
  gateway(gateway: PiExecutionGateway): PiExecutionGateway {
    return {
      propose: async (proposal, signal) => {
        if (this.#active || this.#submission) return { kind: 'DependencyUnavailable' };
        this.#active = true;
        if (proposal.input.kind === 'SubmitResult') this.#submission = true;
        try {
          return await gateway.propose(proposal, signal);
        } finally {
          this.#active = false;
        }
      },
    };
  }
}
