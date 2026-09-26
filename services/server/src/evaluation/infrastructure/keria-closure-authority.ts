import { isDeepStrictEqual } from 'node:util';

import type { Collection, Db } from 'mongodb';

import type { EvolutionSourceScope } from '@devrandom/domain';
import {
  personalAgentAid,
  type IssuerAid,
  type IssuerEvaluationClosureSealExchange,
} from '@devrandom/identity';
import { decodeEvaluationClosure, evaluationClosureSealPayload } from '@devrandom/protocol';

import type { EvaluationClosureAuthority } from '../application/close-evaluation.js';
import {
  evaluationCollectionNames,
  type EvaluationDocument,
} from './mongo-evaluation-reservations.js';

interface CurrentClosureSource {
  inspectInventory(input: {
    readonly ownerAid: string;
    readonly taskId: string;
    readonly sourceInventorySaid: string;
  }): Promise<
    | {
        readonly kind: 'Authorized';
        readonly scope: EvolutionSourceScope;
        readonly personalAgentAid: string;
      }
    | { readonly kind: 'Denied' | 'Unavailable' }
  >;
}

/** KERIA-authenticated agent closure claim plus current Task/Mandate and reservation bindings. */
export class KeriaEvaluationClosureAuthority implements EvaluationClosureAuthority {
  readonly #evaluations: Collection<EvaluationDocument>;
  readonly #scopes: CurrentClosureSource;
  readonly #exchanges: IssuerEvaluationClosureSealExchange;
  readonly #issuerAid: IssuerAid;

  constructor(
    database: Db,
    dependencies: {
      readonly scopes: CurrentClosureSource;
      readonly exchanges: IssuerEvaluationClosureSealExchange;
      readonly issuerAid: IssuerAid;
    },
  ) {
    this.#evaluations = database.collection(evaluationCollectionNames.evaluations);
    this.#scopes = dependencies.scopes;
    this.#exchanges = dependencies.exchanges;
    this.#issuerAid = dependencies.issuerAid;
  }

  async verify(input: Parameters<EvaluationClosureAuthority['verify']>[0]) {
    const { ownerAid, closure } = input;
    if (decodeEvaluationClosure(closure).kind !== 'Accepted') return { kind: 'Denied' } as const;
    try {
      const evaluation = await this.#evaluations.findOne({ _id: closure.evaluationId, ownerAid });
      if (
        evaluation === null ||
        evaluation._id !== closure.evaluationId ||
        evaluation.ownerAid !== ownerAid ||
        evaluation.evidenceStreamId !== closure.evidenceStreamId ||
        evaluation.command.originRunId !== closure.originRunId ||
        evaluation.lease.evaluationId !== closure.evaluationId ||
        !Number.isSafeInteger(evaluation.lease.version) ||
        evaluation.lease.version < 1 ||
        !Number.isFinite(Date.parse(evaluation.lease.expiresAt)) ||
        Date.parse(evaluation.lease.expiresAt) <= Date.now()
      )
        return { kind: 'Denied' } as const;
      const current = await this.#scopes.inspectInventory({
        ownerAid,
        taskId: evaluation.command.taskId,
        sourceInventorySaid: evaluation.command.sourceInventorySaid,
      });
      if (current.kind === 'Unavailable') return { kind: 'Unavailable' } as const;
      if (
        current.kind !== 'Authorized' ||
        current.scope.ownerAid !== ownerAid ||
        current.scope.taskId !== evaluation.command.taskId ||
        current.scope.taskRevisionSaid !== evaluation.command.taskRevisionSaid ||
        current.scope.mandate.kind !== 'AuthorizedExperience' ||
        current.scope.mandate.mandateSaid !== evaluation.command.taskMandateSaid ||
        current.personalAgentAid !== evaluation.command.personalAgentAid
      )
        return { kind: 'Denied' } as const;
      let sourceAid;
      try {
        sourceAid = personalAgentAid(evaluation.command.personalAgentAid);
      } catch {
        return { kind: 'Denied' } as const;
      }
      const payload = evaluationClosureSealPayload(closure);
      const inspected = await this.#exchanges.inspect({
        exchangeSaid: closure.agentSealSaid,
        sourceAid,
        recipientAid: this.#issuerAid,
        payload,
      });
      if (inspected.kind === 'Unavailable') return { kind: 'Unavailable' } as const;
      if (
        inspected.kind !== 'Verified' ||
        inspected.exchangeSaid !== closure.agentSealSaid ||
        inspected.sourceAid !== sourceAid ||
        !isDeepStrictEqual(inspected.payload, payload)
      )
        return { kind: 'Denied' } as const;
      return { kind: 'Authorized' } as const;
    } catch {
      return { kind: 'Unavailable' } as const;
    }
  }
}
