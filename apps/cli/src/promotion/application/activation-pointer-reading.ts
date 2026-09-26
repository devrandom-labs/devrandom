import type { ActiveHarnessPointer } from '@devrandom/protocol';

/** Owner-authorized hosted truth for the incumbent CAS precondition. */
export interface ActivationPointerReading {
  inspect(
    taskId: string,
  ): Promise<
    | { readonly kind: 'Observed'; readonly pointer: ActiveHarnessPointer }
    | { readonly kind: 'Missing' | 'Unavailable' }
  >;
}
