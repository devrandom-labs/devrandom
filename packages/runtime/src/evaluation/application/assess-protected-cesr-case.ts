import {
  decodeProtectedEvaluationArtifact,
  prepareEvidenceArtifact,
  type ProtectedEvaluationArtifact,
} from '@devrandom/protocol';

import type { ProtectedCaseCustody, ReceiptObservation } from './evaluation-conversations.js';

export interface ProtectedCesrCaseInput {
  readonly evaluationId: string;
  readonly objectSaid: string;
  readonly segment: number;
  readonly executableSaid: string;
  readonly stimulusArtifact: ProtectedEvaluationArtifact;
  readonly expectedArtifact: ProtectedEvaluationArtifact;
  readonly signal: AbortSignal;
}

export type ProtectedCesrCaseAssessment =
  | {
      readonly kind: 'Assessed';
      readonly verdict: 'Pass' | 'Fail';
      readonly observationArtifact: ProtectedEvaluationArtifact;
      readonly cleanupReceiptSaid: string;
    }
  | {
      readonly kind: 'Invalid';
      readonly reason:
        'CustodyRejected' | 'ObservationInvalid' | 'EvidenceUnavailable' | 'Interrupted';
    };

type CesrObservation = Extract<
  Awaited<ReturnType<ReceiptObservation['observe']>>,
  { kind: 'Observed' }
>['observation'];

interface UntrustedCesrValue {
  readonly kind?: unknown;
  readonly error?: unknown;
  readonly receipts?: unknown;
  readonly version?: unknown;
  readonly payload?: unknown;
}

function record(value: unknown): value is UntrustedCesrValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function interrupted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function parseObservation(value: unknown): CesrObservation | undefined {
  if (!record(value)) return undefined;
  if (value.kind === 'Rejected') {
    if (
      Object.keys(value).length !== 2 ||
      (value.error !== 'InvalidFrame' &&
        value.error !== 'InvalidPayload' &&
        value.error !== 'UnsupportedVersion')
    )
      return undefined;
    return { kind: 'Rejected', error: value.error };
  }
  if (value.kind !== 'Parsed' || Object.keys(value).length !== 2 || !Array.isArray(value.receipts))
    return undefined;
  if (value.receipts.length > 1024) return undefined;
  const receipts: { version: 'Legacy' | 'Current'; payload: string }[] = [];
  for (const item of value.receipts) {
    if (
      !record(item) ||
      Object.keys(item).length !== 2 ||
      (item.version !== 'Legacy' && item.version !== 'Current') ||
      typeof item.payload !== 'string' ||
      !/^E[A-Za-z0-9_-]{43}$/u.test(item.payload)
    )
      return undefined;
    receipts.push({ version: item.version, payload: item.payload });
  }
  return { kind: 'Parsed', receipts };
}

function artifactIsScoped(
  artifact: ProtectedEvaluationArtifact,
  input: ProtectedCesrCaseInput,
  purpose: ProtectedEvaluationArtifact['purpose'],
): boolean {
  return (
    decodeProtectedEvaluationArtifact(artifact).kind === 'Accepted' &&
    artifact.evaluationId === input.evaluationId &&
    artifact.objectSaid === input.objectSaid &&
    artifact.segment === input.segment &&
    artifact.purpose === purpose
  );
}

/** Parent-only case assessment; candidate processes never receive expected bytes or verdict. */
export async function assessProtectedCesrCase(
  input: ProtectedCesrCaseInput,
  custody: ProtectedCaseCustody,
  observer: ReceiptObservation,
): Promise<ProtectedCesrCaseAssessment> {
  if (interrupted(input.signal)) return { kind: 'Invalid', reason: 'Interrupted' };
  const stimulusPurpose = input.stimulusArtifact.purpose;
  if (
    (stimulusPurpose !== 'TrialHoldout' && stimulusPurpose !== 'TerminalCase') ||
    !artifactIsScoped(input.stimulusArtifact, input, stimulusPurpose) ||
    !artifactIsScoped(input.expectedArtifact, input, 'OracleObservation')
  )
    return { kind: 'Invalid', reason: 'CustodyRejected' };
  let openedStimulus: Awaited<ReturnType<ProtectedCaseCustody['open']>>;
  try {
    openedStimulus = await custody.open({
      artifact: input.stimulusArtifact,
      evaluationId: input.evaluationId,
      objectSaid: input.objectSaid,
      purpose: stimulusPurpose,
      segment: input.segment,
    });
  } catch {
    return { kind: 'Invalid', reason: 'EvidenceUnavailable' };
  }
  if (openedStimulus.kind !== 'Opened') return { kind: 'Invalid', reason: 'CustodyRejected' };
  try {
    if (interrupted(input.signal)) return { kind: 'Invalid', reason: 'Interrupted' };
    if (openedStimulus.plaintext.byteLength > 64 * 1024)
      return { kind: 'Invalid', reason: 'CustodyRejected' };
    const openedExpected = await custody.open({
      artifact: input.expectedArtifact,
      evaluationId: input.evaluationId,
      objectSaid: input.objectSaid,
      purpose: 'OracleObservation',
      segment: input.segment,
    });
    if (openedExpected.kind !== 'Opened') return { kind: 'Invalid', reason: 'CustodyRejected' };
    let expected: CesrObservation | undefined;
    try {
      expected = parseObservation(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(openedExpected.plaintext)),
      );
    } catch {
      return { kind: 'Invalid', reason: 'CustodyRejected' };
    } finally {
      openedExpected.plaintext.fill(0);
    }
    if (expected === undefined) return { kind: 'Invalid', reason: 'CustodyRejected' };
    if (interrupted(input.signal)) return { kind: 'Invalid', reason: 'Interrupted' };
    const stimulusSaid = prepareEvidenceArtifact(
      openedStimulus.plaintext,
      'text/plain; charset=utf-8',
    );
    if (stimulusSaid.kind !== 'Prepared') return { kind: 'Invalid', reason: 'CustodyRejected' };
    const observed = await observer.observe({
      executableSaid: input.executableSaid,
      stimulus: openedStimulus.plaintext,
      stimulusSaid: stimulusSaid.artifact.d,
      caseScope: 'Protected',
      evaluationId: input.evaluationId,
      objectSaid: input.objectSaid,
      segment: input.segment,
      signal: input.signal,
    });
    if (interrupted(input.signal)) return { kind: 'Invalid', reason: 'Interrupted' };
    if (observed.kind !== 'Observed') return { kind: 'Invalid', reason: 'ObservationInvalid' };
    if (
      observed.executableSaid !== input.executableSaid ||
      observed.protectedObservation === undefined ||
      observed.rawObservationSaid !== observed.protectedObservation.d ||
      !artifactIsScoped(observed.protectedObservation, input, 'OracleObservation') ||
      !/^E[A-Za-z0-9_-]{43}$/u.test(observed.cleanupReceiptSaid)
    )
      return { kind: 'Invalid', reason: 'EvidenceUnavailable' };
    const actual = parseObservation(observed.observation);
    if (actual === undefined) return { kind: 'Invalid', reason: 'ObservationInvalid' };
    return {
      kind: 'Assessed',
      verdict: JSON.stringify(actual) === JSON.stringify(expected) ? 'Pass' : 'Fail',
      observationArtifact: observed.protectedObservation,
      cleanupReceiptSaid: observed.cleanupReceiptSaid,
    };
  } catch {
    return {
      kind: 'Invalid',
      reason: interrupted(input.signal) ? 'Interrupted' : 'EvidenceUnavailable',
    };
  } finally {
    openedStimulus.plaintext.fill(0);
  }
}
