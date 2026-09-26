import {
  personalAgentAid,
  type IssuerActivationReceiptExchange,
  type IssuerAid,
} from '@devrandom/identity';

import type { IssuerActivationReceipts } from '../application/commit-activation.js';

/** Map application receipt custody to exact native issuer KERIA exchange evidence. */
export function issuerActivationReceipts(input: {
  readonly exchange: IssuerActivationReceiptExchange;
  readonly issuerAid: IssuerAid;
  readonly senderAlias: string;
}): IssuerActivationReceipts {
  return {
    async sign(request) {
      try {
        const inspected = await input.exchange.sign({
          senderAlias: input.senderAlias,
          sourceAid: input.issuerAid,
          recipientAid: personalAgentAid(request.recipientAid),
          payload: request.payload,
          preparedAt: request.preparedAt,
        });
        if (inspected.kind === 'Verified')
          return { kind: 'Signed', receiptSaid: inspected.exchangeSaid };
        return inspected.kind === 'Unavailable' || inspected.kind === 'Pending'
          ? { kind: 'Unavailable' }
          : { kind: 'Rejected' };
      } catch {
        return { kind: 'Rejected' };
      }
    },
    async inspect(request) {
      try {
        const inspected = await input.exchange.inspect({
          exchangeSaid: request.receiptSaid,
          sourceAid: input.issuerAid,
          recipientAid: personalAgentAid(request.recipientAid),
          payload: request.payload,
        });
        return inspected.kind === 'Verified'
          ? 'Verified'
          : inspected.kind === 'Rejected'
            ? 'Rejected'
            : 'Unavailable';
      } catch {
        return 'Rejected';
      }
    },
  };
}
