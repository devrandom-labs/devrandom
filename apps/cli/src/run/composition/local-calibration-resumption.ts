import { reconcileLocalInterruptedCalibration } from './interrupted-calibration.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { calibrationTranscript, RestoredCalibrationBehavior } from '@devrandom/runtime';
import { decodeRunProjection } from '@devrandom/protocol';
import { AuthorizedLocalTaskMandates } from '../../mandate/application/local-task-mandates.js';
import { TaskAuthorizationFile } from '../../mandate/infrastructure/task-authorization-file.js';
import { devrandomUserAlias } from '../../identity/domain/user-configuration.js';
import { BaselineHarnessAdmissionFile } from '../../harness/infrastructure/baseline-harness-admission-file.js';
import { EnvironmentPiCredential } from '../infrastructure/pi-credential-environment.js';
import { SignifyTaskToolMandate } from '../infrastructure/signify-task-tool-mandate.js';
import { TaskResumptionComposition } from './task-resumption.js';
import type { LocalTaskResumptionInput, LocalTaskResumption } from './local-task-resumption.js';

/** Same H1 calibration restart; full raw provider history, no treatment or new attempt. */
export async function resumeLocalCalibration(
  input: LocalTaskResumptionInput,
): Promise<LocalTaskResumption> {
  try {
    input.signal.throwIfAborted();
    if (
      input.pauseAfterCheckpoint === true ||
      input.task.ownerAid !== input.hosted.user.principal.aid
    )
      return { kind: 'Blocked', gate: 'Authority' };
    const observed = await input.hosted.runs.inspect(input.runId);
    if (observed.kind !== 'Found') return { kind: 'Blocked', gate: 'Run' };
    const decoded = decodeRunProjection(observed.run);
    if (decoded.kind !== 'Accepted') return { kind: 'Blocked', gate: 'Run' };
    const run = decoded.run;
    if (
      run.binding.purpose.kind !== 'PreparedCompatibilityCalibration' ||
      run.binding.taskId !== input.task.taskId ||
      run.binding.taskRevisionSaid !== input.task.revisionSaid ||
      (run.currentExecution !== undefined &&
        (run.lifecycle.kind !== 'Active' ||
          (run.lifecycle.phase.kind !== 'Preparing' &&
            (run.lifecycle.phase.kind !== 'Blocked' ||
              run.lifecycle.phase.reason !== 'ProcessLost'))))
    )
      return { kind: 'Blocked', gate: 'CalibrationPredecessor' };
    const pointer = await input.hosted.activationPointer().inspect(input.task.taskId);
    if (
      pointer.kind !== 'Observed' ||
      pointer.pointer.kind !== 'Initial' ||
      pointer.pointer.activeRevisionSaid !== run.binding.initialHarnessRevisionSaid ||
      pointer.pointer.taskRevisionSaid !== input.task.revisionSaid
    )
      return { kind: 'Blocked', gate: 'Baseline' };
    const baseline = await new BaselineHarnessAdmissionFile(
      join(input.stateRoot, 'harness-admissions'),
    ).readAccepted({
      taskId: input.task.taskId,
      taskRevisionSaid: input.task.revisionSaid,
      harnessSaid: run.binding.initialHarnessRevisionSaid,
    });
    if (baseline.kind !== 'Read') return { kind: 'Blocked', gate: 'Baseline' };
    const now = () => new Date().toISOString();
    const mandates = await new AuthorizedLocalTaskMandates({
      local: input.local,
      records: new TaskAuthorizationFile(join(input.stateRoot, 'task-authorizations')),
      issuerAid: input.issuerAid,
      userAlias: devrandomUserAlias,
      now: () => Date.now(),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      maximumObservations: 300,
    }).prepare({
      user: input.hosted.user,
      task: input.task,
      presentations: input.hosted.presentations,
      grantExpiresAt: input.hosted.grantExpiresAt,
    });
    if (
      mandates.kind !== 'Prepared' ||
      mandates.executionAuthority.personalAgentAid !== run.binding.personalAgentAid ||
      mandates.summary.taskMandate.credentialSaid !== run.binding.taskMandateSaid ||
      mandates.summary.promotionMandate.credentialSaid !== run.binding.promotionMandateSaid
    )
      return { kind: 'Blocked', gate: 'Authority' };
    const currentMandate = new SignifyTaskToolMandate({
      task: input.task,
      personalAgentAid: run.binding.personalAgentAid,
      mandateRegistryId: mandates.summary.mandateRegistryId,
      taskMandateSaid: run.binding.taskMandateSaid,
      custody: mandates.executionAuthority.taskMandateCustody,
      now,
    });
    const recovery = await reconcileLocalInterruptedCalibration(input, run, mandates);
    if (recovery === 'Rejected') return { kind: 'Blocked', gate: 'InterruptedCalibrationCustody' };
    return await new TaskResumptionComposition({
      stateRoot: input.stateRoot,
      repositoryDirectory: process.cwd(),
      issuerAid: input.issuerAid,
      modelCredential: new EnvironmentPiCredential({
        CONCENTRATE_API_KEY: process.env.CONCENTRATE_API_KEY,
      }),
      childEnvironment: { path: process.env.PATH ?? '', language: 'C' },
      now,
      sessionId: randomUUID,
      modelTurnId: randomUUID,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      linux: input.linux,
    }).resume(
      {
        ownerAid: input.task.ownerAid,
        runId: input.runId,
        activation: pointer.pointer,
        preparation: {
          task: input.task,
          mandates: mandates.summary,
          harness: {
            kind: 'HarnessAdmitted',
            admission: 'Reconciled',
            projection: baseline.projection,
          },
          protectedCredentials: input.hosted.protectedCredentials,
          workAccessRenewal: input.hosted.workAccessRenewal,
          executionAuthority: mandates.executionAuthority,
        },
        runs: input.hosted.runs,
        evidence: input.hosted.evidence,
        authority: {
          verify: async (current) => {
            const fresh = await input.hosted.activationPointer().inspect(input.task.taskId);
            if (
              fresh.kind !== 'Observed' ||
              !isDeepStrictEqual(fresh.pointer, pointer.pointer) ||
              current.binding.personalAgentAid !== mandates.executionAuthority.personalAgentAid ||
              Date.parse(input.hosted.grantExpiresAt) <= Date.now()
            )
              return { kind: 'Rejected' };
            const authority = await currentMandate.inspect({
              taskRevisionSaid: input.task.revisionSaid,
              taskMandateSaid: run.binding.taskMandateSaid,
              tool: 'read_file',
              requiredCapability: 'ReadRepository',
              resource: 'repository://src/lib.rs',
            });
            return { kind: authority.kind === 'Current' ? 'Current' : 'Rejected' };
          },
        },
        successorBehavior: (_context, custody) => {
          const profile = custody.events.find(
            (event) => event.event.kind === 'RunExecutionProfileBound',
          );
          if (
            profile?.event.kind !== 'RunExecutionProfileBound' ||
            profile.event.executionProfileSaid !== input.linux.profile.d
          )
            return undefined;
          const restored = calibrationTranscript(custody);
          return restored.kind === 'Restored'
            ? new RestoredCalibrationBehavior({
                runId: input.runId,
                harnessRevisionSaid: run.binding.initialHarnessRevisionSaid,
                executionProfileSaid: input.linux.profile.d,
                messages: restored.messages,
              })
            : undefined;
        },
      },
      input.signal,
    );
  } catch {
    return { kind: 'Unavailable' };
  }
}
