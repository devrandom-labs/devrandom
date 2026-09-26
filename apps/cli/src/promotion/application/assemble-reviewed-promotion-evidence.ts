import { isDeepStrictEqual } from 'node:util';
import {
  assessComparisonAllocation,
  closeComparison,
  selectPromotion,
  type CurrentExactPromotionMandate,
  type EvaluationExecutionBinding,
  type PromotionSelectionInput,
} from '@devrandom/domain';
import {
  preparePromotionSelectionRecord,
  type ActiveHarnessPointer,
  type EvaluationManifest,
  type EvaluationVerifierBundle,
  type TaskProjection,
  type PromotionSelectionRecord,
} from '@devrandom/protocol';
import {
  prepareComparisonMeasurements,
  prepareEvaluationBudgetCoverage,
  type PromotionEvidenceReading,
  type EvaluationMeasurementReceipts,
} from '@devrandom/runtime';
import {
  openPromotionCustody,
  type PromotionEvidenceStagingReading,
  type PromotionClosureAcceptance,
  type PromotionAcceptedEvidenceReading,
} from './open-promotion-custody.js';
import { reopenParentEvaluationAudit } from './reopen-parent-evaluation-audit.js';
import type { ParentAuditSourceReading } from './review-parent-audit-sources.js';
interface PromotionSelectionCustody {
  stageSelection(
    selection: PromotionSelectionRecord,
  ): Promise<'Staged' | 'Conflict' | 'Unavailable'>;
}

