import { taskEvaluationBudgetCeilings } from '@devrandom/domain';
import Type from 'typebox';
import { taskBudgetsSchema } from '../task/task-command.js';

/** Admitted Run limits retain the execution caps and the explicitly authorized lifetime quota. */
export const runBudgetCeilingSchema = Type.Object(
  {
    ...taskBudgetsSchema.properties,
    runsPerAdmittedUser: Type.Integer({
      minimum: 0,
      maximum: taskEvaluationBudgetCeilings.runsPerAdmittedUser,
    }),
  },
  { additionalProperties: false },
);
