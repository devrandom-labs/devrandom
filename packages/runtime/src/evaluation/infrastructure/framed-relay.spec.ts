import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import { FramedRelay } from './framed-relay.js';

describe('evaluation worker framed relay', () => {
  it('accepts only ordered frames bound to the current evaluation slot', async () => {
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const relay = new FramedRelay(incoming, outgoing, 'evaluation/slot', 1024);
    const frame = JSON.stringify({
      binding: 'evaluation/slot',
      ordinal: 0,
      kind: 'ToolProposal',
      payload: { input: 'read_file' },
    });
    const next = relay.receive();
    incoming.write(`${String(Buffer.byteLength(frame))}:${frame}`);
    await expect(next).resolves.toMatchObject({
      binding: 'evaluation/slot',
      ordinal: 0,
      kind: 'ToolProposal',
    });
    const repeated = relay.receive();
    incoming.write(`${String(Buffer.byteLength(frame))}:${frame}`);
    await expect(repeated).rejects.toThrow(/ordinal/i);
  });

  it('rejects a cross-slot frame and a repeated ordinal', async () => {
    const incoming = new PassThrough();
    const outgoing = new PassThrough();
    const relay = new FramedRelay(incoming, outgoing, 'evaluation/slot', 1024);
    const wrong = JSON.stringify({
      binding: 'other/slot',
      ordinal: 0,
      kind: 'ToolProposal',
      payload: {},
    });
    const next = relay.receive();
    incoming.write(`${String(Buffer.byteLength(wrong))}:${wrong}`);
    await expect(next).rejects.toThrow(/binding/i);
  });

  it('serializes concurrent writes and bounds a peer that floods unread frames', async () => {
    const pipe = new PassThrough();
    const sender = new FramedRelay(new PassThrough(), pipe, 'evaluation/slot', 1024);
    const receiver = new FramedRelay(pipe, new PassThrough(), 'evaluation/slot', 1024);
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => sender.send('ToolProposal', { index })),
    );
    const frames = await Promise.all(Array.from({ length: 8 }, () => receiver.receive()));
    expect(frames.map((frame) => frame.ordinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    await Promise.all(
      Array.from({ length: 9 }, (_, index) => sender.send('ToolProposal', { index })),
    );
    await expect(receiver.receive()).rejects.toThrow(/queued frame limit/i);
  });
});