/** Rebuilds the promotion comparison from immutable closure custody and native replay. */
export async function assembleReviewedPromotionEvidence(
  input: {
    readonly task: TaskProjection;
    readonly manifest: EvaluationManifest;
    readonly verifier: EvaluationVerifierBundle;
    readonly closureSaid: string;
    readonly binding: EvaluationExecutionBinding;
    readonly pointer: Pick<
      ActiveHarnessPointer,
      'taskId' | 'taskRevisionSaid' | 'harnessLineageId' | 'activeRevisionSaid' | 'pointerVersion'
    >;
    readonly mandate: CurrentExactPromotionMandate;
  },
  ports: {
    readonly staging: PromotionEvidenceStagingReading & PromotionSelectionCustody;
    readonly hosted: PromotionClosureAcceptance;
    readonly reading: PromotionAcceptedEvidenceReading;
    readonly audit: ParentAuditSourceReading;
    readonly receipts: EvaluationMeasurementReceipts;
  },
): ReturnType<PromotionEvidenceReading['inspect']> {
  try {
    if (
      input.task.revision.version !== 2 ||
      input.mandate.evaluationManifestSaid !== input.manifest.d ||
      input.mandate.taskId !== input.task.taskId ||
      input.mandate.taskRevisionSaid !== input.task.revisionSaid ||
      input.mandate.harnessLineageId !== input.task.harnessLineageId ||
      input.pointer.taskId !== input.task.taskId ||
      input.pointer.taskRevisionSaid !== input.task.revisionSaid ||
      input.pointer.harnessLineageId !== input.task.harnessLineageId ||
      input.pointer.activeRevisionSaid !== input.manifest.revisions.H1
    )
      return { kind: 'Incomplete' };
    const custody = await openPromotionCustody(
      { closureSaid: input.closureSaid, manifest: input.manifest, terminalBinding: input.binding },
      ports.staging,
      ports.hosted,
      ports.reading,
    );
    if (custody.kind !== 'CustodyOpened') return { kind: 'Incomplete' };
    const staged = await ports.staging.inspect(input.closureSaid);
    if (staged.kind !== 'Staged') return { kind: 'Incomplete' };
    const { closure } = staged.closureCommand;
    const { index } = staged;
    const prefix = await ports.reading.openPrefix({
      binding: input.binding,
      throughSequence: closure.acceptedEventCount - 1,
      headSaid: closure.acceptedHeadSaid,
    });
    if (prefix.kind !== 'Acknowledged') return { kind: 'Incomplete' };
    const replay = await reopenParentEvaluationAudit(
      { manifest: input.manifest, verifier: input.verifier, index, acceptedEvents: prefix.events },
      ports.audit,
    );
    if (replay.kind !== 'Prepared') return { kind: 'Incomplete' };
    const allocation = assessComparisonAllocation(
      input.manifest.allocation,
      input.task.revision.budgets,
    );
    if (allocation.kind !== 'Fits') return { kind: 'Incomplete' };
    const covered = prefix.events.at(-1);
    const before = prefix.events.at(-2);
    if (covered?.detail.kind !== 'EvaluationBudgetCovered' || before === undefined)
      return { kind: 'Incomplete' };
    const measuredBudget = await prepareEvaluationBudgetCoverage(
      { binding: input.binding, reserved: allocation.total, occurredAt: covered.occurredAt },
      {
        accepted: {
          open: () =>
            Promise.resolve({
              kind: 'Acknowledged',
              events: prefix.events.slice(0, -1),
              throughSequence: before.sequence,
              headSaid: before.d,
            }),
        },
        receipts: ports.receipts,
      },
    );
    if (
      measuredBudget.kind !== 'Prepared' ||
      !isDeepStrictEqual(measuredBudget.event, covered) ||
      !isDeepStrictEqual(covered.detail.totals, index.budget.totals)
    )
      return { kind: 'Incomplete' };
    const raw = [];
    for (const record of index.observations) {
      const opened = await ports.reading.openPublic({
        evaluationId: input.manifest.evaluationId,
        artifactSaid: record.artifactSaid,
      });
      if (opened.kind !== 'Opened') return { kind: 'Incomplete' };
      raw.push(opened);
    }
    const measured = prepareComparisonMeasurements({
      manifest: input.manifest,
      verifier: input.verifier,
      observations: raw,
    });
    if (measured.kind !== 'Prepared') return { kind: 'Incomplete' };
    const shared = replay.audits.find((audit) => audit.scope === 'Shared');
    if (shared === undefined) return { kind: 'Incomplete' };
    const candidates: PromotionSelectionInput['candidates'][number][] = [];
    for (const arm of ['C1', 'C2', 'C3'] as const) {
      const audit = replay.audits.find((item) => item.scope === arm);
      if (audit === undefined) return { kind: 'Incomplete' };
      const tamperConditions = input.verifier.publicConditions
        .filter((condition) => condition.expected.kind === 'Rejected')
        .map((condition) => condition.id);
      const repetitions = measured.observations
        .filter((trial) => trial.observation.slot.arm === arm)
        .map((trial) => ({
          repetition: trial.observation.slot.repetition,
          artifactSaid: trial.observation.disposition.artifactSaid,
          artifactBinding: 'Matched' as const,
          tamper:
            tamperConditions.length > 0 &&
            tamperConditions.every((id) =>
              trial.observation.disposition.publicConditionIds.includes(id),
            )
              ? ('Rejected' as const)
              : ('Unverified' as const),
        }));
      candidates.push({
        arm,
        revisionSaid: input.manifest.revisions[arm],
        audit: audit.obligations,
        budget: 'WithinCeiling',
        prohibitedAttempts: audit.attemptCoverage.attempts.map((attempt) => attempt.kind),
        repetitions,
      });
    }
    const comparison: PromotionSelectionInput = {
      conditions: {
        public: input.manifest.publicConditionIds,
        heldOut: [input.verifier.protectedCase.objectSaid],
      },
      observations: measured.observations.map((trial) => trial.observation),
      sharedAudit: shared.obligations,
      evaluationAuthority: 'Current',
      allocation: 'WithinCeiling',
      evidence: 'Acknowledged',
      candidates,
    };
    const selected = selectPromotion(comparison);
    if (selected.kind === 'SelectionBlocked') return { kind: 'Incomplete' };
    const closed = closeComparison(comparison.conditions, comparison.observations);
    if (closed.kind !== 'EvidenceOnly') return { kind: 'Incomplete' };
    const selection =
      selected.kind === 'RetainIncumbent'
        ? { kind: 'RetainIncumbent' as const }
        : {
            kind: 'Activate' as const,
            candidateRevisionSaid: selected.revisionSaid,
            artifactSaids: closed.measurements
              .filter((measurement) => measurement.slot.arm === selected.arm)
              .map((measurement) => measurement.artifactSaid),
          };
    const prepared = preparePromotionSelectionRecord({
      taskId: input.task.taskId,
      taskRevisionSaid: input.task.revisionSaid,
      harnessLineageId: input.task.harnessLineageId,
      expectedIncumbentRevisionSaid: input.pointer.activeRevisionSaid,
      expectedPointerVersion: input.pointer.pointerVersion,
      evaluationManifestSaid: input.manifest.d,
      evaluationClosureSaid: closure.d,
      hypothesisSaid: input.manifest.hypothesisSaid,
      selection,
    });
    if (prepared.kind !== 'Prepared') return { kind: 'Incomplete' };
    const retained = await ports.staging.stageSelection(prepared.record);
    if (retained !== 'Staged') return { kind: 'Incomplete' };
    const reread = await ports.staging.inspect(closure.d);
    if (reread.kind !== 'Staged' || !isDeepStrictEqual(reread.selectionRecord, prepared.record))
      return { kind: 'Incomplete' };
    return {
      kind: 'Verified',
      evidence: {
        manifest: input.manifest,
        closure,
        hypothesisSaid: input.manifest.hypothesisSaid,
        selectionRecord: prepared.record,
        comparison,
      },
    };
  } catch {
    return { kind: 'Unavailable' };
  }
}
