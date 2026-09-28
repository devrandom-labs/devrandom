import { taskRecoveryBudgetCeilings } from '@devrandom/domain';
import Type from 'typebox';
import { taskBudgetsSchema } from '../task/task-command.js';

/** Admitted Run limits retain the execution caps and the explicitly authorized lifetime quota. */
export const runBudgetCeilingSchema = Type.Object(
  {
    ...taskBudgetsSchema.properties,
    tasksPerAdmittedUser: Type.Integer({
      minimum: 0,
      maximum: taskRecoveryBudgetCeilings.tasksPerAdmittedUser,
    }),
    runsPerAdmittedUser: Type.Integer({
      minimum: 0,
      maximum: taskRecoveryBudgetCeilings.runsPerAdmittedUser,
    }),
  },
  { additionalProperties: false },
);
