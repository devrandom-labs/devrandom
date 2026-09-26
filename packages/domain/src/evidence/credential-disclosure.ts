export type CredentialDisclosure =
  | { readonly kind: 'Recordable' }
  | {
      readonly kind: 'WithheldSecret';
      readonly reason: 'Credential' | 'AuthorizationHeader' | 'PrivateKey' | 'EnvironmentSecret';
      readonly byteLength: number;
    };

const privateKeyMarkers = ['', 'RSA ', 'EC ', 'DSA ', 'OPENSSH ', 'ENCRYPTED '].map(
  (algorithm) => `-----BEGIN ${algorithm}PRIVATE KEY-----`,
);

/** Length of the trailing proper literal prefix, using linear-time prefix matching. */
function trailingPrefixLength(content: string, literal: string): number {
  if (literal.length === 0) return 0;
  const borders: number[] = Array<number>(literal.length).fill(0);
  let matched = 0;
  for (let index = 1; index < literal.length; index += 1) {
    while (matched > 0 && literal.charAt(index) !== literal.charAt(matched)) {
      matched = borders[matched - 1] ?? 0;
    }
    if (literal.charAt(index) === literal.charAt(matched)) matched += 1;
    borders[index] = matched;
  }
  matched = 0;
  for (let index = 0; index < content.length; index += 1) {
    while (matched > 0 && content.charAt(index) !== literal.charAt(matched)) {
      matched = borders[matched - 1] ?? 0;
    }
    if (content.charAt(index) === literal.charAt(matched)) matched += 1;
    if (matched === literal.length) matched = borders[matched - 1] ?? 0;
  }
  return matched;
}

function completeUtf8PrefixLength(bytes: Uint8Array): number {
  let start = bytes.byteLength - 1;
  while (start >= 0 && start >= bytes.byteLength - 3) {
    const byte = bytes[start] ?? 0;
    if (byte < 0x80 || byte > 0xbf) break;
    start -= 1;
  }
  const leading = bytes[start] ?? 0;
  const width =
    leading >= 0xc2 && leading <= 0xdf
      ? 2
      : leading >= 0xe0 && leading <= 0xef
        ? 3
        : leading >= 0xf0 && leading <= 0xf4
          ? 4
          : 1;
  return start >= 0 && bytes.byteLength - start < width ? start : bytes.byteLength;
}

/** Known credential values remain private; inspection exposes only a withholding disposition. */
export class ProtectedCredentials {
  readonly #values: Set<string>;

  constructor(values: readonly string[] = []) {
    this.#values = new Set(values.filter((value) => value.length > 0));
  }

  protect(value: string): void {
    if (value.length > 0) this.#values.add(value);
  }

  /** Only release bytes that cannot become a protected value when more output arrives. */
  inspectPrefix(
    bytes: Uint8Array,
  ):
    | { readonly kind: 'RecordablePrefix'; readonly byteLength: number }
    | Extract<CredentialDisclosure, { readonly kind: 'WithheldSecret' }> {
    const disclosure = this.inspect(bytes);
    if (disclosure.kind === 'WithheldSecret') return disclosure;
    const completeBytes = bytes.subarray(0, completeUtf8PrefixLength(bytes));
    const content = new TextDecoder('utf-8', { ignoreBOM: true }).decode(completeBytes);
    // Keep context for boundary-sensitive recognizers and incomplete UTF-8 code points.
    let withheldFrom = content.length;
    for (const value of this.#values) {
      for (const literal of [value, JSON.stringify(value).slice(1, -1)]) {
        withheldFrom = Math.min(
          withheldFrom,
          content.length - trailingPrefixLength(content, literal),
        );
      }
    }
    for (const literal of privateKeyMarkers) {
      withheldFrom = Math.min(
        withheldFrom,
        content.length - trailingPrefixLength(content, literal),
      );
    }
    const lowerContent = content.toLowerCase();
    for (const literal of ['authorization', 'proxy-authorization']) {
      withheldFrom = Math.min(
        withheldFrom,
        content.length - trailingPrefixLength(lowerContent, literal),
      );
    }
    for (const continuation of [
      /(?:Proxy-)?Authorization["']?\s*$/iu,
      /(?:^|[^A-Z0-9_])[A-Z][A-Z0-9_]*(?:["']?\s*(?:[:=]\s*)?)?$/u,
    ]) {
      const match = continuation.exec(content);
      if (match !== null) withheldFrom = Math.min(withheldFrom, match.index);
    }
    withheldFrom = Math.max(0, withheldFrom - 2);
    const unit = content.charCodeAt(withheldFrom);
    if (unit >= 0xdc00 && unit <= 0xdfff) withheldFrom = Math.max(0, withheldFrom - 1);
    const encoder = new TextEncoder();
    // Replacement decoding can expand malformed UTF-8. Subtract all expansion so
    // an ambiguous byte prefix is retained conservatively, never released early.
    const expansion = Math.max(0, encoder.encode(content).byteLength - completeBytes.byteLength);
    return {
      kind: 'RecordablePrefix',
      byteLength: Math.max(
        0,
        encoder.encode(content.slice(0, withheldFrom)).byteLength - expansion,
      ),
    };
  }

  inspect(bytes: Uint8Array): CredentialDisclosure {
    const content = new TextDecoder().decode(bytes);
    const withheld = (
      reason: Extract<CredentialDisclosure, { kind: 'WithheldSecret' }>['reason'],
    ): CredentialDisclosure => ({ kind: 'WithheldSecret', reason, byteLength: bytes.byteLength });
    for (const value of this.#values) {
      if (content.includes(value) || content.includes(JSON.stringify(value).slice(1, -1))) {
        return withheld('Credential');
      }
    }
    if (/\b(?:Proxy-)?Authorization\b["']?\s*[:=]/iu.test(content)) {
      return withheld('AuthorizationHeader');
    }
    if (privateKeyMarkers.some((marker) => content.includes(marker))) {
      return withheld('PrivateKey');
    }
    if (
      /(?:^|[\s{"']|\\[nrt])(?:[A-Z][A-Z0-9_]*_(?:API_KEY|SECRET|TOKEN|PASSWORD)|API_KEY|PASSWORD|BRAN)["']?\s*[:=]\s*\S/u.test(
        content,
      )
    ) {
      return withheld('EnvironmentSecret');
    }
    return { kind: 'Recordable' };
  }
}
