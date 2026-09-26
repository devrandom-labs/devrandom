import { taskBudgetNames, type TaskBudgetName } from '@devrandom/domain';
import Type from 'typebox';

export const runBudgetConsumptionSchema = Type.Object(
  Object.fromEntries(
    taskBudgetNames.map((name) => [
      name,
      Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    ]),
  ) as Record<TaskBudgetName, ReturnType<typeof Type.Integer>>,
  { additionalProperties: false },
);
