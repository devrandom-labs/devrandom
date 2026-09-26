import { readFile } from 'node:fs/promises';

import type { TaskDocument, TaskDocumentReading } from '../application/user-tasks.js';

export type TaskFileError =
  | { readonly kind: 'FileUnavailable' }
  | { readonly kind: 'FileTooLarge' }
  | { readonly kind: 'Utf8Invalid' }
  | { readonly kind: 'BomForbidden' }
  | { readonly kind: 'JsonInvalid' }
  | { readonly kind: 'DuplicateMember' };

export class TaskFileFailure extends Error {
  readonly detail: TaskFileError;

  constructor(detail: TaskFileError, cause?: unknown) {
    super(detail.kind, cause === undefined ? undefined : { cause });
    this.name = 'TaskFileFailure';
    this.detail = detail;
  }
}

const maximumTaskFileBytes = 262_144;
const numberPrefix = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u;

interface ScannedString {
  readonly next: number;
  readonly value: string;
}

export class JsonTaskFile implements TaskDocument {
  async read(path: string): Promise<TaskDocumentReading> {
    try {
      const bytes = await readFile(path);
      return { kind: 'Read', document: decodeTaskFileBytes(bytes) };
    } catch (cause) {
      if (cause instanceof TaskFileFailure) {
        return { kind: 'Rejected', reason: cause.detail.kind };
      }
      return { kind: 'Rejected', reason: 'FileUnavailable' };
    }
  }
}

export function decodeTaskFileBytes(input: Uint8Array): unknown {
  if (input.byteLength > maximumTaskFileBytes) {
    throw new TaskFileFailure({ kind: 'FileTooLarge' });
  }
  if (input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    throw new TaskFileFailure({ kind: 'BomForbidden' });
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch (cause) {
    throw new TaskFileFailure({ kind: 'Utf8Invalid' }, cause);
  }
  try {
    const end = skipWhitespace(source, scanValue(source, skipWhitespace(source, 0)));
    if (end !== source.length) {
      invalidJson();
    }
    const decoded: unknown = JSON.parse(source);
    return decoded;
  } catch (cause) {
    if (cause instanceof TaskFileFailure) {
      throw cause;
    }
    throw new TaskFileFailure({ kind: 'JsonInvalid' }, cause);
  }
}

function scanValue(source: string, index: number): number {
  const token = source[index];
  switch (token) {
    case '{':
      return scanObject(source, index);
    case '[':
      return scanArray(source, index);
    case '"':
      return scanString(source, index).next;
    case 't':
      return exactToken(source, index, 'true');
    case 'f':
      return exactToken(source, index, 'false');
    case 'n':
      return exactToken(source, index, 'null');
    case undefined:
      return invalidJson();
    default:
      return scanNumber(source, index);
  }
}

function scanObject(source: string, start: number): number {
  const names = new Set<string>();
  let index = skipWhitespace(source, start + 1);
  if (source[index] === '}') {
    return index + 1;
  }
  while (index < source.length) {
    if (source[index] !== '"') {
      invalidJson();
    }
    const name = scanString(source, index);
    if (names.has(name.value)) {
      throw new TaskFileFailure({ kind: 'DuplicateMember' });
    }
    names.add(name.value);
    index = skipWhitespace(source, name.next);
    if (source[index] !== ':') {
      invalidJson();
    }
    index = skipWhitespace(source, scanValue(source, skipWhitespace(source, index + 1)));
    if (source[index] === '}') {
      return index + 1;
    }
    if (source[index] !== ',') {
      invalidJson();
    }
    index = skipWhitespace(source, index + 1);
  }
  return invalidJson();
}

function scanArray(source: string, start: number): number {
  let index = skipWhitespace(source, start + 1);
  if (source[index] === ']') {
    return index + 1;
  }
  while (index < source.length) {
    index = skipWhitespace(source, scanValue(source, index));
    if (source[index] === ']') {
      return index + 1;
    }
    if (source[index] !== ',') {
      invalidJson();
    }
    index = skipWhitespace(source, index + 1);
  }
  return invalidJson();
}

function scanString(source: string, start: number): ScannedString {
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '"') {
      const literal = source.slice(start, index + 1);
      const decoded: unknown = JSON.parse(literal);
      if (typeof decoded !== 'string') {
        return invalidJson();
      }
      return { next: index + 1, value: decoded };
    }
    if (character === undefined || character.charCodeAt(0) < 0x20) {
      return invalidJson();
    }
    if (character !== '\\') {
      index += 1;
      continue;
    }
    const escaped = source[index + 1];
    if (escaped === 'u') {
      if (!/^[0-9a-fA-F]{4}$/u.test(source.slice(index + 2, index + 6))) {
        return invalidJson();
      }
      index += 6;
      continue;
    }
    if (
      escaped !== '"' &&
      escaped !== '\\' &&
      escaped !== '/' &&
      escaped !== 'b' &&
      escaped !== 'f' &&
      escaped !== 'n' &&
      escaped !== 'r' &&
      escaped !== 't'
    ) {
      return invalidJson();
    }
    index += 2;
  }
  return invalidJson();
}

function scanNumber(source: string, index: number): number {
  const match = numberPrefix.exec(source.slice(index));
  const token = match?.[0];
  if (token === undefined || !Number.isFinite(Number(token))) {
    return invalidJson();
  }
  return index + token.length;
}

function exactToken(source: string, index: number, token: 'true' | 'false' | 'null'): number {
  if (source.slice(index, index + token.length) !== token) {
    return invalidJson();
  }
  return index + token.length;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (
    source[index] === ' ' ||
    source[index] === '\t' ||
    source[index] === '\n' ||
    source[index] === '\r'
  ) {
    index += 1;
  }
  return index;
}

function invalidJson(): never {
  throw new TaskFileFailure({ kind: 'JsonInvalid' });
}
