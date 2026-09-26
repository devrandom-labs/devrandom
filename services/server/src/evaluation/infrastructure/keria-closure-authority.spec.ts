import type { Db } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';

import { issuerAid, personalAgentAid } from '@devrandom/identity';
import { evaluationClosureSealPayload, prepareEvaluationClosure } from '@devrandom/protocol';

import { KeriaEvaluationClosureAuthority } from './keria-closure-authority.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const ownerAid = said('o');
const agentAid = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const issuer = issuerAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');
const taskId = 'a3d703a5-122d-4b33-8d03-7bfdcb0ba61e';
const taskRevisionSaid = said('t');
const taskMandateSaid = said('m');
const sourceInventorySaid = said('i');
const repositoryResourceSaid = said('r');
const corpusSaid = said('c');
const prepared = prepareEvaluationClosure({
  evaluationId: 'ea587f9a-410a-4dba-a513-fac592f417b6',
  evidenceStreamId: 'ed39e873-5af1-414b-ae48-3712544921c1',
  originRunId: '97b2da54-a908-4ddc-a7cc-7da0170694a7',
  manifestSaid: said('M'),
  evidenceIndexSaid: said('I'),
  acceptedEventCount: 39,
  acceptedHeadSaid: said('h'),
  observationSaids: Array.from({ length: 18 }, (_, index) => said(String.fromCharCode(65 + index))),
  measurementSaids: Array.from({ length: 15 }, (_, index) => said(String.fromCharCode(97 + index))),
  sharedAuditSaid: said('s'),
  armAuditSaids: {
    H1: said('1'),
    C1: said('2'),
    C2: said('3'),
    C3: said('4'),
    H1TaskSearch: said('5'),
  },
  protectedCustodySaid: said('p'),
  agentSealSaid: said('g'),
});
if (prepared.kind !== 'Prepared') throw new Error('Closure fixture rejected');
const closure = prepared.closure;

function fixture() {
  const evaluation = {
    _id: closure.evaluationId,
    ownerAid,
    evidenceStreamId: closure.evidenceStreamId,
    lease: {
      evaluationId: closure.evaluationId,
      leaseId: '13e1de73-d1a8-48f4-8ae4-09d63fb6ca8e',
      version: 1,
      serverTime: '2026-09-26T04:00:00.000Z',
      expiresAt: '2026-09-26T17:00:00.000Z',
    },
    command: {
      taskId,
      taskRevisionSaid,
      taskMandateSaid,
      sourceInventorySaid,
      originRunId: closure.originRunId,
      personalAgentAid: agentAid,
    },
  };
  const database = {
    collection: () => ({ findOne: () => Promise.resolve(evaluation) }),
  } as unknown as Db;
  const scopes = {
    inspectInventory: vi.fn(() =>
      Promise.resolve({
        kind: 'Authorized' as const,
        personalAgentAid: agentAid,
        scope: {
          ownerAid,
          taskId,
          taskRevisionSaid,
          repositoryResourceSaid,
          allowedCorpusSaid: corpusSaid,
          mandate: { kind: 'AuthorizedExperience' as const, mandateSaid: taskMandateSaid },
        },
      }),
    ),
  };
  const exchanges = {
    inspect: vi.fn(() =>
      Promise.resolve({
        kind: 'Verified' as const,
        exchangeSaid: closure.agentSealSaid,
        sourceAid: agentAid,
        payload: evaluationClosureSealPayload(closure),
      }),
    ),
  };
  const authority = new KeriaEvaluationClosureAuthority(database, {
    scopes,
    exchanges,
    issuerAid: issuer,
  });
  return { evaluation, scopes, exchanges, authority };
}

describe('KERIA-backed Evaluation closure authority', () => {
  it('authorizes only the current Task agent whose issuer KERIA exchange matches the exact claim', async () => {
    const { authority, exchanges } = fixture();
    await expect(authority.verify({ ownerAid, closure })).resolves.toEqual({ kind: 'Authorized' });
    expect(exchanges.inspect).toHaveBeenCalledWith({
      exchangeSaid: closure.agentSealSaid,
      sourceAid: agentAid,
      recipientAid: issuer,
      payload: evaluationClosureSealPayload(closure),
    });
  });

  it('denies wrong current agent, pending exchange, or mismatched evaluation stream', async () => {
    const changed = fixture();
    changed.evaluation.evidenceStreamId = 'cc39e873-5af1-414b-ae48-3712544921c1';
    await expect(changed.authority.verify({ ownerAid, closure })).resolves.toEqual({
      kind: 'Denied',
    });
    expect(changed.exchanges.inspect).not.toHaveBeenCalled();

    const pending = fixture();
    pending.exchanges.inspect.mockResolvedValueOnce({ kind: 'Pending' } as never);
    await expect(pending.authority.verify({ ownerAid, closure })).resolves.toEqual({
      kind: 'Denied',
    });
    const wrongAgent = fixture();
    wrongAgent.evaluation.command.personalAgentAid = personalAgentAid(
      'EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4',
    );
    await expect(wrongAgent.authority.verify({ ownerAid, closure })).resolves.toEqual({
      kind: 'Denied',
    });
  });

  it('denies an otherwise signed closure when the admitted lease has expired', async () => {
    const expired = fixture();
    expired.evaluation.lease.expiresAt = '2026-09-26T00:00:00.000Z';
    await expect(expired.authority.verify({ ownerAid, closure })).resolves.toEqual({
      kind: 'Denied',
    });
    expect(expired.exchanges.inspect).not.toHaveBeenCalled();
  });
});
