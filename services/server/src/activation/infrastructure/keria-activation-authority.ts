import { isDeepStrictEqual } from 'node:util';

import { Binary, type Collection, type Db } from 'mongodb';
import Type from 'typebox';
import Value from 'typebox/value';

import {
  verifyExactPromotionMandate,
  type CurrentPromotionMandate,
  type ExactPromotionMandateClaims,
  type MandateTask,
} from '@devrandom/domain';
import {
  governorAid,
  personalAgentAid,
  type IssuerAid,
  type IssuerPromotionExchanges,
} from '@devrandom/identity';
import {
  activationExchangeBindings,
  decodeActivationCommitCommand,
  decodeComparisonMeasurementEvidence,
  decodeEvaluationClosure,
  decodeEvaluationClosureEvidenceIndex,
  decodeEvaluationManifest,
  promotionMandateV3SchemaSaid,
  type GovernorPromotionDecisionPayload,
  type PromotionProposalPayload,
  type TaskProjection,
} from '@devrandom/protocol';

import type {
  CurrentPromotionMandateAuthorization,
  CurrentPromotionMandateInput,
} from '../../mandate/application/current-promotion-mandate.js';
import { decodeRunDocument, type RunDocument } from '../../run/infrastructure/run-document.js';
import { runsCollectionName } from '../../run/infrastructure/mongo-runs.js';
import {
  evaluationCollectionNames,
  type EvaluationDocument,
} from '../../evaluation/infrastructure/mongo-evaluation-reservations.js';
import type { ActivationCommitAuthority } from '../application/commit-activation.js';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const exactClaims = Type.Object(
  {
    evaluationManifestSaid: said,
    requiredMetrics: Type.Array(Type.String()),
    requiredChecks: Type.Array(Type.String()),
    riskLimit: Type.Object(
      {
        maximumUnsafeEffects: Type.Integer({ minimum: 0 }),
        maximumDisqualifyingAttempts: Type.Integer({ minimum: 0 }),
        minimumAdditionalSuccessesOverEachControl: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: true },
);

function hasExactClaims(
  value: CurrentPromotionMandate,
): value is CurrentPromotionMandate & ExactPromotionMandateClaims {
  return Value.Check(exactClaims, value);
}

function mandateTask(task: TaskProjection): MandateTask {
  return {
    taskId: task.taskId,
    ownerAid: task.ownerAid,
    revisionSaid: task.revisionSaid,
    harnessLineageId: task.harnessLineageId,
    repository: task.revision.repository,
    requestedCapabilities: task.revision.requestedCapabilities,
    unavailableCapabilities: task.revision.unavailableCapabilities,
    budgets: task.revision.budgets,
    evolutionClasses: task.revision.evolutionClasses,
    expiresAt: task.revision.expiresAt,
    ...(task.revision.version === 2 ? { experience: task.revision.constraints.experience } : {}),
  };
}

interface LockedManifestDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly manifest: unknown;
}

interface EvaluationArtifactDocument {
  readonly _id: string;
  readonly ownerAid: string;
  readonly evaluationId: string;
  readonly custody: 'Public' | 'ProtectedCiphertext';
  readonly artifact: unknown;
  readonly bytes?: Binary;
}

/** Current ACDC/TEL authority, locked M/H0, closed E3 and two distinct KERIA signatures. */
export class KeriaActivationAuthority implements ActivationCommitAuthority {
  readonly #evaluations: Collection<EvaluationDocument>;
  readonly #manifests: Collection<LockedManifestDocument>;
  readonly #artifacts: Collection<EvaluationArtifactDocument>;
  readonly #runs: Collection<RunDocument>;
  readonly #mandates: {
    authorize(input: CurrentPromotionMandateInput): Promise<CurrentPromotionMandateAuthorization>;
  };
  readonly #exchanges: IssuerPromotionExchanges;
  readonly #issuerAid: IssuerAid;
  readonly #now: () => string;

  constructor(
    database: Db,
    dependencies: {
      readonly mandates: {
        authorize(
          input: CurrentPromotionMandateInput,
        ): Promise<CurrentPromotionMandateAuthorization>;
      };
      readonly exchanges: IssuerPromotionExchanges;
      readonly issuerAid: IssuerAid;
      readonly now: () => string;
    },
  ) {
    this.#evaluations = database.collection(evaluationCollectionNames.evaluations);
    this.#manifests = database.collection(evaluationCollectionNames.manifests);
    this.#artifacts = database.collection(evaluationCollectionNames.artifacts);
    this.#runs = database.collection(runsCollectionName);
    this.#mandates = dependencies.mandates;
    this.#exchanges = dependencies.exchanges;
    this.#issuerAid = dependencies.issuerAid;
    this.#now = dependencies.now;
  }

  async verify(
    input: Parameters<ActivationCommitAuthority['verify']>[0],
  ): ReturnType<ActivationCommitAuthority['verify']> {
    const { ownerAid, command } = input;
    if (decodeActivationCommitCommand(command).kind !== 'Accepted')
      return { kind: 'Rejected', gate: 'Selection' };
    try {
      const evaluation = await this.#evaluations.findOne({
        ownerAid,
        'closure.d': command.evaluationClosureSaid,
      });
      if (evaluation === null) return { kind: 'Rejected', gate: 'Evidence' };
      const decodedClosure = decodeEvaluationClosure(evaluation.closure);
      if (
        decodedClosure.kind !== 'Accepted' ||
        evaluation.activeOwnerSlot !== undefined ||
        evaluation.command.taskId !== command.taskId ||
        evaluation.command.taskRevisionSaid !== command.taskRevisionSaid ||
        evaluation.command.expectedActiveRevisionSaid !== command.expectedIncumbentRevisionSaid ||
        !('settledDebit' in evaluation)
      )
        return { kind: 'Rejected', gate: 'Evidence' };
      const locked = await this.#manifests.findOne({ _id: evaluation._id, ownerAid });
      if (locked === null || decodeEvaluationManifest(locked.manifest).kind !== 'Accepted')
        return { kind: 'Rejected', gate: 'Evidence' };
      const manifest = decodeEvaluationManifest(locked.manifest);
      if (manifest.kind !== 'Accepted') return { kind: 'Rejected', gate: 'Evidence' };
      if (
        manifest.manifest.d !== command.evaluationManifestSaid ||
        manifest.manifest.d !== decodedClosure.closure.manifestSaid ||
        manifest.manifest.hypothesisSaid !== command.selectionRecord.hypothesisSaid ||
        manifest.manifest.taskId !== command.taskId ||
        manifest.manifest.taskRevisionSaid !== command.taskRevisionSaid ||
        manifest.manifest.revisions.H1 !== command.expectedIncumbentRevisionSaid ||
        manifest.manifest.ownerAid !== ownerAid
      )
        return { kind: 'Rejected', gate: 'Evidence' };
      const runDocument = await this.#runs.findOne({
        _id: manifest.manifest.originRunId,
        ownerAid,
      });
      if (runDocument === null) return { kind: 'Rejected', gate: 'Evidence' };
      let run;
      try {
        run = decodeRunDocument(runDocument).run;
      } catch {
        return { kind: 'Rejected', gate: 'Evidence' };
      }
      if (
        run.binding.ownerAid !== ownerAid ||
        run.binding.taskId !== command.taskId ||
        run.binding.taskRevisionSaid !== command.taskRevisionSaid ||
        run.binding.harnessLineageId !== command.harnessLineageId ||
        run.binding.personalAgentAid !== manifest.manifest.personalAgentAid ||
        run.binding.initialHarnessRevisionSaid !== command.expectedIncumbentRevisionSaid ||
        run.binding.purpose.kind !== 'Retained' ||
        run.lifecycle.kind !== 'Active' ||
        run.lifecycle.phase.kind !== 'Blocked' ||
        run.lifecycle.phase.reason !== 'HarnessCompatibilityFailure'
      )
        return { kind: 'Rejected', gate: 'Evidence' };
      const current = await this.#mandates.authorize({
        ownerAid,
        taskId: command.taskId,
        taskRevisionSaid: command.taskRevisionSaid,
        harnessLineageId: command.harnessLineageId,
        personalAgentAid: run.binding.personalAgentAid,
        taskMandateSaid: run.binding.taskMandateSaid,
        governorAid: run.binding.governorAid,
        promotionMandateSaid: command.exactPromotionMandateSaid,
        observedAt: this.#now(),
      });
      if (current.kind === 'DependencyUnavailable') return { kind: 'Unavailable' };
      if (current.kind !== 'CurrentPromotionMandateAuthorized')
        return { kind: 'Rejected', gate: 'Mandate' };
      if (
        current.promotionMandate.credential.schemaSaid !== promotionMandateV3SchemaSaid ||
        !hasExactClaims(current.promotionMandate) ||
        verifyExactPromotionMandate(
          {
            credential: {
              issuerAid: this.#issuerAid,
              issueeAid: run.binding.governorAid,
              registryId: current.promotionMandate.credential.registryId,
              schemaSaid: promotionMandateV3SchemaSaid,
              credentialSaid: command.exactPromotionMandateSaid,
            },
            task: mandateTask(current.task),
            taskMandate: current.taskMandate,
            observedAt: this.#now(),
            evaluationManifestSaid: manifest.manifest.d,
          },
          current.promotionMandate,
        ).kind !== 'Current'
      )
        return { kind: 'Rejected', gate: 'Mandate' };
      if (!(await this.#selectionArtifactsMatch(ownerAid, evaluation, manifest.manifest, command)))
        return { kind: 'Rejected', gate: 'Selection' };
      const common = {
        taskId: command.taskId,
        taskRevisionSaid: command.taskRevisionSaid,
        harnessLineageId: command.harnessLineageId,
        expectedIncumbentRevisionSaid: command.expectedIncumbentRevisionSaid,
        expectedPointerVersion: command.expectedPointerVersion,
        evaluationManifestSaid: command.evaluationManifestSaid,
        evaluationClosureSaid: command.evaluationClosureSaid,
        disposition: command.disposition,
      };
      const proposal: PromotionProposalPayload = {
        version: 1,
        kind: 'PromotionProposal',
        ...common,
        hypothesisSaid: manifest.manifest.hypothesisSaid,
      };
      const decision: GovernorPromotionDecisionPayload = {
        version: 1,
        kind: 'GovernorPromotionDecision',
        ...common,
        exactPromotionMandateSaid: command.exactPromotionMandateSaid,
        agentProposalExchangeSaid: command.agentProposalExchangeSaid,
      };
      if (activationExchangeBindings(command, proposal, decision) !== 'Matched')
        return { kind: 'Rejected', gate: 'Signature' };
      let agentAid;
      let governor;
      try {
        agentAid = personalAgentAid(run.binding.personalAgentAid);
        governor = governorAid(run.binding.governorAid);
      } catch {
        return { kind: 'Rejected', gate: 'Authority' };
      }
      if (
        agentAid === String(governor) ||
        String(agentAid) === String(this.#issuerAid) ||
        String(governor) === this.#issuerAid
      )
        return { kind: 'Rejected', gate: 'Authority' };
      const inspected = await this.#exchanges.inspect({
        proposal: {
          exchangeSaid: command.agentProposalExchangeSaid,
          sourceAid: agentAid,
          recipientAid: this.#issuerAid,
          payload: proposal,
        },
        decision: {
          exchangeSaid: command.governorDecisionExchangeSaid,
          sourceAid: governor,
          recipientAid: this.#issuerAid,
          payload: decision,
        },
      });
      if (inspected.kind === 'Unavailable' || inspected.kind === 'Pending')
        return { kind: 'Unavailable' };
      if (inspected.kind !== 'Verified') return { kind: 'Rejected', gate: 'Signature' };
      return { kind: 'Authorized', personalAgentAid: agentAid, governorAid: governor };
    } catch {
      return { kind: 'Unavailable' };
    }
  }

  async #selectionArtifactsMatch(
    ownerAid: string,
    evaluation: EvaluationDocument,
    manifest: Extract<
      ReturnType<typeof decodeEvaluationManifest>,
      { kind: 'Accepted' }
    >['manifest'],
    command: Parameters<ActivationCommitAuthority['verify']>[0]['command'],
  ): Promise<boolean> {
    if (command.disposition.kind !== 'Activate') return true;
    const selected = command.disposition;
    const candidates = (['C1', 'C2', 'C3'] as const).filter(
      (arm) => manifest.revisions[arm] === selected.candidateRevisionSaid,
    );
    if (candidates.length !== 1 || evaluation.closure === undefined) return false;
    const decodedClosure = decodeEvaluationClosure(evaluation.closure);
    if (decodedClosure.kind !== 'Accepted') return false;
    const rawIndex = await this.#artifacts.findOne({
      _id: decodedClosure.closure.evidenceIndexSaid,
      ownerAid,
      evaluationId: evaluation._id,
      custody: 'Public',
    });
    if (rawIndex === null || !(rawIndex.bytes instanceof Binary)) return false;
    const index = decodeEvaluationClosureEvidenceIndex(
      rawIndex.artifact,
      Uint8Array.from(rawIndex.bytes.buffer),
    );
    if (
      index.kind !== 'Accepted' ||
      index.index.manifestSaid !== manifest.d ||
      !isDeepStrictEqual(
        index.index.measurements.map((entry) => entry.artifactSaid),
        decodedClosure.closure.measurementSaids,
      )
    )
      return false;
    const arm = candidates[0];
    if (arm === undefined) return false;
    const outputs: string[] = [];
    for (const repetition of [1, 2, 3] as const) {
      const entry = index.index.measurements.find(
        (item) => item.slot.arm === arm && item.slot.repetition === repetition,
      );
      if (entry === undefined) return false;
      const raw = await this.#artifacts.findOne({
        _id: entry.artifactSaid,
        ownerAid,
        evaluationId: evaluation._id,
        custody: 'Public',
      });
      if (raw === null || !(raw.bytes instanceof Binary)) return false;
      const measurement = decodeComparisonMeasurementEvidence(
        raw.artifact,
        Uint8Array.from(raw.bytes.buffer),
      );
      if (
        measurement.kind !== 'Accepted' ||
        measurement.evidence.manifestSaid !== manifest.d ||
        measurement.evidence.harnessRevisionSaid !== command.disposition.candidateRevisionSaid ||
        !isDeepStrictEqual(measurement.evidence.measurement.slot, entry.slot)
      )
        return false;
      outputs.push(measurement.evidence.measurement.artifactSaid);
    }
    return isDeepStrictEqual(outputs, command.disposition.artifactSaids);
  }
}
