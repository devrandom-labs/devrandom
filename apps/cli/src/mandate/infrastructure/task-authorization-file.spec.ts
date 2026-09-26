import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  credentialRegistryId,
  governorAid,
  issuerAid,
  personalAgentAid,
  userAid,
} from '@devrandom/identity';
import { afterEach, describe, expect, it } from 'vitest';

import {
  advanceTaskAuthorization,
  beginExactPromotionAuthorization,
  beginTaskAuthorization,
  type TaskAuthorization,
  type TaskAuthorizationAdvancement,
  type TaskAuthorizationBinding,
} from '../domain/task-authorization.js';
import { TaskAuthorizationFile, TaskAuthorizationFileFailure } from './task-authorization-file.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function authorizationFile(): Promise<{
  readonly directory: string;
  readonly file: TaskAuthorizationFile;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'devrandom-task-authorization-'));
  directories.push(directory);
  return { directory, file: new TaskAuthorizationFile(directory) };
}

const binding: TaskAuthorizationBinding = {
  ownerAid: userAid('EMstL6Th90iB6MpQkPjKN2ii7a5XcvA_PCHWHrAAD-l4'),
  taskId: '0196b3df-41f0-4e86-97e5-36e9c6558171',
  taskRevisionSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
  harnessLineageId: '66dcf5cc-7733-4421-a226-91d5d91abb06',
  personalAgentAid: personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz'),
  governorAid: governorAid('EJlw5Fw9LKH1CYFEkGiDUlx0cHozvXb7hfqhSoMsH6bs'),
  issuerAid: issuerAid('EHcQUn2xY9KN1yv6FP0c6-pxej14Z8JDD3IYLddg0wOh'),
  mandateRegistryId: credentialRegistryId('EBdHrbtS_iH9Oe9IH-3UDsHYNuWpwrtnkDzO5fKrITyK'),
};

function begun(): TaskAuthorization {
  const beginning = beginTaskAuthorization(binding, Date.parse('2026-09-24T12:00:00.000Z'));
  if (beginning.kind === 'Rejected') {
    throw new Error(`Task authorization fixture rejected: ${beginning.reason}`);
  }
  return beginning.authorization;
}

function advance(
  authorization: TaskAuthorization,
  advancement: TaskAuthorizationAdvancement,
): TaskAuthorization {
  const transition = advanceTaskAuthorization(authorization, advancement);
  if (transition.kind === 'Rejected') {
    throw new Error(`Task authorization fixture rejected: ${transition.reason}`);
  }
  return transition.authorization;
}

