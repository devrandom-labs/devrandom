import { exchange as createUnsignedExchange, type HabState, SignifyClient, Tier } from 'signify-ts';
import { describe, expect, it, vi } from 'vitest';

import { evidenceSealExchangeRoute, type EvidenceSealPayload } from '@devrandom/protocol';

import {
  connectLocalEvidenceSealExchange,
  decodeEvidenceSealExchangeEvidence,
  signifyIssuerEvidenceSealExchange,
  signifyLocalEvidenceSealExchange,
  verifyEvidenceSealExchangeEvidence,
  type EvidenceSealExchangeEvidence,
} from './evidence-seal-exchange.js';
import { agentAid, controllerAid, issuerAid, personalAgentAid } from './keri-identifier.js';

const issuer = issuerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const personalAgent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const alternateController = controllerAid('EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4');
const said = (character: string) => `E${character.repeat(43)}`;

const payload: EvidenceSealPayload = {
  version: 1,
  kind: 'EvidenceStreamSeal',
  runId: '1cc482f1-98e9-4454-8e4c-5566cb47ce3d',
  evidenceStreamId: 'a30aae94-a652-485f-a2cc-8980134f4acc',
  eventCount: 12,
  finalSequence: 11,
  chainHeadSaid: said('a'),
  harnessRevisionSaid: said('b'),
  taskMandateSaid: said('c'),
};

const preparedAt = Date.parse('2026-09-24T20:00:00.000Z');

function evidence(): EvidenceSealExchangeEvidence {
  const [exchange] = createUnsignedExchange(
    evidenceSealExchangeRoute,
    payload,
    personalAgent,
    issuer,
    '2026-09-24T20:00:00.000000+00:00',
  );
  const decoded = decodeEvidenceSealExchangeEvidence(exchange.sad);
  if (decoded === undefined) {
    throw new Error('expected a decoded evidence-seal exchange');
  }
  return decoded;
}

function senderState(): HabState {
  return {
    name: 'devrandom-personal-agent',
    prefix: personalAgent,
    icp_dt: '2026-09-24T14:00:00.000000+00:00',
    state: {
      i: personalAgent,
      s: '0',
      p: '',
      d: personalAgent,
      f: '0',
      dt: '2026-09-24T14:00:00.000000+00:00',
      et: 'icp',
      kt: '1',
      k: [],
      nt: '1',
      n: [],
      bt: '0',
      b: [],
      c: [],
      ee: { s: '0', d: personalAgent },
      di: '',
    },
    transferable: true,
    windexes: [],
    randy: { prxs: [], nxts: [] },
  };
}

const expectation = {
  exchangeSaid: evidence().d,
  sourceAid: personalAgent,
  recipientAid: issuer,
  payload,
};

