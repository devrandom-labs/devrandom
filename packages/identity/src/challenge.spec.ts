import { Saider } from 'signify-ts';
import { describe, expect, it, vi } from 'vitest';

import {
  signifyAsynchronousIssuerChallengeProof,
  verifyChallengeResponseEvidence,
} from './challenge.js';
import { challengeResponseSaid, issuerAid, userAid } from './keri-identifier.js';

const issuer = issuerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const user = userAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const anotherUser = userAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs');
const expectedResponseSaid = challengeResponseSaid(issuer);
const words = ['alpha', 'bravo', 'charlie'];

function challengeExchange(challengeWords: readonly string[] = words) {
  const exchange = {
    v: 'KERI10JSON000000_',
    t: 'exn',
    d: '',
    i: user,
    rp: issuer,
    p: '',
    dt: '2026-09-24T16:00:00.000000+00:00',
    r: '/challenge/response',
    q: {},
    a: { i: issuer, words: [...challengeWords] },
    e: {},
  };
  const untrusted: unknown = Saider.saidify(exchange)[1];
  if (
    typeof untrusted !== 'object' ||
    untrusted === null ||
    !('d' in untrusted) ||
    typeof untrusted.d !== 'string' ||
    !('v' in untrusted) ||
    typeof untrusted.v !== 'string'
  ) {
    throw new Error('challenge exchange SAID was not produced');
  }
  return { ...exchange, d: untrusted.d, v: untrusted.v };
}

const workAccessWords = Array.from({ length: 24 }, (_value, index) => `word-${String(index)}`);

function challengeClient(input?: {
  readonly generated?: unknown;
  readonly started?: unknown;
  readonly observed?: unknown;
  readonly observationFailure?: Error;
}) {
  const generate = vi.fn<(strength?: number) => Promise<unknown>>(() =>
    Promise.resolve(input?.generated === undefined ? { words: workAccessWords } : input.generated),
  );
  const verify = vi.fn<(source: string, verificationWords: string[]) => Promise<unknown>>(() =>
    Promise.resolve(
      input?.started === undefined
        ? {
            name: 'challenge-verification.operation',
            done: false,
            metadata: { words: workAccessWords },
          }
        : input.started,
    ),
  );
  const responded = vi.fn<(source: string, said: string) => Promise<{ readonly ok: true }>>(() =>
    Promise.resolve({ ok: true }),
  );
  const get = vi.fn<(name: string) => Promise<unknown>>(() => {
    if (input?.observationFailure !== undefined) {
      return Promise.reject(input.observationFailure);
    }
    return Promise.resolve(input?.observed);
  });
  const remove = vi.fn<(name: string) => Promise<unknown>>(() => Promise.resolve({ ok: true }));
  return {
    client: {
      challenges: () => ({ generate, verify, responded }),
      operations: () => ({ get, delete: remove }),
    },
    generate,
    verify,
    responded,
    get,
    remove,
  };
}

describe('Signify challenge response evidence', () => {
  it('accepts the exact source, recipient, challenge, route, and response SAID', () => {
    const exchange = challengeExchange();

    expect(
      verifyChallengeResponseEvidence(exchange, {
        sourceAid: user,
        recipientAid: issuer,
        challengeWords: words,
        responseSaid: exchange.d,
      }),
    ).toEqual({ responseSaid: exchange.d });
  });

  it.each([
    ['source AID', { sourceAid: anotherUser }],
    ['issuer recipient', { recipientAid: issuerAid(anotherUser) }],
    ['challenge words', { challengeWords: ['different', 'challenge', 'words'] }],
    ['response SAID', { responseSaid: issuer }],
  ])('rejects a mismatched %s', (_label, mismatch) => {
    const exchange = challengeExchange();

    expect(() =>
      verifyChallengeResponseEvidence(exchange, {
        sourceAid: user,
        recipientAid: issuer,
        challengeWords: words,
        responseSaid: exchange.d,
        ...mismatch,
      }),
    ).toThrow('challenge response');
  });

  it('rejects a different exchange route even when every other value matches', () => {
    const exchange = { ...challengeExchange(), r: '/ipex/grant' };

    expect(() =>
      verifyChallengeResponseEvidence(exchange, {
        sourceAid: user,
        recipientAid: issuer,
        challengeWords: words,
        responseSaid: exchange.d,
      }),
    ).toThrow('challenge response route');
  });

  it('rejects a payload recipient different from the Devrandom issuer', () => {
    const valid = challengeExchange();
    const exchange = { ...valid, a: { ...valid.a, i: anotherUser } };

    expect(() =>
      verifyChallengeResponseEvidence(exchange, {
        sourceAid: user,
        recipientAid: issuer,
        challengeWords: words,
        responseSaid: valid.d,
      }),
    ).toThrow('challenge response payload recipient');
  });

  it('rejects a response whose content no longer matches its SAID', () => {
    const valid = challengeExchange();
    const exchange = {
      ...valid,
      a: { ...valid.a, words: ['tampered', 'bravo', 'charlie'] },
    };

    expect(() =>
      verifyChallengeResponseEvidence(exchange, {
        sourceAid: user,
        recipientAid: issuer,
        challengeWords: exchange.a.words,
        responseSaid: valid.d,
      }),
    ).toThrow('challenge response is not bound by its SAID');
  });
});

