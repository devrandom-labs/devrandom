import {
  decodeEvaluationSourceInventory,
  type EvaluationSourceInventory,
} from '@devrandom/protocol';

import { ServerEvidenceReading } from '../../context/infrastructure/server-evidence-reading.js';
import { ServerExperienceRetrieval } from '../../context/infrastructure/server-experience-retrieval.js';
import type {
  DevrandomFetch,
  DevrandomServerOrigin,
} from '../../infrastructure/devrandom-server-http.js';
import type { ScopedAnalogyConversations } from '../application/progress-qualified-h0.js';

/** CLI composition of typed hosted Context capabilities; no Atlas credential enters this process. */
export class HostedH0Context implements ScopedAnalogyConversations {
  readonly #origin: DevrandomServerOrigin;
  readonly #bearer: string;
  readonly #fetch: DevrandomFetch;

  constructor(origin: DevrandomServerOrigin, bearer: string, fetch: DevrandomFetch) {
    this.#origin = origin;
    this.#bearer = bearer;
    this.#fetch = fetch;
  }

  open(inventory: EvaluationSourceInventory): ReturnType<ScopedAnalogyConversations['open']> {
    if (decodeEvaluationSourceInventory(inventory).kind !== 'Accepted')
      throw new Error('H0 source inventory invalid');
    return {
      retrieval: new ServerExperienceRetrieval(this.#origin, this.#bearer, inventory, this.#fetch),
      reading: new ServerEvidenceReading(this.#origin, this.#bearer, inventory, this.#fetch),
    };
  }
}