describe('personal-agent evidence-seal exchange', () => {
  it('verifies the native SAID, exact source, recipient, route, and closed payload', () => {
    expect(verifyEvidenceSealExchangeEvidence(evidence(), expectation)).toEqual({
      kind: 'Verified',
      exchangeSaid: expectation.exchangeSaid,
      sourceAid: personalAgent,
      payload,
    });
  });

  it.each([
    [
      'source',
      'SealExchangeSourceMismatch',
      (exchange: EvidenceSealExchangeEvidence) => ({ ...exchange, i: issuer }),
    ],
    [
      'recipient',
      'SealExchangeRecipientMismatch',
      (exchange: EvidenceSealExchangeEvidence) => ({ ...exchange, rp: personalAgent }),
    ],
    [
      'route',
      'SealExchangeRouteMismatch',
      (exchange: EvidenceSealExchangeEvidence) => ({
        ...exchange,
        r: '/devrandom/run/admission/1',
      }),
    ],
    [
      'payload',
      'SealExchangePayloadMismatch',
      (exchange: EvidenceSealExchangeEvidence) => ({
        ...exchange,
        a: { ...exchange.a, finalSequence: 10 },
      }),
    ],
  ])('rejects a changed %s before accepting issuer-side evidence', (_field, reason, change) => {
    expect(verifyEvidenceSealExchangeEvidence(change(evidence()), expectation)).toEqual({
      kind: 'Rejected',
      reason,
    });
  });

  it('rejects an exchange whose content no longer matches its native SAID', () => {
    const changed = { ...evidence(), p: said('p') };

    expect(verifyEvidenceSealExchangeEvidence(changed, expectation)).toEqual({
      kind: 'Rejected',
      reason: 'SealExchangeSaidMismatch',
    });
  });

  it('prepares and delivers the same stable signed exchange through Signify', async () => {
    const client = new SignifyClient(
      'http://127.0.0.1:3901',
      '0123456789abcdefghijk',
      Tier.low,
      'http://127.0.0.1:3903',
    );
    const [exchange] = createUnsignedExchange(
      evidenceSealExchangeRoute,
      payload,
      personalAgent,
      issuer,
      '2026-09-24T20:00:00.000000+00:00',
    );
    vi.spyOn(client.identifiers(), 'get').mockResolvedValue(senderState());
    const create = vi
      .spyOn(client.exchanges(), 'createExchangeMessage')
      .mockResolvedValue([exchange, ['fixture-signature'], '']);
    vi.spyOn(client.exchanges(), 'get').mockRejectedValue(
      new Error(`HTTP GET /exchanges/${exchange.said} - 404 Not Found - absent`),
    );
    const materializedExchange = { ...evidence(), q: {}, e: {} };
    const send = vi
      .spyOn(client.exchanges(), 'sendFromEvents')
      .mockResolvedValue(materializedExchange);
    const local = signifyLocalEvidenceSealExchange(client);
    const stable = {
      senderAlias: 'devrandom-personal-agent',
      sourceAid: personalAgent,
      recipientAid: issuer,
      payload,
      preparedAt,
    };

    const prepared = await local.prepare(stable);
    await expect(local.deliver({ ...stable, ...prepared })).resolves.toEqual(prepared);

    expect(create).toHaveBeenCalledWith(
      senderState(),
      evidenceSealExchangeRoute,
      payload,
      {},
      issuer,
      '2026-09-24T20:00:00.000000+00:00',
    );
    expect(send).toHaveBeenCalledWith(
      'devrandom-personal-agent',
      'evidence-seal',
      exchange,
      ['fixture-signature'],
      '',
      [issuer],
    );
  });

  it.each(['Stored', 'Absent'] as const)(
    'reconciles a malformed delivery reply only when the exact KERIA exchange is %s',
    async (storage) => {
      const client = new SignifyClient(
        'http://127.0.0.1:3901',
        '0123456789abcdefghijk',
        Tier.low,
        'http://127.0.0.1:3903',
      );
      const exact = { ...evidence(), q: {}, e: {} };
      const [exchange] = createUnsignedExchange(
        evidenceSealExchangeRoute,
        payload,
        personalAgent,
        issuer,
        '2026-09-24T20:00:00.000000+00:00',
      );
      vi.spyOn(client.identifiers(), 'get').mockResolvedValue(senderState());
      vi.spyOn(client.exchanges(), 'createExchangeMessage').mockResolvedValue([
        exchange,
        ['fixture-signature'],
        '',
      ]);
      const absent = new Error(`HTTP GET /exchanges/${exact.d} - 404 Not Found - absent`);
      const get = vi.spyOn(client.exchanges(), 'get').mockRejectedValueOnce(absent);
      if (storage === 'Stored') get.mockResolvedValueOnce({ exn: exact, pathed: {} });
      else get.mockRejectedValueOnce(absent);
      const send = vi
        .spyOn(client.exchanges(), 'sendFromEvents')
        .mockResolvedValue({ ...exact, d: said('z') });
      const stable = {
        senderAlias: 'devrandom-personal-agent',
        sourceAid: personalAgent,
        recipientAid: issuer,
        payload,
        preparedAt,
      };
      const local = signifyLocalEvidenceSealExchange(client);

      const prepared = await local.prepare(stable);
      if (storage === 'Stored') {
        await expect(local.deliver({ ...stable, ...prepared })).resolves.toEqual(prepared);
      } else {
        await expect(local.deliver({ ...stable, ...prepared })).rejects.toMatchObject({
          detail: { kind: 'keria-response-invalid' },
        });
      }
      expect(send).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledTimes(2);
      expect(get).toHaveBeenNthCalledWith(2, exact.d);
    },
  );

  it('inspects only the exact KERIA-materialized exchange by SAID', async () => {
    const client = new SignifyClient(
      'http://127.0.0.1:3901',
      '0123456789abcdefghijk',
      Tier.low,
      'http://127.0.0.1:3903',
    );
    const materializedExchange = { ...evidence(), q: {}, e: {} };
    const get = vi
      .spyOn(client.exchanges(), 'get')
      .mockResolvedValue({ exn: materializedExchange, pathed: {} });

    await expect(signifyIssuerEvidenceSealExchange(client).inspect(expectation)).resolves.toEqual({
      kind: 'Verified',
      exchangeSaid: expectation.exchangeSaid,
      sourceAid: personalAgent,
      payload,
    });
    expect(get).toHaveBeenCalledWith(expectation.exchangeSaid);
  });

  it('rejects a recovered controller binding mismatch before exposing seal signing', async () => {
    const expectedControllerAid = controllerAid(issuer);
    const expectedAgentAid = agentAid(personalAgent);
    const client = new SignifyClient(
      'http://127.0.0.1:3901',
      '0123456789abcdefghijk',
      Tier.low,
      'http://127.0.0.1:3903',
    );

    await expect(
      connectLocalEvidenceSealExchange(
        {
          adminUrl: 'http://127.0.0.1:3901',
          bootUrl: 'http://127.0.0.1:3903',
          bran: '0123456789abcdefghijk',
          securityTier: 'low',
          expectedControllerAid,
          expectedAgentAid,
        },
        () =>
          Promise.resolve({
            client,
            controllerAid: alternateController,
            agentAid: expectedAgentAid,
            connection: 'existing-controller-connected',
          }),
      ),
    ).rejects.toMatchObject({ detail: { kind: 'controller-state-invalid' } });
  });
});
