import { describe, expect, it } from 'vitest';

import { ProtectedCredentials } from './credential-disclosure.js';

describe('credential disclosure policy', () => {
  it('withholds a Unicode credential after malformed bytes with one-byte chunks', () => {
    const credential = 'synthetic-🔑-command-key';
    const policy = new ProtectedCredentials([credential]);
    const safe = new Uint8Array([0xff, 0xfe, ...new TextEncoder().encode('ordinary output\n')]);
    const bytes = new Uint8Array([...safe, ...new TextEncoder().encode(credential)]);
    let pending = new Uint8Array();
    const recorded: number[] = [];
    let disposition: 'Inspecting' | 'Withheld' = 'Inspecting';
    for (const byte of bytes) {
      pending = new Uint8Array([...pending, byte]);
      const inspection = policy.inspectPrefix(pending);
      if (inspection.kind === 'WithheldSecret') {
        disposition = 'Withheld';
        break;
      }
      recorded.push(...pending.slice(0, inspection.byteLength));
      pending = pending.slice(inspection.byteLength);
    }
    expect(disposition).toBe('Withheld');
    expect(new Uint8Array(recorded)).toEqual(safe.slice(0, recorded.length));
  });

  it.each(['fooAuthorization: public', 'fooCONCENTRATE_API_KEY=public'])(
    'preserves lexical context when streaming %s',
    (content) => {
      const policy = new ProtectedCredentials();
      let pending = new Uint8Array();
      const recorded: number[] = [];
      for (const byte of new TextEncoder().encode(content)) {
        pending = new Uint8Array([...pending, byte]);
        const inspection = policy.inspectPrefix(pending);
        expect(inspection.kind).toBe('RecordablePrefix');
        if (inspection.kind !== 'RecordablePrefix') throw new Error('public output was withheld');
        recorded.push(...pending.slice(0, inspection.byteLength));
        pending = pending.slice(inspection.byteLength);
      }
      expect(policy.inspect(pending)).toEqual({ kind: 'Recordable' });
      recorded.push(...pending);
      expect(new TextDecoder().decode(new Uint8Array(recorded))).toBe(content);
    },
  );

  it('streams a large ordinary uppercase word without retaining the completed word', () => {
    const bytes = new TextEncoder().encode(`${'A'.repeat(64 * 1_024)}z`);
    const inspection = new ProtectedCredentials().inspectPrefix(bytes);
    expect(inspection.kind).toBe('RecordablePrefix');
    if (inspection.kind !== 'RecordablePrefix') throw new Error('ordinary word was withheld');
    expect(inspection.byteLength).toBeGreaterThan(bytes.byteLength - 64);
  });

  it.each([
    'synthetic-command-key-13579',
    'synthetic-🔑-command-key',
    'Authorization: Bearer synthetic-value',
    'Proxy-Authorization  = synthetic-value',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'CONCENTRATE_API_KEY   =   synthetic-value',
    'CONCENTRATE_API_KEY\u2003=\u2003synthetic-value',
  ])('withholds %s independently of byte chunk boundaries', (secret) => {
    const policy = new ProtectedCredentials([
      'synthetic-command-key-13579',
      'synthetic-🔑-command-key',
    ]);
    const safe = new TextEncoder().encode('ordinary output\n');
    const bytes = new TextEncoder().encode(`ordinary output\n${secret}`);
    for (let split = 1; split < bytes.byteLength; split += 1) {
      let pending = new Uint8Array();
      const released: number[] = [];
      let disposition: 'Inspecting' | 'Withheld' = 'Inspecting';
      for (const chunk of [bytes.slice(0, split), bytes.slice(split)]) {
        pending = new Uint8Array([...pending, ...chunk]);
        const inspection = policy.inspectPrefix(pending);
        if (inspection.kind === 'WithheldSecret') {
          disposition = 'Withheld';
          break;
        }
        released.push(...pending.slice(0, inspection.byteLength));
        pending = pending.slice(inspection.byteLength);
      }
      expect(disposition).toBe('Withheld');
      expect(new Uint8Array(released)).toEqual(safe.slice(0, released.length));
    }
  });

  it('recognizes protected values in raw and JSON-escaped content without exposing them', () => {
    const credential = 'synthetic-credential-"with\\escapes';
    const policy = new ProtectedCredentials([credential]);
    for (const content of [credential, JSON.stringify({ content: credential })]) {
      const bytes = new TextEncoder().encode(content);
      expect(policy.inspect(bytes)).toEqual({
        kind: 'WithheldSecret',
        reason: 'Credential',
        byteLength: bytes.byteLength,
      });
    }
    expect(JSON.stringify(policy)).toBe('{}');
  });

  it('recognizes a credential assignment after a JSON-escaped newline', () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({ content: 'output\nCONCENTRATE_API_KEY=synthetic-private-value' }),
    );
    expect(new ProtectedCredentials().inspect(bytes)).toEqual({
      kind: 'WithheldSecret',
      reason: 'EnvironmentSecret',
      byteLength: bytes.byteLength,
    });
  });

  it('does not classify a credential source name without a value as a disclosed credential', () => {
    expect(
      new ProtectedCredentials().inspect(
        new TextEncoder().encode(
          JSON.stringify({ credentialSource: 'CONCENTRATE_API_KEY', maximumOutputTokens: 2000 }),
        ),
      ),
    ).toEqual({ kind: 'Recordable' });
  });
});
