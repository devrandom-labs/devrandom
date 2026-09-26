import {
  activationReceiptPayload,
  decodeActivationCommitCommand,
  type ActivationCommitCommand,
  type ActiveHarnessPointer,
} from '@devrandom/protocol';

import type { IssuerActivationReceipts } from './commit-activation.js';

export interface CurrentActivationSource {
  inspectCurrent(input: { readonly ownerAid: string; readonly taskId: string }): Promise<
    | {
        readonly kind: 'Initial';
        readonly pointer: Extract<ActiveHarnessPointer, { kind: 'Initial' }>;
      }
    | {
        readonly kind: 'Committed';
        readonly pointer: Extract<ActiveHarnessPointer, { kind: 'Committed' }>;
        readonly command: ActivationCommitCommand;
        readonly recipientAid: string;
      }
    | { readonly kind: 'Absent' | 'Conflict' | 'Unavailable' }
  >;
}

/** Read the current owner-bound pointer only after committed issuer receipt verification. */
export async function readCurrentActivation(
  input: { readonly ownerAid: string; readonly taskId: string },
  dependencies: {
    readonly source: CurrentActivationSource;
    readonly receipts: IssuerActivationReceipts;
  },
): Promise<
  | { readonly kind: 'Read'; readonly pointer: ActiveHarnessPointer }
  | { readonly kind: 'Absent' | 'Conflict' | 'Unavailable' }
> {
  const observed = await dependencies.source.inspectCurrent(input);
  if (observed.kind === 'Initial')
    return observed.pointer.taskId === input.taskId
      ? { kind: 'Read', pointer: observed.pointer }
      : { kind: 'Conflict' };
  if (observed.kind !== 'Committed') return observed;
  const { command, pointer } = observed;
  if (
    decodeActivationCommitCommand(command).kind !== 'Accepted' ||
    pointer.taskId !== input.taskId ||
    command.taskId !== input.taskId ||
    command.taskRevisionSaid !== pointer.taskRevisionSaid ||
    command.harnessLineageId !== pointer.harnessLineageId ||
    command.commandId !== pointer.commandId ||
    command.expectedPointerVersion + 1 !== pointer.pointerVersion ||
    (command.disposition.kind === 'Activate' &&
      (pointer.disposition !== 'Activated' ||
        pointer.activeRevisionSaid !== command.disposition.candidateRevisionSaid)) ||
    (command.disposition.kind === 'RetainIncumbent' &&
      (pointer.disposition !== 'Retained' ||
        pointer.activeRevisionSaid !== command.expectedIncumbentRevisionSaid))
  )
    return { kind: 'Conflict' };
  const verified = await dependencies.receipts.inspect({
    command,
    recipientAid: observed.recipientAid,
    receiptSaid: pointer.decisionReceiptSaid,
    payload: activationReceiptPayload(command),
  });
  return verified === 'Verified'
    ? { kind: 'Read', pointer }
    : { kind: verified === 'Rejected' ? 'Conflict' : 'Unavailable' };
}
