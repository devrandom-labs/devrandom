import {
  activationReceiptPayload,
  decodeActivationCommitCommand,
  type ActivationCommitCommand,
  type ActivationCommitReceipt,
  type ActivationReceiptPayload,
} from '@devrandom/protocol';

type Committed = Extract<ActivationCommitReceipt, { kind: 'Committed' | 'AlreadyCommitted' }>;

export interface ActivationCommitAuthority {
  verify(input: { readonly ownerAid: string; readonly command: ActivationCommitCommand }): Promise<
    | {
        readonly kind: 'Authorized';
        readonly personalAgentAid: string;
        readonly governorAid: string;
      }
    | {
        readonly kind: 'Rejected';
        readonly gate: 'Authority' | 'Evidence' | 'Mandate' | 'Selection' | 'Signature';
      }
    | { readonly kind: 'Unavailable' }
  >;
}

export interface ActivationCommitStorage {
  inspect(input: {
    readonly ownerAid: string;
    readonly command: ActivationCommitCommand;
  }): Promise<
    | { readonly kind: 'Absent' | 'Pending' }
    | { readonly kind: 'Committed'; readonly receipt: Committed; readonly recipientAid: string }
    | { readonly kind: 'Conflict' }
    | { readonly kind: 'Unavailable' }
  >;
  reserve(input: {
    readonly ownerAid: string;
    readonly command: ActivationCommitCommand;
    readonly recipientAid: string;
  }): Promise<
    | { readonly kind: 'Reserved'; readonly preparedAt: number }
    | { readonly kind: 'Committed'; readonly receipt: Committed; readonly recipientAid: string }
    | { readonly kind: 'Conflict' }
    | { readonly kind: 'Unavailable' }
  >;
  finalize(input: {
    readonly ownerAid: string;
    readonly command: ActivationCommitCommand;
    readonly recipientAid: string;
    readonly receiptSaid: string;
  }): Promise<
    | { readonly kind: 'Committed'; readonly receipt: Committed }
    | { readonly kind: 'Conflict' }
    | { readonly kind: 'Unavailable' }
  >;
}

/** Issuer native KERIA signing and exact read-back; never accept a local SAID alone. */
export interface IssuerActivationReceipts {
  sign(input: {
    readonly command: ActivationCommitCommand;
    readonly recipientAid: string;
    readonly preparedAt: number;
    readonly payload: ActivationReceiptPayload;
  }): Promise<
    | { readonly kind: 'Signed'; readonly receiptSaid: string }
    | { readonly kind: 'Rejected' }
    | { readonly kind: 'Unavailable' }
  >;
  inspect(input: {
    readonly command: ActivationCommitCommand;
    readonly recipientAid: string;
    readonly receiptSaid: string;
    readonly payload: ActivationReceiptPayload;
  }): Promise<'Verified' | 'Rejected' | 'Unavailable'>;
}

export async function commitActivation(
  input: { readonly ownerAid: string; readonly command: ActivationCommitCommand },
  dependencies: {
    readonly authority: ActivationCommitAuthority;
    readonly storage: ActivationCommitStorage;
    readonly receipts: IssuerActivationReceipts;
  },
): Promise<ActivationCommitReceipt> {
  const { command } = input;
  if (
    decodeActivationCommitCommand(command).kind !== 'Accepted' ||
    command.expectedPointerVersion >= Number.MAX_SAFE_INTEGER
  )
    return { kind: 'Rejected', gate: 'Selection' };
  const payload = activationReceiptPayload(command);
  const inspected = await dependencies.storage.inspect(input);
  if (inspected.kind === 'Conflict' || inspected.kind === 'Unavailable')
    return { kind: inspected.kind };
  if (inspected.kind === 'Committed') {
    const verified = await dependencies.receipts.inspect({
      command,
      recipientAid: inspected.recipientAid,
      receiptSaid: inspected.receipt.decisionReceiptSaid,
      payload,
    });
    return verified === 'Verified'
      ? { ...inspected.receipt, kind: 'AlreadyCommitted' }
      : verified === 'Rejected'
        ? { kind: 'Rejected', gate: 'Signature' }
        : { kind: 'Unavailable' };
  }
  const authority = await dependencies.authority.verify(input);
  if (authority.kind === 'Rejected') return authority;
  if (authority.kind === 'Unavailable') return { kind: 'Unavailable' };
  const reserved = await dependencies.storage.reserve({
    ...input,
    recipientAid: authority.personalAgentAid,
  });
  if (reserved.kind === 'Conflict' || reserved.kind === 'Unavailable')
    return { kind: reserved.kind };
  if (reserved.kind === 'Committed') {
    const verified = await dependencies.receipts.inspect({
      command,
      recipientAid: reserved.recipientAid,
      receiptSaid: reserved.receipt.decisionReceiptSaid,
      payload,
    });
    return verified === 'Verified'
      ? { ...reserved.receipt, kind: 'AlreadyCommitted' }
      : verified === 'Rejected'
        ? { kind: 'Rejected', gate: 'Signature' }
        : { kind: 'Unavailable' };
  }
  const signed = await dependencies.receipts.sign({
    command,
    recipientAid: authority.personalAgentAid,
    preparedAt: reserved.preparedAt,
    payload,
  });
  if (signed.kind === 'Rejected') return { kind: 'Rejected', gate: 'Signature' };
  if (signed.kind === 'Unavailable') return { kind: 'Unavailable' };
  const verified = await dependencies.receipts.inspect({
    command,
    recipientAid: authority.personalAgentAid,
    receiptSaid: signed.receiptSaid,
    payload,
  });
  if (verified !== 'Verified')
    return verified === 'Rejected'
      ? { kind: 'Rejected', gate: 'Signature' }
      : { kind: 'Unavailable' };
  const finalized = await dependencies.storage.finalize({
    ...input,
    recipientAid: authority.personalAgentAid,
    receiptSaid: signed.receiptSaid,
  });
  return finalized.kind === 'Committed' ? finalized.receipt : { kind: finalized.kind };
}
