import type { Readable, Writable } from 'node:stream';

export type EvaluationRelayKind =
  | 'Start'
  | 'Ready'
  | 'ModelRequest'
  | 'ModelResponse'
  | 'ToolProposal'
  | 'ToolOutcome'
  | 'ContextRead'
  | 'ContextResult'
  | 'Stopped'
  | 'Stop';

export interface EvaluationRelayFrame {
  readonly binding: string;
  readonly ordinal: number;
  readonly kind: EvaluationRelayKind;
  readonly payload: unknown;
}

const kinds: ReadonlySet<string> = new Set([
  'Start',
  'Ready',
  'ModelRequest',
  'ModelResponse',
  'ToolProposal',
  'ToolOutcome',
  'ContextRead',
  'ContextResult',
  'Stopped',
  'Stop',
]);

/** One bounded, connection-bound conversation. No frame can select a new endpoint or authority. */
export class FramedRelay {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #binding: string;
  readonly #maximumBytes: number;
  readonly #pending: EvaluationRelayFrame[] = [];
  readonly #waiting: {
    resolve(frame: EvaluationRelayFrame): void;
    reject(error: Error): void;
  }[] = [];
  #buffer = Buffer.alloc(0);
  #receiveOrdinal = 0;
  #sendOrdinal = 0;
  #sendTail: Promise<void> = Promise.resolve();
  #failed: Error | undefined;

  constructor(input: Readable, output: Writable, binding: string, maximumBytes: number) {
    if (binding.length === 0 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 64) {
      throw new Error('Invalid evaluation relay binding or frame limit.');
    }
    this.#input = input;
    this.#output = output;
    this.#binding = binding;
    this.#maximumBytes = maximumBytes;
    input.on('data', (chunk: Buffer | string) => {
      this.#append(chunk);
    });
    input.once('end', () => {
      this.#fail(new Error('Evaluation relay closed.'));
    });
    input.once('error', (cause: Error) => {
      this.#fail(cause);
    });
  }

  receive(): Promise<EvaluationRelayFrame> {
    if (this.#failed !== undefined) return Promise.reject(this.#failed);
    const next = this.#pending.shift();
    if (next !== undefined) return Promise.resolve(next);
    return new Promise((resolve, reject) => this.#waiting.push({ resolve, reject }));
  }

  async send(kind: EvaluationRelayKind, payload: unknown): Promise<void> {
    if (this.#failed !== undefined) throw this.#failed;
    if (!kinds.has(kind)) throw new Error('Unknown evaluation relay frame kind.');
    const encoded = Buffer.from(
      JSON.stringify({ binding: this.#binding, ordinal: this.#sendOrdinal, kind, payload }),
      'utf8',
    );
    if (encoded.length > this.#maximumBytes) throw new Error('Evaluation relay frame too large.');
    this.#sendOrdinal += 1;
    this.#sendTail = this.#sendTail.then(
      () =>
        new Promise<void>((resolve, reject) => {
          this.#output.write(`${String(encoded.length)}:`, (headerError?: Error | null) => {
            if (headerError) {
              reject(headerError);
              return;
            }
            this.#output.write(encoded, (bodyError?: Error | null) => {
              if (bodyError) reject(bodyError);
              else resolve();
            });
          });
        }),
    );
    await this.#sendTail;
  }

  #append(chunk: Buffer | string): void {
    if (this.#failed !== undefined) return;
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.#buffer.length + incoming.length > 9 * (this.#maximumBytes + 20)) {
      this.#fail(new Error('Evaluation relay frame too large.'));
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, incoming]);
    while (this.#buffer.length > 0) {
      const colon = this.#buffer.indexOf(58);
      if (colon < 0) {
        if (this.#buffer.length > 10) this.#fail(new Error('Invalid evaluation relay length.'));
        return;
      }
      const prefix = this.#buffer.subarray(0, colon).toString('ascii');
      if (!/^[1-9][0-9]{0,9}$/u.test(prefix)) {
        this.#fail(new Error('Invalid evaluation relay length.'));
        return;
      }
      const length = Number(prefix);
      if (length > this.#maximumBytes) {
        this.#fail(new Error('Evaluation relay frame too large.'));
        return;
      }
      if (this.#buffer.length < colon + 1 + length) return;
      const bytes = this.#buffer.subarray(colon + 1, colon + 1 + length);
      this.#buffer = this.#buffer.subarray(colon + 1 + length);
      let candidate: unknown;
      try {
        candidate = JSON.parse(bytes.toString('utf8'));
      } catch {
        this.#fail(new Error('Invalid evaluation relay JSON.'));
        return;
      }
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
        this.#fail(new Error('Invalid evaluation relay frame.'));
        return;
      }
      const frame = candidate as {
        readonly binding: unknown;
        readonly kind: unknown;
        readonly ordinal: unknown;
        readonly payload: unknown;
      };
      if (
        Object.keys(frame).sort().join(',') !== 'binding,kind,ordinal,payload' ||
        frame.binding !== this.#binding
      ) {
        this.#fail(new Error('Evaluation relay binding mismatch.'));
        return;
      }
      if (frame.ordinal !== this.#receiveOrdinal || !kinds.has(String(frame.kind))) {
        this.#fail(new Error('Evaluation relay ordinal or kind invalid.'));
        return;
      }
      this.#receiveOrdinal += 1;
      const accepted = frame as unknown as EvaluationRelayFrame;
      const waiter = this.#waiting.shift();
      if (waiter === undefined) {
        if (this.#pending.length >= 8) {
          this.#fail(new Error('Evaluation relay queued frame limit exceeded.'));
          return;
        }
        this.#pending.push(accepted);
      } else waiter.resolve(accepted);
    }
  }

  #fail(error: Error): void {
    if (this.#failed !== undefined) return;
    this.#failed = error;
    this.#pending.length = 0;
    for (const waiter of this.#waiting.splice(0)) waiter.reject(error);
    this.#input.pause();
  }
}
