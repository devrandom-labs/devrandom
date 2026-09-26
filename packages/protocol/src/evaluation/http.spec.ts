import { Buffer } from 'node:buffer';

import Value from 'typebox/value';
import { describe, expect, it } from 'vitest';

import { prepareEvidenceArtifact } from '../evidence/evidence-artifact.js';
import { prepareEvaluationClosure } from './closure.js';
import {
  decodePublicEvaluationArtifact,
  evaluationAdmissionCommandSchema,
  evaluationClosureCommandSchema,
  evaluationEvidenceUploadSchema,
  evaluationLeaseRenewalCommandSchema,
  evaluationLeaseRenewalReceiptSchema,
  experienceQuerySchema,
} from './http.js';

const said = (character: string): string => `E${character.repeat(43)}`;
const id = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const allowance = {
  providerRequests: 2,
  providerInputTokens: 2000,
  providerOutputTokens: 200,
  providerSpendMicroUsd: 100,
  runWallTimeSeconds: 30,
  toolProposals: 20,
  aggregateChildCommandTimeSeconds: 30,
  changedFiles: 2,
  changedWorktreeBytes: 2000,
  evidencePlusArtifactsPerRunBytes: 10000,
};
const admission = {
  version: 1,
  commandId: id('1'),
  fingerprint: `sha256:${'a'.repeat(64)}`,
  taskId: id('2'),
  taskRevisionSaid: said('t'),
  originRunId: id('3'),
  retainedCheckpointSaid: said('c'),
  retainedSealSaid: said('s'),
  expectedActiveRevisionSaid: said('h'),
  personalAgentAid: said('a'),
  taskMandateSaid: said('m'),
  policySaid: said('p'),
  executionProfileSaid: said('e'),
  sourceInventorySaid: said('i'),
  allocation: { diagnosis: allowance, perEntry: allowance, finalization: allowance },
};

describe('closed evaluation hosted commands', () => {
  it('admits a purpose-specific command with no owner override', () => {
    expect(Value.Check(evaluationAdmissionCommandSchema, admission)).toBe(true);
    expect(
      Value.Check(evaluationAdmissionCommandSchema, { ...admission, ownerAid: said('o') }),
    ).toBe(false);
  });

  it('rejects caller-supplied vectors, filters, index names and unrestricted result counts', () => {
    const query = {
      version: 1,
      taskId: id('2'),
      sourceInventorySaid: said('i'),
      corpusSaid: said('c'),
      failureQuery: 'legacy receipt failure',
      maximumResults: 3,
    };
    expect(Value.Check(experienceQuerySchema, query)).toBe(true);
    for (const extra of [
      { vector: [0.1] },
      { indexName: 'all' },
      { filter: {} },
      { ownerAid: said('o') },
    ]) {
      expect(Value.Check(experienceQuerySchema, { ...query, ...extra })).toBe(false);
    }
    expect(Value.Check(experienceQuerySchema, { ...query, maximumResults: 100 })).toBe(false);
  });

  it('requires a bounded public artifact envelope on an evidence upload', () => {
    const bytes = new TextEncoder().encode('raw parent observation');
    const prepared = prepareEvidenceArtifact(bytes, 'text/plain; charset=utf-8');
    if (prepared.kind !== 'Prepared') throw new Error('expected artifact');
    const envelope = {
      artifact: prepared.artifact,
      bytesBase64Url: Buffer.from(bytes).toString('base64url'),
    };
    const upload = {
      version: 1,
      commandId: id('1'),
      fingerprint: `sha256:${'a'.repeat(64)}`,
      batch: {},
      events: [],
      protectedArtifacts: [],
      publicArtifacts: [],
    };
    expect(evaluationEvidenceUploadSchema.properties.publicArtifacts).toBeDefined();
    expect(Value.Check(evaluationEvidenceUploadSchema, upload)).toBe(false);
    expect(Value.Check(evaluationEvidenceUploadSchema.properties.publicArtifacts, [envelope])).toBe(
      true,
    );
    expect(decodePublicEvaluationArtifact(envelope).kind).toBe('Accepted');
    expect(decodePublicEvaluationArtifact({ ...envelope, bytesBase64Url: 'AAAA' })).toEqual({
      kind: 'Rejected',
    });
    expect(
      Value.Check(evaluationEvidenceUploadSchema.properties.publicArtifacts, [
        { ...envelope, bytesBase64Url: 'A'.repeat(524_289) },
      ]),
    ).toBe(false);
  });

  it('binds renewal to the current evaluation/version and closes lease outcomes', () => {
    const command = {
      version: 1,
      commandId: id('1'),
      fingerprint: `sha256:${'a'.repeat(64)}`,
      evaluationId: id('2'),
      leaseId: id('3'),
      expectedEvaluationVersion: 2,
    };
    expect(Value.Check(evaluationLeaseRenewalCommandSchema, command)).toBe(true);
    expect(
      Value.Check(evaluationLeaseRenewalCommandSchema, { ...command, ownerAid: said('o') }),
    ).toBe(false);
    expect(
      Value.Check(evaluationLeaseRenewalReceiptSchema, {
        kind: 'Lost',
        evaluationId: id('2'),
      }),
    ).toBe(true);
  });

  it('requires exact index bytes to accompany the signed EvidenceOnly closure', () => {
    const prepared = prepareEvaluationClosure({
      evaluationId: id('4'),
      evidenceStreamId: id('5'),
      originRunId: id('6'),
      manifestSaid: said('M'),
      evidenceIndexSaid: said('I'),
      acceptedEventCount: 2,
      acceptedHeadSaid: said('H'),
      observationSaids: Array.from({ length: 18 }, (_, index) =>
        said(String.fromCharCode(65 + index)),
      ),
      measurementSaids: Array.from({ length: 15 }, (_, index) =>
        said(String.fromCharCode(97 + index)),
      ),
      sharedAuditSaid: said('u'),
      armAuditSaids: {
        H1: said('1'),
        C1: said('2'),
        C2: said('3'),
        C3: said('4'),
        H1TaskSearch: said('5'),
      },
      protectedCustodySaid: said('q'),
      agentSealSaid: said('g'),
    });
    if (prepared.kind !== 'Prepared') throw new Error('closure fixture invalid');
    const bytes = new TextEncoder().encode('{}');
    const artifact = prepareEvidenceArtifact(bytes, 'application/json');
    if (artifact.kind !== 'Prepared') throw new Error('index artifact fixture invalid');
    const command = {
      version: 1,
      commandId: id('7'),
      fingerprint: `sha256:${'a'.repeat(64)}`,
      expectedEvaluationVersion: 2,
      closure: prepared.closure,
      evidenceIndex: {
        artifact: artifact.artifact,
        bytesBase64Url: Buffer.from(bytes).toString('base64url'),
      },
    };
    expect(Value.Check(evaluationClosureCommandSchema, command)).toBe(true);
    const withoutIndex = { ...command };
    Reflect.deleteProperty(withoutIndex, 'evidenceIndex');
    expect(Value.Check(evaluationClosureCommandSchema, withoutIndex)).toBe(false);
  });
});
