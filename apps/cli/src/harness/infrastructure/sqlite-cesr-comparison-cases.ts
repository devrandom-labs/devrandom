import { randomBytes } from 'node:crypto';

import type { CesrManifestConversations } from '../application/lock-cesr-comparison-manifest.js';
import { SqliteProtectedCaseKeyCustody } from './sqlite-protected-case-key-custody.js';

type CesrCases = CesrManifestConversations['cases'];

/** Trusted parent adapter: exact per-Evaluation key and monotonic nonce custody. */
export class SqliteCesrComparisonCases implements CesrCases {
  readonly #stateRoot: string;

  constructor(stateRoot: string) {
    this.#stateRoot = stateRoot;
  }

  open(
    input: Parameters<CesrManifestConversations['cases']['open']>[0],
  ): ReturnType<CesrManifestConversations['cases']['open']> {
    const { mode, ...binding } = input;
    const opened =
      mode === 'Create'
        ? SqliteProtectedCaseKeyCustody.create(this.#stateRoot, binding)
        : SqliteProtectedCaseKeyCustody.reopen(this.#stateRoot, binding);
    if (opened.kind === 'Created' || opened.kind === 'Opened')
      return Promise.resolve({
        kind: 'Opened',
        custody: opened.custody,
        release: () => {
          opened.custody.close();
        },
      });
    if (opened.kind === 'AlreadyExists' || opened.kind === 'BindingMismatch')
      return Promise.resolve({ kind: 'Conflict' });
    if (opened.kind === 'Missing') return Promise.resolve({ kind: 'Missing' });
    return Promise.resolve({ kind: 'Unavailable' });
  }

  drawPayload(): Uint8Array {
    return randomBytes(32);
  }
}
