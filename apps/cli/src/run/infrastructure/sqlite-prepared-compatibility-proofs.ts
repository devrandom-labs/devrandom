import type { DatabaseSync } from 'node:sqlite';

import type { Run } from '@devrandom/domain';
import { decodeEvidenceEvent, type EvidenceEvent } from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

import type { PreparedCompatibilityProviderProofReading } from '../application/prepared-compatibility-calibration-settlement.js';

const stateRowSchema = Type.Object(
  { run_id: Type.String(), next_sequence: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
);
const eventRowSchema = Type.Object(
  {
    sequence: Type.Integer({ minimum: 0 }),
    encoded_event: Type.String({ minLength: 1, maxLength: 65_536 }),
  },
  { additionalProperties: false },
);

type ToolProposalEvent = EvidenceEvent & { readonly event: { readonly kind: 'ToolProposed' } };
type ToolEffectEvent = EvidenceEvent & { readonly event: { readonly kind: 'EffectCompleted' } };
type ModelMessageEvent = EvidenceEvent & {
  readonly event: { readonly kind: 'ModelMessageCompleted' };
};

function isModelMessageEvent(event: EvidenceEvent): event is ModelMessageEvent {
  return event.event.kind === 'ModelMessageCompleted';
}

function isToolProposalEvent(event: EvidenceEvent): event is ToolProposalEvent {
  return event.event.kind === 'ToolProposed';
}

function isToolEffectEvent(event: EvidenceEvent): event is ToolEffectEvent {
  return event.event.kind === 'EffectCompleted';
}

function proposalMatchesEffect(proposal: ToolProposalEvent, effect: ToolEffectEvent): boolean {
  return (
    proposal.event.piSessionId === effect.event.piSessionId &&
    proposal.event.modelTurnId === effect.event.modelTurnId &&
    proposal.event.toolCallId === effect.event.toolCallId &&
    proposal.event.proposalIndex === effect.event.proposalIndex &&
    proposal.event.tool === effect.event.tool &&
    proposal.event.requiredCapability === effect.event.requiredCapability &&
    proposal.event.resource === effect.event.resource
  );
}

export function readPreparedCompatibilityProviderProof(
  database: DatabaseSync,
  run: Run,
): PreparedCompatibilityProviderProofReading {
  try {
    const state: unknown = database
      .prepare('SELECT run_id, next_sequence FROM stream_state WHERE singleton = 1')
      .get();
    if (!Value.Check(stateRowSchema, state) || state.run_id !== run.binding.runId) {
      return { kind: 'Corrupt' };
    }
    let message: ModelMessageEvent | undefined;
    let proposal: ToolProposalEvent | undefined;
    let proved:
      Extract<PreparedCompatibilityProviderProofReading, { readonly kind: 'Proved' }> | undefined;
    let expectedSequence = 0;
    const rows = database
      .prepare('SELECT sequence, encoded_event FROM evidence_events ORDER BY sequence')
      .iterate();
    for (const row of rows) {
      if (!Value.Check(eventRowSchema, row) || row.sequence !== expectedSequence) {
        return { kind: 'Corrupt' };
      }
      expectedSequence += 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.encoded_event);
      } catch {
        return { kind: 'Corrupt' };
      }
      const decoded = decodeEvidenceEvent(parsed);
      if (
        decoded.kind !== 'Accepted' ||
        decoded.event.sequence !== row.sequence ||
        decoded.event.runId !== run.binding.runId
      ) {
        return { kind: 'Corrupt' };
      }
      const event = decoded.event;
      if (isModelMessageEvent(event) && event.event.disposition === 'Completed') {
        message = event;
        proposal = undefined;
        continue;
      }
      if (isToolProposalEvent(event)) {
        proposal =
          message !== undefined &&
          message.event.piSessionId === event.event.piSessionId &&
          message.event.modelTurnId === event.event.modelTurnId
            ? event
            : undefined;
        continue;
      }
      if (isToolEffectEvent(event)) {
        if (
          proved === undefined &&
          message !== undefined &&
          proposal !== undefined &&
          proposalMatchesEffect(proposal, event)
        ) {
          proved = { kind: 'Proved', proof: { message, proposal, effect: event } };
        }
      }
    }
    if (expectedSequence !== state.next_sequence) return { kind: 'Corrupt' };
    return proved ?? { kind: 'NotFound' };
  } catch {
    return { kind: 'Unavailable' };
  }
}
