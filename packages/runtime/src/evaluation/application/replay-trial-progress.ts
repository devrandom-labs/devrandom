import { isDeepStrictEqual } from 'node:util';
import type { HarnessCommand } from '@devrandom/domain';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const effectSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal('EvaluationRepositoryEffect'),
    toolCallId: Type.String({ minLength: 1 }),
    proposalIndex: Type.Integer({ minimum: 0 }),
    inputKind: Type.Union([
      Type.Literal('ReadFile'),
      Type.Literal('ListFiles'),
      Type.Literal('SearchRepository'),
      Type.Literal('WriteFile'),
      Type.Literal('ReplaceText'),
      Type.Literal('RunFormatter'),
      Type.Literal('RunStaticAnalysis'),
      Type.Literal('RunTests'),
      Type.Literal('SubmitResult'),
    ]),
    sourceBeforeSaid: said,
    sourceAfterSaid: said,
    command: Type.Optional(
      Type.Object(
        {
          identity: Type.String({ minLength: 1 }),
          contentSaid: said,
          argv: Type.Array(Type.String()),
          expectedExitCode: Type.Integer({ minimum: 0, maximum: 255 }),
          exitCode: Type.Integer({ minimum: 0, maximum: 255 }),
          output: Type.String(),
          error: Type.String(),
          cleanupConfirmed: Type.Literal(true),
        },
        { additionalProperties: false },
      ),
    ),
    publicConditions: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1 }),
            verdict: Type.Union([Type.Literal('Pass'), Type.Literal('Fail')]),
            rawObservationSaid: said,
            cleanupReceiptSaid: said,
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);
export type EvaluationRepositoryEffectReceipt = Type.Static<typeof effectSchema>;
export function decodeEvaluationRepositoryEffect(
  input: unknown,
): EvaluationRepositoryEffectReceipt | undefined {
  return Value.Check(effectSchema, input) ? input : undefined;
}
/** An edit is an observed source change. A new passing immutable public condition
 * advances the milestone once; retries and no-op writes cannot erase failure history. */
export function replayTrialProgress(
  receipts: readonly unknown[],
  commands: readonly HarnessCommand[],
):
  | { readonly kind: 'Verified'; readonly repeatedFailures: number }
  | { readonly kind: 'Incomplete' } {
  let source: string | undefined;
  let edits = 0;
  let milestone = 0;
  let repeatedFailures = 0;
  const passed = new Set<string>();
  const failures = new Map<string, { edit: number; milestone: number }>();
  for (const raw of receipts) {
    const receipt = decodeEvaluationRepositoryEffect(raw);
    if (receipt === undefined || (source !== undefined && source !== receipt.sourceBeforeSaid))
      return { kind: 'Incomplete' };
    const changed = receipt.sourceBeforeSaid !== receipt.sourceAfterSaid;
    if (changed && !['WriteFile', 'ReplaceText', 'RunFormatter'].includes(receipt.inputKind))
      return { kind: 'Incomplete' };
    if (changed) edits++;
    source = receipt.sourceAfterSaid;
    if (['RunFormatter', 'RunStaticAnalysis', 'RunTests'].includes(receipt.inputKind)) {
      const observed = receipt.command;
      if (observed === undefined) return { kind: 'Incomplete' };
      const exact = commands.find((command) => command.identity === observed.identity);
      if (
        exact === undefined ||
        exact.contentSaid !== observed.contentSaid ||
        exact.expectedExitCode !== observed.expectedExitCode ||
        !isDeepStrictEqual(exact.argv, observed.argv)
      )
        return { kind: 'Incomplete' };
      if (observed.exitCode === observed.expectedExitCode) {
        if (!passed.has(exact.identity)) {
          passed.add(exact.identity);
          milestone++;
        }
      } else {
        const signature = `${exact.contentSaid}:${String(observed.exitCode)}`;
        const prior = failures.get(signature);
        if (prior !== undefined && prior.edit < edits && prior.milestone === milestone)
          repeatedFailures++;
        failures.set(signature, { edit: edits, milestone });
      }
    } else if (receipt.command !== undefined) return { kind: 'Incomplete' };
    for (const condition of receipt.publicConditions ?? []) {
      if (receipt.inputKind !== 'SubmitResult') return { kind: 'Incomplete' };
      if (condition.verdict === 'Pass' && !passed.has(condition.id)) {
        passed.add(condition.id);
        milestone++;
      }
    }
  }
  return { kind: 'Verified', repeatedFailures };
}
