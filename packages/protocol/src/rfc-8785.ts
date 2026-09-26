import { createHash } from 'node:crypto';

function compareCodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('RFC 8785 cannot encode a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort(compareCodeUnits);
    return `{${keys
      .map((key) => {
        const member: unknown = Reflect.get(value, key);
        return `${JSON.stringify(key)}:${canonicalJson(member)}`;
      })
      .join(',')}}`;
  }
  throw new TypeError('RFC 8785 received a non-JSON value');
}

export function rfc8785Sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
