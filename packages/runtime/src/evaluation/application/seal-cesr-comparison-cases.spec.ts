import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AesGcmProtectedCaseCustody } from '../infrastructure/aes-gcm-protected-case-custody.js';
import { sealCesrComparisonCases } from './seal-cesr-comparison-cases.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const evaluationId = '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const taskId = 'bbb13317-1c5e-4472-842e-692da01386cf';
const payload = said('x');
const publicConditions = [
  {
    id: 'cesr-current',
    stimulusBase64Url: Buffer.from(`-AAL${payload}`).toString('base64url'),
    expected: { kind: 'Parsed' as const, receipts: [{ version: 'Current' as const, payload }] },
  },
  {
    id: 'cesr-tamper',
    stimulusBase64Url: Buffer.from('-AAA').toString('base64url'),
    expected: { kind: 'Rejected' as const, error: 'AnyRejection' as const },
  },
  {
    id: 'cesr-legacy',
    stimulusBase64Url: Buffer.from(`-AAY-_AAABAA${payload}${payload}`).toString('base64url'),
    expected: {
      kind: 'Parsed' as const,
      receipts: [
        { version: 'Legacy' as const, payload },
        { version: 'Legacy' as const, payload },
      ],
    },
  },
];

function input() {
  return {
    evaluationId,
    taskId,
    taskRevisionSaid: said('t'),
    ownerAid: said('o'),
    personalAgentAid: said('a'),
    policySaid: said('p'),
    executionProfileSaid: said('e'),
    oracleAdapterDigest: `sha256:${'d'.repeat(64)}`,
    reviewedRecipeSaid: said('r'),
    toolchainSaid: said('u'),
    publicConditions,
  };
}

describe('CESR protected comparison case preparation', () => {
  it('seals fresh trial and never-feedback terminal stimuli with expected outputs in distinct custody', async () => {
    const custody = new AesGcmProtectedCaseCustody(randomBytes(32));
    let ordinal = 0;
    const prepared = await sealCesrComparisonCases(input(), {
      custody,
      drawPayload: () => Buffer.alloc(32, ++ordinal),
    });
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') return;
    const { protectedCase, terminalCase } = prepared.bundle;
    expect(protectedCase.objectSaid).not.toBe(terminalCase.objectSaid);
    expect(protectedCase.stimulus.d).not.toBe(terminalCase.stimulus.d);
    expect(protectedCase.expected.d).not.toBe(terminalCase.expected.d);
    expect(JSON.stringify(prepared.bundle)).not.toContain(
      'E'.concat(Buffer.alloc(32, 1).toString('base64url')),
    );
    const trial = await custody.open({
      artifact: protectedCase.stimulus,
      evaluationId,
      objectSaid: protectedCase.objectSaid,
      purpose: 'TrialHoldout',
      segment: 0,
    });
    const trialExpected = await custody.open({
      artifact: protectedCase.expected,
      evaluationId,
      objectSaid: protectedCase.objectSaid,
      purpose: 'OracleObservation',
      segment: 0,
    });
    const terminal = await custody.open({
      artifact: terminalCase.stimulus,
      evaluationId,
      objectSaid: terminalCase.objectSaid,
      purpose: 'TerminalCase',
      segment: 1,
    });
    const terminalExpected = await custody.open({
      artifact: terminalCase.expected,
      evaluationId,
      objectSaid: terminalCase.objectSaid,
      purpose: 'OracleObservation',
      segment: 1,
    });
    expect(trial.kind).toBe('Opened');
    expect(trialExpected.kind).toBe('Opened');
    expect(terminal.kind).toBe('Opened');
    expect(terminalExpected.kind).toBe('Opened');
    if (
      trial.kind !== 'Opened' ||
      trialExpected.kind !== 'Opened' ||
      terminal.kind !== 'Opened' ||
      terminalExpected.kind !== 'Opened'
    )
      return;
    expect(new TextDecoder().decode(trial.plaintext)).toMatch(
      /^-AAY-_AAABAAE[A-Za-z0-9_-]{43}E[A-Za-z0-9_-]{43}$/u,
    );
    expect(JSON.parse(new TextDecoder().decode(trialExpected.plaintext))).toEqual({
      kind: 'Parsed',
      receipts: [
        { version: 'Legacy', payload: `E${Buffer.alloc(32, 1).toString('base64url')}` },
        { version: 'Legacy', payload: `E${Buffer.alloc(32, 2).toString('base64url')}` },
      ],
    });
    expect(new TextDecoder().decode(terminal.plaintext)).not.toBe(
      new TextDecoder().decode(trial.plaintext),
    );
    expect(JSON.parse(new TextDecoder().decode(terminalExpected.plaintext))).toEqual({
      kind: 'Parsed',
      receipts: [
        { version: 'Legacy', payload: `E${Buffer.alloc(32, 3).toString('base64url')}` },
        { version: 'Legacy', payload: `E${Buffer.alloc(32, 4).toString('base64url')}` },
      ],
    });
    trial.plaintext.fill(0);
    trialExpected.plaintext.fill(0);
    terminal.plaintext.fill(0);
    terminalExpected.plaintext.fill(0);
  });

  it('rejects repeated entropy before publishing any case catalogue', async () => {
    const custody = new AesGcmProtectedCaseCustody(randomBytes(32));
    expect(
      await sealCesrComparisonCases(input(), {
        custody,
        drawPayload: () => Buffer.alloc(32, 1),
      }),
    ).toEqual({ kind: 'Incomplete', reason: 'Entropy' });
  });
});
