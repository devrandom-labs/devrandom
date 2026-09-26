import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AesGcmProtectedCaseCustody } from '../infrastructure/aes-gcm-protected-case-custody.js';
import { cesrPublicConditions } from './cesr-public-contract.js';
import { sealCesrComparisonCases } from './seal-cesr-comparison-cases.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const evaluationId = '81d7f67f-d2f9-4fae-87cc-ac827de6f0d1';
const taskId = 'bbb13317-1c5e-4472-842e-692da01386cf';
const publicConditions = cesrPublicConditions('FlatGroups');

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

it('rejects partial or tampered fresh contracts before entropy or custody', async () => {
  const conditions = cesrPublicConditions('ScopedGroups');
  let draws = 0;
  const ports = {
    custody: new AesGcmProtectedCaseCustody(randomBytes(32)),
    drawPayload: () => Buffer.alloc(32, ++draws),
  };
  expect(
    await sealCesrComparisonCases({ ...input(), publicConditions: conditions.slice(0, -1) }, ports),
  ).toEqual({ kind: 'Incomplete', reason: 'Catalogue' });
  const tampered = conditions.map((condition, index) =>
    index === 14
      ? { ...condition, stimulusBase64Url: Buffer.from('-AAA').toString('base64url') }
      : condition,
  );
  expect(await sealCesrComparisonCases({ ...input(), publicConditions: tampered }, ports)).toEqual({
    kind: 'Incomplete',
    reason: 'Catalogue',
  });
  expect(draws).toBe(0);
});

it('seals the fresh contract as nested large trial and distinct terminal compositions', async () => {
  const custody = new AesGcmProtectedCaseCustody(randomBytes(32));
  let draws = 0;
  const prepared = await sealCesrComparisonCases(
    { ...input(), publicConditions: cesrPublicConditions('ScopedGroups') },
    { custody, drawPayload: () => Buffer.alloc(32, ++draws) },
  );
  expect(prepared.kind).toBe('Prepared');
  if (prepared.kind !== 'Prepared') return;
  for (const [segment, spec] of [
    [0, prepared.bundle.protectedCase],
    [1, prepared.bundle.terminalCase],
  ] as const) {
    const stimulus = await custody.open({
      evaluationId,
      objectSaid: spec.objectSaid,
      artifact: spec.stimulus,
      purpose: segment === 0 ? 'TrialHoldout' : 'TerminalCase',
      segment,
    });
    const expected = await custody.open({
      evaluationId,
      objectSaid: spec.objectSaid,
      artifact: spec.expected,
      purpose: 'OracleObservation',
      segment,
    });
    expect(stimulus.kind).toBe('Opened');
    expect(expected.kind).toBe('Opened');
    if (stimulus.kind !== 'Opened' || expected.kind !== 'Opened') return;
    const text = new TextDecoder().decode(stimulus.plaintext);
    expect(text).toContain('--A');
    expect(text).toContain('-_AAABAA');
    expect(text.length).toBeGreaterThan(4095 * 4);
    const observation = JSON.parse(new TextDecoder().decode(expected.plaintext)) as {
      kind: string;
      receipts: { version: string; payload: string }[];
    };
    expect(observation.kind).toBe('Parsed');
    expect(observation.receipts.some((receipt) => receipt.version === 'Legacy')).toBe(true);
    expect(observation.receipts.some((receipt) => receipt.version === 'Current')).toBe(true);
    stimulus.plaintext.fill(0);
    expected.plaintext.fill(0);
  }
});
