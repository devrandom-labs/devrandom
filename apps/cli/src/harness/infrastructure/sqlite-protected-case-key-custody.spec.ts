import { chmodSync, lstatSync, mkdtempSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import {
  SqliteProtectedCaseKeyCustody,
  type ProtectedCaseKeyBinding,
} from './sqlite-protected-case-key-custody.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const binding: ProtectedCaseKeyBinding = {
  ownerAid: said('o'),
  evaluationId: '11111111-1111-4111-8111-111111111111',
  personalAgentAid: said('a'),
  taskId: '22222222-2222-4222-8222-222222222222',
  taskMandateSaid: said('m'),
};
const caseScope = {
  evaluationId: binding.evaluationId,
  objectSaid: said('h'),
  purpose: 'TrialHoldout' as const,
  segment: 0,
};

function privateRoot(): string {
  return mkdtempSync(join(tmpdir(), 'devrandom-evaluation-key-'));
}

describe('SQLite parent-only Evaluation key and nonce custody', () => {
  it('reopens the same key after restart and durably reserves a new nonce before each seal', async () => {
    const stateRoot = privateRoot();
    const created = SqliteProtectedCaseKeyCustody.create(stateRoot, binding);
    expect(created.kind).toBe('Created');
    if (created.kind !== 'Created') return;
    const first = await created.custody.seal({
      ...caseScope,
      plaintext: Buffer.from('protected legacy oracle'),
    });
    expect(first.kind).toBe('Sealed');
    if (first.kind !== 'Sealed') return;
    created.custody.close();

    const reopened = SqliteProtectedCaseKeyCustody.reopen(stateRoot, binding);
    expect(reopened.kind).toBe('Opened');
    if (reopened.kind !== 'Opened') return;
    await expect(
      reopened.custody.open({ artifact: first.artifact, ...caseScope }),
    ).resolves.toEqual({
      kind: 'Opened',
      plaintext: new Uint8Array(Buffer.from('protected legacy oracle')),
    });
    const second = await reopened.custody.seal({
      ...caseScope,
      plaintext: Buffer.from('second protected oracle'),
    });
    expect(second.kind).toBe('Sealed');
    if (second.kind !== 'Sealed') return;
    expect(second.artifact.nonce).not.toBe(first.artifact.nonce);
    reopened.custody.close();

    const path = join(stateRoot, 'evaluations', binding.evaluationId, 'protected-cases.sqlite');
    expect(lstatSync(join(stateRoot, 'evaluations')).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(stateRoot, 'evaluations', binding.evaluationId)).mode & 0o777).toBe(
      0o700,
    );
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const database = new DatabaseSync(path, { readOnly: true });
    expect(database.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(database.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    expect(database.prepare('SELECT length(key_bytes) AS length FROM key_state').get()).toEqual({
      length: 32,
    });
    expect(database.prepare('SELECT next_nonce FROM key_state').get()).toEqual({ next_nonce: 2 });
    database.close();
  });

  it('never creates a replacement key on reopen and rejects wrong owner, agent, Task, or mandate', () => {
    const stateRoot = privateRoot();
    expect(SqliteProtectedCaseKeyCustody.reopen(stateRoot, binding)).toEqual({ kind: 'Missing' });
    const created = SqliteProtectedCaseKeyCustody.create(stateRoot, binding);
    expect(created.kind).toBe('Created');
    if (created.kind !== 'Created') return;
    created.custody.close();
    expect(SqliteProtectedCaseKeyCustody.create(stateRoot, binding)).toEqual({
      kind: 'AlreadyExists',
    });
    for (const changed of [
      { ownerAid: said('p') },
      { personalAgentAid: said('b') },
      { taskId: '33333333-3333-4333-8333-333333333333' },
      { taskMandateSaid: said('n') },
    ]) {
      expect(SqliteProtectedCaseKeyCustody.reopen(stateRoot, { ...binding, ...changed })).toEqual({
        kind: 'BindingMismatch',
      });
    }
    expect(
      SqliteProtectedCaseKeyCustody.reopen(stateRoot, {
        ...binding,
        evaluationId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toEqual({ kind: 'Missing' });
  });

  it('serializes reservations across two parent handles and refuses use after close', async () => {
    const stateRoot = privateRoot();
    const created = SqliteProtectedCaseKeyCustody.create(stateRoot, binding);
    if (created.kind !== 'Created') throw new Error('creation failed');
    const reopened = SqliteProtectedCaseKeyCustody.reopen(stateRoot, binding);
    if (reopened.kind !== 'Opened') throw new Error('reopen failed');
    const [first, second] = await Promise.all([
      created.custody.seal({ ...caseScope, plaintext: Buffer.from('first') }),
      reopened.custody.seal({ ...caseScope, plaintext: Buffer.from('second') }),
    ]);
    expect(first.kind).toBe('Sealed');
    expect(second.kind).toBe('Sealed');
    if (first.kind !== 'Sealed' || second.kind !== 'Sealed') return;
    expect(first.artifact.nonce).not.toBe(second.artifact.nonce);
    created.custody.close();
    await expect(created.custody.open({ artifact: first.artifact, ...caseScope })).resolves.toEqual(
      { kind: 'KeyUnavailable' },
    );
    await expect(
      created.custody.seal({ ...caseScope, plaintext: Buffer.from('after-close') }),
    ).resolves.toEqual({ kind: 'Unavailable' });
    reopened.custody.close();
  });

  it('refuses a live counter rollback before a nonce can be reused', async () => {
    const stateRoot = privateRoot();
    const created = SqliteProtectedCaseKeyCustody.create(stateRoot, binding);
    if (created.kind !== 'Created') throw new Error('creation failed');
    const first = await created.custody.seal({
      ...caseScope,
      plaintext: Buffer.from('first'),
    });
    expect(first.kind).toBe('Sealed');
    const path = join(stateRoot, 'evaluations', binding.evaluationId, 'protected-cases.sqlite');
    const database = new DatabaseSync(path);
    database.exec('UPDATE key_state SET next_nonce=0');
    database.close();
    const second = await created.custody.seal({
      ...caseScope,
      plaintext: Buffer.from('second'),
    });
    expect(second).toEqual({ kind: 'Unavailable' });
    created.custody.close();
  });

  it('refuses a changed nonce prefix under an already opened key', async () => {
    const stateRoot = privateRoot();
    const created = SqliteProtectedCaseKeyCustody.create(stateRoot, binding);
    if (created.kind !== 'Created') throw new Error('creation failed');
    const path = join(stateRoot, 'evaluations', binding.evaluationId, 'protected-cases.sqlite');
    const database = new DatabaseSync(path);
    const row = database.prepare('SELECT nonce_prefix FROM key_state').get();
    if (!(row?.nonce_prefix instanceof Uint8Array)) throw new Error('prefix missing');
    const changedPrefix = Buffer.from(row.nonce_prefix);
    changedPrefix[0] = (changedPrefix[0] ?? 0) ^ 0xff;
    database.prepare('UPDATE key_state SET nonce_prefix = ?').run(changedPrefix);
    database.close();
    await expect(
      created.custody.seal({ ...caseScope, plaintext: Buffer.from('no reuse') }),
    ).resolves.toEqual({ kind: 'Unavailable' });
    created.custody.close();
  });

  it('refuses public or redirected state directories before writing a key', () => {
    const stateRoot = privateRoot();
    chmodSync(stateRoot, 0o755);
    expect(SqliteProtectedCaseKeyCustody.create(stateRoot, binding)).toEqual({
      kind: 'UnsafePath',
    });
    const fileRoot = privateRoot();
    const created = SqliteProtectedCaseKeyCustody.create(fileRoot, binding);
    if (created.kind !== 'Created') throw new Error('creation failed');
    created.custody.close();
    const path = join(fileRoot, 'evaluations', binding.evaluationId, 'protected-cases.sqlite');
    unlinkSync(path);
    symlinkSync(join(fileRoot, 'redirected.sqlite'), path);
    expect(SqliteProtectedCaseKeyCustody.create(fileRoot, binding)).toEqual({
      kind: 'UnsafePath',
    });
    expect(SqliteProtectedCaseKeyCustody.reopen(fileRoot, binding)).toEqual({
      kind: 'UnsafePath',
    });
    chmodSync(stateRoot, 0o700);
    const redirected = privateRoot();
    symlinkSync(redirected, join(stateRoot, 'evaluations'));
    expect(SqliteProtectedCaseKeyCustody.create(stateRoot, binding)).toEqual({
      kind: 'UnsafePath',
    });
  });
});
