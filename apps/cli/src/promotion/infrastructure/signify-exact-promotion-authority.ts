import {
  taskBudgetCeilings,
  verifyTaskMandate,
  verifyExactPromotionMandate,
  type MandateTask,
  type PromotionMandateInspection,
  type ExactPromotionMandateInspection,
} from '@devrandom/domain';
import { credentialSaid, type LocalMandateCustody } from '@devrandom/identity';
import {
  taskMandateV2SchemaSaid,
  taskMandateV3SchemaSaid,
  promotionMandateV3SchemaSaid,
  promotionMandateV5SchemaSaid,
  type TaskProjection,
} from '@devrandom/protocol';
import type { ExactPromotionAuthority } from '@devrandom/runtime';
import Type from 'typebox';
import Value from 'typebox/value';
import type { ReadyTaskAuthorization } from '../../mandate/domain/task-authorization.js';

const exactClaims = Type.Object({
  evaluationManifestSaid: Type.String(),
  requiredMetrics: Type.Array(
    Type.Union([
      Type.Literal('FullContractSuccesses'),
      Type.Literal('PublicConditionPasses'),
      Type.Literal('HeldOutConditionPasses'),
      Type.Literal('TamperRejections'),
      Type.Literal('RepeatedFailures'),
      Type.Literal('MedianTokens'),
      Type.Literal('MedianElapsedMilliseconds'),
      Type.Literal('UnsafeEffects'),
    ]),
  ),
  requiredChecks: Type.Array(
    Type.Union([
      Type.Literal('ExactArtifacts'),
      Type.Literal('RequiredSlots'),
      Type.Literal('SharedSevenObligations'),
      Type.Literal('SelectedArmSevenObligations'),
      Type.Literal('CurrentAuthority'),
      Type.Literal('BudgetWithinCeiling'),
      Type.Literal('EvidenceAcknowledged'),
    ]),
  ),
  riskLimit: Type.Object({
    maximumUnsafeEffects: Type.Number(),
    maximumDisqualifyingAttempts: Type.Number(),
    minimumAdditionalSuccessesOverEachControl: Type.Number(),
  }),
});
function exact(
  inspection: PromotionMandateInspection,
): inspection is ExactPromotionMandateInspection {
  return Value.Check(exactClaims, inspection);
}

/** Reopens native KERIA ACDC/TEL for both credentials on each signing request. */
export class SignifyExactPromotionAuthority implements ExactPromotionAuthority {
  readonly #task: TaskProjection;
  readonly #authorization: ReadyTaskAuthorization;
  readonly #custody: Pick<LocalMandateCustody, 'inspectCredential'>;
  readonly #confirmation:
    { readonly manifestSaid: string; readonly closureSaid: string } | undefined;
  readonly #now: () => string;
  constructor(input: {
    readonly task: TaskProjection;
    readonly authorization: ReadyTaskAuthorization;
    readonly custody: Pick<LocalMandateCustody, 'inspectCredential'>;
    readonly confirmation?: { readonly manifestSaid: string; readonly closureSaid: string };
    now(): string;
  }) {
    this.#task = input.task;
    this.#authorization = input.authorization;
    this.#custody = input.custody;
    this.#confirmation = input.confirmation;
    this.#now = () => input.now();
  }
  async verify(
    input: Parameters<ExactPromotionAuthority['verify']>[0],
  ): ReturnType<ExactPromotionAuthority['verify']> {
    const t = this.#task;
    const a = this.#authorization;
    if (
      this.#confirmation?.manifestSaid !== input.evaluationManifestSaid ||
      this.#confirmation.closureSaid !== input.evaluationClosureSaid
    )
      return { kind: 'PendingUserConfirmation' };
    if (
      t.revision.version !== 2 ||
      input.taskId !== t.taskId ||
      input.taskRevisionSaid !== t.revisionSaid ||
      input.harnessLineageId !== t.harnessLineageId ||
      input.ownerAid !== t.ownerAid ||
      input.governorAid !== a.binding.governorAid ||
      a.binding.ownerAid !== t.ownerAid ||
      a.binding.taskId !== t.taskId ||
      a.binding.taskRevisionSaid !== t.revisionSaid ||
      a.binding.harnessLineageId !== t.harnessLineageId ||
      a.exactPromotionManifestSaid !== input.evaluationManifestSaid
    )
      return { kind: 'Invalid' };
    try {
      const [taskInspection, promotionInspection] = await Promise.all([
        this.#custody.inspectCredential({
          credentialSaid: credentialSaid(a.stage.taskMandate.credential.credentialSaid),
        }),
        this.#custody.inspectCredential({
          credentialSaid: credentialSaid(a.stage.promotionMandate.credential.credentialSaid),
        }),
      ]);
      if (
        taskInspection.kind !== 'TaskMandate' ||
        promotionInspection.kind !== 'PromotionMandate' ||
        !exact(promotionInspection.value)
      )
        return { kind: 'Invalid' };
      const task: MandateTask = {
        taskId: t.taskId,
        ownerAid: t.ownerAid,
        revisionSaid: t.revisionSaid,
        harnessLineageId: t.harnessLineageId,
        repository: t.revision.repository,
        requestedCapabilities: t.revision.requestedCapabilities,
        unavailableCapabilities: t.revision.unavailableCapabilities,
        budgets: t.revision.budgets,
        evolutionClasses: t.revision.evolutionClasses,
        expiresAt: t.revision.expiresAt,
        experience: t.revision.constraints.experience,
      };
      const observedAt = this.#now();
      const taskMandate = verifyTaskMandate(
        {
          credential: {
            issuerAid: t.ownerAid,
            issueeAid: a.binding.personalAgentAid,
            registryId: a.binding.mandateRegistryId,
            schemaSaid:
              task.budgets.runsPerAdmittedUser > taskBudgetCeilings.runsPerAdmittedUser
                ? taskMandateV3SchemaSaid
                : taskMandateV2SchemaSaid,
            credentialSaid: a.stage.taskMandate.credential.credentialSaid,
          },
          task,
          observedAt,
        },
        taskInspection.value,
      );
      if (taskMandate.kind !== 'Current') return { kind: 'Invalid' };
      const promotion = verifyExactPromotionMandate(
        {
          credential: {
            issuerAid: t.ownerAid,
            issueeAid: a.binding.governorAid,
            registryId: a.binding.mandateRegistryId,
            schemaSaid:
              task.budgets.runsPerAdmittedUser > taskBudgetCeilings.runsPerAdmittedUser
                ? promotionMandateV5SchemaSaid
                : promotionMandateV3SchemaSaid,
            credentialSaid: a.stage.promotionMandate.credential.credentialSaid,
          },
          task,
          taskMandate: taskMandate.mandate,
          observedAt,
          evaluationManifestSaid: input.evaluationManifestSaid,
        },
        promotionInspection.value,
      );
      return promotion.kind === 'Current' ? promotion : { kind: 'Invalid' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
