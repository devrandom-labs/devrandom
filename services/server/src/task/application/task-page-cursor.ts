import type { TaskPagePosition } from './tasks.js';

export type TaskCursorDecoding =
  | { readonly kind: 'CursorAccepted'; readonly position: TaskPagePosition }
  | { readonly kind: 'CursorRejected' };

export interface TaskPageCursor {
  encode(input: {
    readonly ownerAid: string;
    readonly limit: number;
    readonly position: TaskPagePosition;
  }): string;
  decode(input: {
    readonly ownerAid: string;
    readonly limit: number;
    readonly cursor: string;
  }): TaskCursorDecoding;
}
