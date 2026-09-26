declare const devrandomServerOriginBrand: unique symbol;

export type DevrandomServerOrigin = string & {
  readonly [devrandomServerOriginBrand]: 'DevrandomServerOrigin';
};

export type DevrandomFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type DevrandomServerOriginDecoding =
  | { readonly kind: 'Accepted'; readonly origin: DevrandomServerOrigin }
  | { readonly kind: 'Rejected' };

export function decodeDevrandomServerOrigin(source: string): DevrandomServerOriginDecoding {
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return { kind: 'Rejected' };
  }
  const loopback =
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '::1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname === 'localhost';
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== '/' ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return { kind: 'Rejected' };
  }
  return { kind: 'Accepted', origin: parsed.origin as DevrandomServerOrigin };
}
