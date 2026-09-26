import type { RunBudgetCommitment } from '../run/run-resource-budget.js';
import type { RunResourceBudget } from '../run/run-resource-budget.js';
import type { ToolBudgetReservation, ToolProposalBudget } from './tool-gateway.js';

function budgetCommitment(commitment: RunBudgetCommitment): ToolBudgetReservation {
  switch (commitment.kind) {
    case 'SecretDetected':
      return { kind: 'SecretDetected' };
    case 'Committed':
      return { kind: 'Reserved' };
    case 'Exhausted':
      return { kind: 'Exhausted' };
    case 'OutboxBackpressure':
      return commitment;
    case 'Unavailable':
      return commitment;
    case 'ReservationRejected':
    case 'EvidenceIntegrityFailure':
      return { kind: 'EvidenceIntegrityFailure' };
  }
}

export class ToolProposalBudgetLedger implements ToolProposalBudget {
  readonly #budget: RunResourceBudget;

  constructor(budget: RunResourceBudget) {
    this.#budget = budget;
  }

  reserve(input: { readonly runId: string }): Promise<ToolBudgetReservation> {
    if (input.runId !== this.#budget.runId) {
      return Promise.resolve({ kind: 'Unavailable' });
    }
    const reservation = this.#budget.reserve([{ budget: 'toolProposals', amount: 1 }]);
    switch (reservation.kind) {
      case 'Exhausted':
        return Promise.resolve({ kind: 'Exhausted' });
      case 'ReservationInvalid':
        return Promise.resolve({ kind: 'EvidenceIntegrityFailure' });
      case 'Reserved':
        return Promise.resolve(
          budgetCommitment(
            this.#budget.commit(reservation.reservation, {
              producer: { kind: 'ToolGateway' },
              actual: [{ budget: 'toolProposals', amount: 1 }],
            }),
          ),
        );
    }
  }
}
