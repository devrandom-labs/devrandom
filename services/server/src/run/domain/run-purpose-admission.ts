import { isDeepStrictEqual } from 'node:util';

import {
  preparedCompatibilityFailureCategoriesMatch,
  type PreparedCompatibilityCalibrationOrdinal,
  type Run,
} from '@devrandom/domain';

export type RunPurposeAdmission =
  | { readonly kind: 'RunPurposeAdmitted' }
  | { readonly kind: 'PurposeSlotOccupied'; readonly runId: string }
  | { readonly kind: 'ExistingRetainedRunActive'; readonly runId: string }
  | { readonly kind: 'ExistingRetainedRunEnded'; readonly runId: string }
  | { readonly kind: 'InitialSpecializationMismatch' }
  | { readonly kind: 'CalibrationCampaignMismatch' }
  | { readonly kind: 'CalibrationOrdinalNotNext'; readonly nextOrdinal: number }
  | { readonly kind: 'PriorCalibrationTerminalRequired'; readonly runId: string }
  | { readonly kind: 'CalibrationTerminalOutcomeRequired'; readonly runId: string }
  | { readonly kind: 'CalibrationCampaignRejected'; readonly runId: string }
  | { readonly kind: 'CalibrationCampaignComplete' }
  | { readonly kind: 'CalibrationCampaignIncomplete' }
  | { readonly kind: 'CalibrationConfirmationInsufficient'; readonly confirmations: number }
  | { readonly kind: 'CalibrationConfirmationCategoryMismatch' };

type CalibrationRun = Run & {
  readonly binding: Run['binding'] & {
    readonly purpose: {
      readonly kind: 'PreparedCompatibilityCalibration';
      readonly campaignId: string;
      readonly ordinal: PreparedCompatibilityCalibrationOrdinal;
    };
  };
};

function isCalibration(run: Run): run is CalibrationRun {
  return run.binding.purpose.kind === 'PreparedCompatibilityCalibration';
}

function initialSpecializationMatches(runs: readonly Run[], proposed: Run): boolean {
  return runs.every((run) =>
    isDeepStrictEqual(run.binding.initialSpecialization, proposed.binding.initialSpecialization),
  );
}

function calibrationHistory(
  runs: readonly CalibrationRun[],
): Exclude<RunPurposeAdmission, { readonly kind: 'RunPurposeAdmitted' }> | undefined {
  const active = runs.find((run) => run.lifecycle.kind === 'Active');
  if (active !== undefined) {
    return { kind: 'PriorCalibrationTerminalRequired', runId: active.binding.runId };
  }
  const invalidOutcome = runs.find(
    (run) =>
      run.lifecycle.kind !== 'Ended' ||
      (run.lifecycle.outcome.kind !== 'CalibrationConfirmed' &&
        run.lifecycle.outcome.kind !== 'CalibrationExcluded' &&
        run.lifecycle.outcome.kind !== 'CalibrationRejected'),
  );
  if (invalidOutcome !== undefined) {
    return {
      kind: 'CalibrationTerminalOutcomeRequired',
      runId: invalidOutcome.binding.runId,
    };
  }
  const rejected = runs.find(
    (run) => run.lifecycle.kind === 'Ended' && run.lifecycle.outcome.kind === 'CalibrationRejected',
  );
  return rejected === undefined
    ? undefined
    : { kind: 'CalibrationCampaignRejected', runId: rejected.binding.runId };
}

function orderedCalibrationHistory(
  runs: readonly CalibrationRun[],
): readonly CalibrationRun[] | undefined {
  const ordered = [...runs].sort(
    (left, right) => left.binding.purpose.ordinal - right.binding.purpose.ordinal,
  );
  return ordered.every((run, index) => run.binding.purpose.ordinal === index + 1)
    ? ordered
    : undefined;
}

export function assessRunPurposeAdmission(
  existing: readonly Run[],
  proposed: Run,
): RunPurposeAdmission {
  const retained = existing.find((run) => run.binding.purpose.kind === 'Retained');
  if (proposed.binding.purpose.kind === 'Retained' && retained !== undefined) {
    return retained.lifecycle.kind === 'Active'
      ? { kind: 'ExistingRetainedRunActive', runId: retained.binding.runId }
      : { kind: 'ExistingRetainedRunEnded', runId: retained.binding.runId };
  }

  if (!initialSpecializationMatches(existing, proposed)) {
    return { kind: 'InitialSpecializationMismatch' };
  }

  const calibrations = existing.filter(isCalibration);
  if (proposed.binding.purpose.kind === 'PreparedCompatibilityCalibration') {
    const proposedPurpose = proposed.binding.purpose;
    const occupied = calibrations.find(
      (run) =>
        run.binding.purpose.campaignId === proposedPurpose.campaignId &&
        run.binding.purpose.ordinal === proposedPurpose.ordinal,
    );
    if (occupied !== undefined) {
      return { kind: 'PurposeSlotOccupied', runId: occupied.binding.runId };
    }
    if (retained !== undefined) {
      return { kind: 'CalibrationCampaignComplete' };
    }
    if (calibrations.some((run) => run.binding.purpose.campaignId !== proposedPurpose.campaignId)) {
      return { kind: 'CalibrationCampaignMismatch' };
    }
    const ordered = orderedCalibrationHistory(calibrations);
    if (ordered === undefined) {
      return { kind: 'CalibrationOrdinalNotNext', nextOrdinal: 1 };
    }
    const history = calibrationHistory(ordered);
    if (history !== undefined) {
      return history;
    }
    if (ordered.length === 5) {
      return { kind: 'CalibrationCampaignComplete' };
    }
    const nextOrdinal = ordered.length + 1;
    return proposedPurpose.ordinal === nextOrdinal
      ? { kind: 'RunPurposeAdmitted' }
      : { kind: 'CalibrationOrdinalNotNext', nextOrdinal };
  }

  if (retained !== undefined) {
    return retained.lifecycle.kind === 'Active'
      ? { kind: 'ExistingRetainedRunActive', runId: retained.binding.runId }
      : { kind: 'ExistingRetainedRunEnded', runId: retained.binding.runId };
  }
  if (calibrations.length !== 5) {
    return { kind: 'CalibrationCampaignIncomplete' };
  }
  const campaignId = calibrations[0]?.binding.purpose.campaignId;
  if (
    campaignId === undefined ||
    calibrations.some((run) => run.binding.purpose.campaignId !== campaignId)
  ) {
    return { kind: 'CalibrationCampaignMismatch' };
  }
  const ordered = orderedCalibrationHistory(calibrations);
  if (ordered === undefined) {
    return { kind: 'CalibrationCampaignIncomplete' };
  }
  const history = calibrationHistory(ordered);
  if (history !== undefined) {
    return history;
  }
  const confirmations = ordered.flatMap((run) =>
    run.lifecycle.kind === 'Ended' && run.lifecycle.outcome.kind === 'CalibrationConfirmed'
      ? [run.lifecycle.outcome.category]
      : [],
  );
  if (confirmations.length < 4) {
    return { kind: 'CalibrationConfirmationInsufficient', confirmations: confirmations.length };
  }
  const first = confirmations[0];
  if (
    first === undefined ||
    confirmations.some(
      (confirmation) => !preparedCompatibilityFailureCategoriesMatch(first, confirmation),
    )
  ) {
    return { kind: 'CalibrationConfirmationCategoryMismatch' };
  }
  return { kind: 'RunPurposeAdmitted' };
}