describe('task authorization file', () => {
  it('durably recovers the exact stable protocol event before external issuance', async () => {
    const { directory, file } = await authorizationFile();
    const authorization = begun();

    await file.commit(undefined, authorization);

    await expect(file.read(binding.taskId)).resolves.toEqual(authorization);
    const path = join(directory, `${binding.taskId}.json`);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(await readFile(path, 'utf8')).toContain(String(Date.parse('2026-09-24T12:00:00.000Z')));
  });

  it('rejects a changed task binding and a skipped protocol stage', async () => {
    const { file } = await authorizationFile();
    const initial = begun();
    await file.commit(undefined, initial);

    const changedBinding: TaskAuthorization = {
      ...initial,
      revision: 1,
      binding: {
        ...initial.binding,
        taskRevisionSaid: 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho',
      },
    };
    await expect(file.commit(0, changedBinding)).rejects.toMatchObject({
      detail: { kind: 'TaskAuthorizationBindingConflict' },
    });

    const submitted = advance(initial, {
      kind: 'CredentialIssuanceSubmitted',
      credentialSaid: 'EJfV6u6VYnrXdWGv1JNLb7AZCv6n-rBN_zpoMhFdAwqG',
      operationName: 'operation.task-mandate.issue',
    });
    const materialized = advance(submitted, {
      kind: 'CredentialMaterialized',
      credentialSaid: 'EJfV6u6VYnrXdWGv1JNLb7AZCv6n-rBN_zpoMhFdAwqG',
    });
    await expect(file.commit(0, materialized)).rejects.toMatchObject({
      detail: { kind: 'TaskAuthorizationTransitionConflict' },
    });
  });

  it('rejects stale CAS and a task identifier that could escape the state directory', async () => {
    const { file } = await authorizationFile();
    const initial = begun();
    await file.commit(undefined, initial);

    await expect(file.commit(undefined, initial)).rejects.toMatchObject({
      detail: { kind: 'TaskAuthorizationConflict' },
    });
    await expect(file.read('../local-governance')).rejects.toBeInstanceOf(
      TaskAuthorizationFileFailure,
    );
    await expect(file.read('../local-governance')).rejects.toMatchObject({
      detail: { kind: 'TaskAuthorizationInvalid' },
    });
  });

  it('recovers both admitted mandates with every known protocol operation from a new file instance', async () => {
    const { directory, file } = await authorizationFile();
    let authorization = begun();
    await file.commit(undefined, authorization);

    const retain = async (advancement: TaskAuthorizationAdvancement): Promise<void> => {
      const previous = authorization;
      authorization = advance(previous, advancement);
      await file.commit(previous.revision, authorization);
    };

    for (const advancement of mandateAdvancements({
      credentialSaid: 'EJfV6u6VYnrXdWGv1JNLb7AZCv6n-rBN_zpoMhFdAwqG',
      holderGrantSaid: 'EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk',
      holderAdmitSaid: 'EOiOyOhb0YSm2r84POPLVrHAwb1B81LZZH80gQGKjjho',
      serverGrantSaid: 'EOb-FtVoyOOKTAf9GVdIlmfiSL53StlAY8vobkPRdmt4',
      operationStem: 'task-mandate',
      preparedAt: Date.parse('2026-09-24T12:01:00.000Z'),
      holderAdmission: 'RecoveredWithoutOperation',
      admittedAt: '2026-09-24T12:02:00.000Z',
      presentationExpiresAt: '2026-09-24T15:00:00.000Z',
    })) {
      await retain(advancement);
    }
    await retain({
      kind: 'PreparePromotionIssuance',
      issuedAt: Date.parse('2026-09-24T12:03:00.000Z'),
    });
    for (const advancement of mandateAdvancements({
      credentialSaid: 'EKpF-o0Kugy4bWn2hTwbyAEMxUNBmJLxTKPxjHsOtD9U',
      holderGrantSaid: 'ELUZ5cWnQGL5w1h9M8uZF5bXq_kP7gYBItwSCtYc0qRV',
      holderAdmitSaid: 'EM8udYCqERfzgyNX4U8fP8UipI1Fgm7JdcQDDUxGl1ou',
      serverGrantSaid: 'ENFw9EZDRLli6aoMFSUUeMu_j7b7T0UBiq2MLiRcx_gz',
      operationStem: 'promotion-mandate',
      preparedAt: Date.parse('2026-09-24T12:04:00.000Z'),
      holderAdmission: 'OperationRecorded',
      admittedAt: '2026-09-24T12:05:00.000Z',
      presentationExpiresAt: '2026-09-24T15:00:00.000Z',
    })) {
      await retain(advancement);
    }

    expect(authorization.stage.kind).toBe('Ready');
    if (authorization.stage.kind !== 'Ready') {
      throw new Error('Expected ready authorization fixture');
    }
    expect(authorization.stage.taskMandate.credential.issuance).toEqual({
      kind: 'OperationRecorded',
      operationName: 'task-mandate.issue',
    });
    expect(authorization.stage.taskMandate.holderAdmission.submission).toEqual({
      kind: 'RecoveredWithoutOperation',
    });
    expect(authorization.stage.taskMandate.admission).toEqual({
      kind: 'OperationRecorded',
      operationName: 'task-mandate.server-admit',
    });
    expect(authorization.stage.promotionMandate.holderAdmission.submission).toEqual({
      kind: 'OperationRecorded',
      operationName: 'promotion-mandate.holder-admit',
    });
    await expect(new TaskAuthorizationFile(directory).read(binding.taskId)).resolves.toEqual(
      authorization,
    );
    const manifestSaid = 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const exactDirectory = join(directory, 'exact-promotion', manifestSaid);
    const ready = { ...authorization, stage: authorization.stage };
    const exactBeginning = beginExactPromotionAuthorization(
      ready,
      manifestSaid,
      Date.parse('2026-09-24T12:06:00.000Z'),
    );
    if (exactBeginning.kind !== 'Begun') throw new Error(exactBeginning.reason);
    const exactFile = new TaskAuthorizationFile(exactDirectory, ready);
    await exactFile.commit(undefined, exactBeginning.authorization);
    await expect(new TaskAuthorizationFile(exactDirectory).read(binding.taskId)).resolves.toEqual(
      exactBeginning.authorization,
    );
    expect((await lstat(exactDirectory)).mode & 0o777).toBe(0o700);
    await expect(
      new TaskAuthorizationFile(join(directory, 'unbound-exact')).commit(
        undefined,
        exactBeginning.authorization,
      ),
    ).rejects.toMatchObject({ detail: { kind: 'TaskAuthorizationTransitionConflict' } });
  });
});