describe('asynchronous issuer challenge proof', () => {
  it('requests the pinned 256-bit challenge and accepts exactly 24 words', async () => {
    const client = challengeClient();
    const proof = signifyAsynchronousIssuerChallengeProof(client.client, issuer);

    await expect(proof.createChallenge()).resolves.toEqual(workAccessWords);
    expect(client.generate).toHaveBeenCalledExactlyOnceWith(256);
  });

  it('rejects a generated challenge whose word count is not exactly 24', async () => {
    const client = challengeClient({ generated: { words: workAccessWords.slice(0, 23) } });
    const proof = signifyAsynchronousIssuerChallengeProof(client.client, issuer);

    await expect(proof.createChallenge()).rejects.toMatchObject({
      detail: {
        kind: 'keria-response-invalid',
        stage: 'asynchronous challenge generation',
      },
    });
  });

  it('starts verification and returns only the decoded KERIA operation name', async () => {
    const client = challengeClient();
    const proof = signifyAsynchronousIssuerChallengeProof(client.client, issuer);

    await expect(
      proof.startVerification({ sourceAid: user, challengeWords: workAccessWords }),
    ).resolves.toEqual({ operationName: 'challenge-verification.operation' });
    expect(client.verify).toHaveBeenCalledExactlyOnceWith(user, workAccessWords);
  });

  it('observes one persisted operation exactly once and preserves Pending', async () => {
    const client = challengeClient({
      observed: {
        name: 'challenge-verification.operation',
        done: false,
        metadata: { words: workAccessWords },
      },
    });
    const proof = signifyAsynchronousIssuerChallengeProof(client.client, issuer);

    await expect(
      proof.observeVerification({
        operationName: 'challenge-verification.operation',
        sourceAid: user,
        challengeWords: workAccessWords,
        responseSaid: expectedResponseSaid,
      }),
    ).resolves.toEqual({ kind: 'Pending' });
    expect(client.get).toHaveBeenCalledExactlyOnceWith('challenge-verification.operation');
    expect(client.responded).not.toHaveBeenCalled();
    expect(client.remove).not.toHaveBeenCalled();
  });

  it('verifies the exact completed exchange without acknowledging or deleting it', async () => {
    const exchange = challengeExchange(workAccessWords);
    const client = challengeClient({
      observed: {
        name: 'challenge-verification.operation',
        done: true,
        metadata: { words: workAccessWords },
        response: { exn: exchange },
      },
    });
    const proof = signifyAsynchronousIssuerChallengeProof(client.client, issuer);

    await expect(
      proof.observeVerification({
        operationName: 'challenge-verification.operation',
        sourceAid: user,
        challengeWords: workAccessWords,
        responseSaid: challengeResponseSaid(exchange.d),
      }),
    ).resolves.toEqual({ kind: 'Verified', responseSaid: exchange.d });
    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.responded).not.toHaveBeenCalled();
    expect(client.remove).not.toHaveBeenCalled();
  });

  it.each([
    [
      'failed operation',
      {
        name: 'challenge-verification.operation',
        done: true,
        metadata: { words: workAccessWords },
        error: { code: 404, message: 'challenge response not found' },
      },
      'OperationFailed',
    ],
    [
      'wrong persisted operation',
      {
        name: 'different.operation',
        done: false,
        metadata: { words: workAccessWords },
      },
      'InvalidProof',
    ],
    [
      'wrong persisted challenge words',
      {
        name: 'challenge-verification.operation',
        done: false,
        metadata: { words: [...workAccessWords.slice(0, 23), 'different-word'] },
      },
      'InvalidProof',
    ],
    [
      'malformed operation',
      { name: 'challenge-verification.operation', done: true },
      'InvalidProof',
    ],
  ])('returns Rejected for a %s', async (_label, observed, rejectionKind) => {
    const client = challengeClient({ observed });
    const proof = signifyAsynchronousIssuerChallengeProof(client.client, issuer);

    await expect(
      proof.observeVerification({
        operationName: 'challenge-verification.operation',
        sourceAid: user,
        challengeWords: workAccessWords,
        responseSaid: expectedResponseSaid,
      }),
    ).resolves.toMatchObject({ kind: 'Rejected', rejection: { kind: rejectionKind } });
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('returns Rejected when completed evidence does not match the durable binding', async () => {
    const exchange = challengeExchange(workAccessWords);
    const client = challengeClient({
      observed: {
        name: 'challenge-verification.operation',
        done: true,
        metadata: { words: workAccessWords },
        response: { exn: exchange },
      },
    });
    const proof = signifyAsynchronousIssuerChallengeProof(client.client, issuer);

    await expect(
      proof.observeVerification({
        operationName: 'challenge-verification.operation',
        sourceAid: anotherUser,
        challengeWords: workAccessWords,
        responseSaid: challengeResponseSaid(exchange.d),
      }),
    ).resolves.toMatchObject({ kind: 'Rejected', rejection: { kind: 'InvalidProof' } });
  });

  it('classifies an observation transport failure as identity infrastructure failure', async () => {
    const client = challengeClient({ observationFailure: new Error('connection refused') });
    const proof = signifyAsynchronousIssuerChallengeProof(client.client, issuer);

    await expect(
      proof.observeVerification({
        operationName: 'challenge-verification.operation',
        sourceAid: user,
        challengeWords: workAccessWords,
        responseSaid: expectedResponseSaid,
      }),
    ).rejects.toMatchObject({
      detail: {
        kind: 'keria-unavailable',
        stage: 'asynchronous challenge verification observation',
      },
    });
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it('acknowledges the exact verified response and leaves cleanup explicit', async () => {
    const client = challengeClient();
    const proof = signifyAsynchronousIssuerChallengeProof(client.client, issuer);

    await proof.acknowledgeResponse({ sourceAid: user, responseSaid: expectedResponseSaid });
    expect(client.responded).toHaveBeenCalledExactlyOnceWith(user, expectedResponseSaid);
    expect(client.remove).not.toHaveBeenCalled();

    await proof.cleanupVerification('challenge-verification.operation');
    expect(client.remove).toHaveBeenCalledExactlyOnceWith('challenge-verification.operation');
  });
});
