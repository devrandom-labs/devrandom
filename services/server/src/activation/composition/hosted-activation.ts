import { randomUUID } from 'node:crypto';

import type { Db, MongoClient } from 'mongodb';
import type {
  IssuerActivationReceiptExchange,
  IssuerAid,
  IssuerPromotionExchanges,
} from '@devrandom/identity';

import type { WorkAccessAttempts } from '../../access/application/work-access-attempts.js';
import { workAccessHostedEvaluationAuthorizer } from '../../access/infrastructure/work-access-hosted-evaluation-authorizer.js';
import type {
  CurrentPromotionMandateAuthorization,
  CurrentPromotionMandateInput,
} from '../../mandate/application/current-promotion-mandate.js';
import { commitActivation } from '../application/commit-activation.js';
import { issuerActivationReceipts } from '../infrastructure/issuer-activation-receipts.js';
import { KeriaActivationAuthority } from '../infrastructure/keria-activation-authority.js';
import { MongoActivationCommits } from '../infrastructure/mongo-activation-commits.js';
import type { ActivationRoutesConfiguration } from '../route/activation-routes.js';

/** Compose existing authority, local signed decision, and Mongo pointer without server grading. */
export function composeHostedActivation(input: {
  readonly client: MongoClient;
  readonly database: Db;
  readonly attempts: WorkAccessAttempts;
  readonly issuerAid: IssuerAid;
  readonly issuerAlias: string;
  readonly promotionExchanges: IssuerPromotionExchanges;
  readonly activationReceiptExchange: IssuerActivationReceiptExchange;
  readonly mandates: {
    authorize(input: CurrentPromotionMandateInput): Promise<CurrentPromotionMandateAuthorization>;
  };
}): ActivationRoutesConfiguration {
  const now = () => new Date().toISOString();
  const authority = new KeriaActivationAuthority(input.database, {
    mandates: input.mandates,
    exchanges: input.promotionExchanges,
    issuerAid: input.issuerAid,
    now,
  });
  const storage = new MongoActivationCommits(input.client, input.database);
  const receipts = issuerActivationReceipts({
    exchange: input.activationReceiptExchange,
    issuerAid: input.issuerAid,
    senderAlias: input.issuerAlias,
  });
  return {
    access: workAccessHostedEvaluationAuthorizer(input.attempts),
    activation: {
      commit: (request) => commitActivation(request, { authority, storage, receipts }),
    },
    now,
    newCorrelationId: randomUUID,
  };
}
