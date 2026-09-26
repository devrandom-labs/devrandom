import { issuerAid, personalAgentAid, type IssuerEvidenceSealExchange } from '@devrandom/identity';

import type { EvidenceSealExchanges } from '../application/evidence-seals.js';

export function issuerEvidenceSealExchanges(
  exchange: IssuerEvidenceSealExchange,
): EvidenceSealExchanges {
  return {
    inspect(input) {
      return exchange.inspect({
        exchangeSaid: input.exchangeSaid,
        sourceAid: personalAgentAid(input.sourceAid),
        recipientAid: issuerAid(input.recipientAid),
        payload: input.payload,
      });
    },
  };
}