interface MandateAdvancementFixture {
  readonly credentialSaid: string;
  readonly holderGrantSaid: string;
  readonly holderAdmitSaid: string;
  readonly serverGrantSaid: string;
  readonly operationStem: string;
  readonly preparedAt: number;
  readonly holderAdmission: 'OperationRecorded' | 'RecoveredWithoutOperation';
  readonly admittedAt: string;
  readonly presentationExpiresAt: string;
}

function mandateAdvancements(
  fixture: MandateAdvancementFixture,
): readonly TaskAuthorizationAdvancement[] {
  const holderAdmission: TaskAuthorizationAdvancement =
    fixture.holderAdmission === 'OperationRecorded'
      ? {
          kind: 'HolderAdmissionSubmitted',
          admitSaid: fixture.holderAdmitSaid,
          operationName: `${fixture.operationStem}.holder-admit`,
        }
      : { kind: 'HolderAdmissionRecovered', admitSaid: fixture.holderAdmitSaid };
  return [
    {
      kind: 'CredentialIssuanceSubmitted',
      credentialSaid: fixture.credentialSaid,
      operationName: `${fixture.operationStem}.issue`,
    },
    { kind: 'CredentialMaterialized', credentialSaid: fixture.credentialSaid },
    { kind: 'PrepareHolderGrant', preparedAt: fixture.preparedAt },
    { kind: 'HolderGrantPrepared', grantSaid: fixture.holderGrantSaid },
    { kind: 'HolderGrantSubmitted', operationName: `${fixture.operationStem}.holder-grant` },
    { kind: 'HolderGrantMaterialized' },
    { kind: 'PrepareHolderAdmission', preparedAt: fixture.preparedAt + 1 },
    holderAdmission,
    { kind: 'HolderVerified' },
    { kind: 'PrepareServerGrant', preparedAt: fixture.preparedAt + 2 },
    { kind: 'ServerGrantPrepared', grantSaid: fixture.serverGrantSaid },
    { kind: 'ServerGrantSubmitted', operationName: `${fixture.operationStem}.server-grant` },
    { kind: 'ServerGrantMaterialized' },
    {
      kind: 'ServerPresentationAwaitingGrant',
      presentationExpiresAt: fixture.presentationExpiresAt,
    },
    {
      kind: 'ServerPresentationAdmitting',
      presentationExpiresAt: fixture.presentationExpiresAt,
      operationName: `${fixture.operationStem}.server-admit`,
    },
    {
      kind: 'ServerAdmitted',
      presentationExpiresAt: fixture.presentationExpiresAt,
      admittedAt: fixture.admittedAt,
    },
  ];
}
