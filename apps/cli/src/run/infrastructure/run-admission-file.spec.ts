import { chmod, lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { governorAid, personalAgentAid } from '@devrandom/identity';
import { decodeRunProjection } from '@devrandom/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  runAdmissionExchangeSaid,
  runCommandId,
  runIncarnationId,
  runProjectionFixture,
} from '../../../test/run-fixture.js';
import { RunAdmissionFile } from './run-admission-file.js';

const directories: string[] = [];
const personalAgent = personalAgentAid('EERMVxqeHfFo_eIvyzBXaKdT1EyobZdSs1QXuFyYLjmz');
const governor = governorAid('EBcIURLpxmVwahksgrsGW6_dUw0zBhyEHYFk17eWrZfk');

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function admissionFile() {
  const directory = await mkdtemp(join(tmpdir(), 'devrandom-run-admission-'));
  directories.push(directory);
  return { directory, file: new RunAdmissionFile(directory) };
}

function binding() {
  const run = admittedRun();
  return {
    ownerAid: run.ownerAid,
    taskId: run.taskId,
    taskRevisionSaid: run.taskRevisionSaid,
    harnessLineageId: run.harnessLineageId,
    harnessRevisionSaid: run.harnessRevisionSaid,
    personalAgentAid: personalAgent,
    taskMandateSaid: run.taskMandateSaid,
    governorAid: governor,
    promotionMandateSaid: run.promotionMandateSaid,
    purpose: run.purpose,
    repository: run.repository,
  };
}

function admittedRun() {
  return {
    ...runProjectionFixture(),
    personalAgentAid: personalAgent,
    governorAid: governor,
  };
}

describe('Run admission file', () => {
  it('reads every existing Task admission without creating or advancing custody', async () => {
    const { directory, file } = await admissionFile();
    const first = {
      ...binding(),
      purpose: {
        kind: 'PreparedCompatibilityCalibration' as const,
        campaignId: '2ae44718-f146-47fc-8507-14b75fd7fa98',
        ordinal: 1 as const,
      },
    };
    await expect(file.inspectTaskAdmissions(first.taskId)).resolves.toEqual({
      kind: 'Found',
      admissions: [],
    });
    await file.acquire(first, {
      commandId: runCommandId,
      incarnationId: runIncarnationId,
      preparedAt: 1,
    });
    const before = await readFile(
      join(directory, `${first.taskId}.${first.purpose.campaignId}.1.json`),
      'utf8',
    );
    await expect(file.inspectTaskAdmissions(first.taskId)).resolves.toMatchObject({
      kind: 'Found',
      admissions: [{ kind: 'PreparingExchange', binding: first }],
    });
    expect(
      await readFile(join(directory, `${first.taskId}.${first.purpose.campaignId}.1.json`), 'utf8'),
    ).toBe(before);
    await chmod(directory, 0o755);
    await expect(file.inspectTaskAdmissions(first.taskId)).resolves.toEqual({
      kind: 'Unavailable',
    });
  });

  it('retains distinct stable command custody for each calibration purpose slot', async () => {
    const { directory, file } = await admissionFile();
    const campaignId = '2ae44718-f146-47fc-8507-14b75fd7fa98';
    const first = {
      ...binding(),
      purpose: {
        kind: 'PreparedCompatibilityCalibration' as const,
        campaignId,
        ordinal: 1 as const,
      },
    };
    const second = {
      ...first,
      purpose: {
        kind: 'PreparedCompatibilityCalibration' as const,
        campaignId,
        ordinal: 2 as const,
      },
    };

    await expect(
      file.acquire(first, {
        commandId: runCommandId,
        incarnationId: runIncarnationId,
        preparedAt: Date.parse('2026-09-24T20:00:00.000Z'),
      }),
    ).resolves.toMatchObject({
      kind: 'Acquired',
      admission: { binding: { purpose: first.purpose } },
    });
    await expect(
      file.acquire(second, {
        commandId: '72be918b-dc59-4969-a9f5-0eac01fe767e',
        incarnationId: '98aa423e-b656-458a-91de-13eacb764ee7',
        preparedAt: Date.parse('2026-09-24T20:01:00.000Z'),
      }),
    ).resolves.toMatchObject({
      kind: 'Acquired',
      admission: { binding: { purpose: second.purpose } },
    });
    await expect(
      readFile(join(directory, `${first.taskId}.${campaignId}.1.json`), 'utf8'),
    ).resolves.toContain(runCommandId);
    await expect(
      readFile(join(directory, `${first.taskId}.${campaignId}.2.json`), 'utf8'),
    ).resolves.toContain('72be918b-dc59-4969-a9f5-0eac01fe767e');
  });

  it('retains the command, exchange, durable Run, and first lease across fresh instances', async () => {
    const { directory, file } = await admissionFile();
    const bound = binding();
    const candidate = {
      commandId: runCommandId,
      incarnationId: runIncarnationId,
      preparedAt: Date.parse('2026-09-24T20:00:00.000Z'),
    };
    const run = admittedRun();
    const lease = {
      version: 1 as const,
      disposition: 'Acquired' as const,
      runId: run.runId,
      incarnationId: runIncarnationId,
      runVersion: 1,
      serverTime: '2026-09-24T20:00:00.000Z',
      expiresAt: '2026-09-24T20:00:45.000Z',
    };

    await expect(file.locateAcceptedRun(bound.taskId)).resolves.toEqual({ kind: 'NotFound' });
    await expect(file.acquire(bound, candidate)).resolves.toMatchObject({
      kind: 'Acquired',
      provenance: 'Created',
      admission: { kind: 'PreparingExchange', ...candidate },
    });
    await expect(
      file.recordExchange(bound, { exchangeSaid: runAdmissionExchangeSaid }),
    ).resolves.toMatchObject({
      kind: 'Acknowledged',
      admission: { kind: 'ExchangePrepared', exchangeSaid: runAdmissionExchangeSaid },
    });
    await expect(file.recordRun(bound, 'Created', run)).resolves.toMatchObject({
      kind: 'Acknowledged',
      admission: { kind: 'RunAccepted', runAdmission: 'Created', run },
    });
    await expect(file.locateAcceptedRun(bound.taskId)).resolves.toEqual({ kind: 'NotAccepted' });
    await expect(file.recordLease(bound, lease)).resolves.toMatchObject({
      kind: 'Acknowledged',
      admission: { kind: 'LeaseAccepted', lease },
    });
    await expect(new RunAdmissionFile(directory).acquire(bound, candidate)).resolves.toMatchObject({
      kind: 'Acquired',
      provenance: 'Recovered',
      admission: { kind: 'LeaseAccepted', run, lease },
    });
    await expect(
      new RunAdmissionFile(directory).locateAcceptedRun(bound.taskId),
    ).resolves.toMatchObject({
      kind: 'Located',
      admission: { kind: 'LeaseAccepted', run, lease },
    });

    const path = join(directory, `${bound.taskId}.json`);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect(await readFile(path, 'utf8')).toContain(run.runId);
    await chmod(directory, 0o755);
    await expect(new RunAdmissionFile(directory).locateAcceptedRun(bound.taskId)).resolves.toEqual({
      kind: 'Unavailable',
    });
  });

  it('locates a leased calibration Run from a fresh status process', async () => {
    const { directory, file } = await admissionFile();
    const purpose = {
      kind: 'PreparedCompatibilityCalibration' as const,
      campaignId: '2ae44718-f146-47fc-8507-14b75fd7fa98',
      ordinal: 1 as const,
    };
    const bound = { ...binding(), purpose };
    const original = admittedRun();
    const run = {
      ...original,
      purpose,
      activation: { ...original.activation, runId: original.runId },
    };
    expect(decodeRunProjection(run)).toMatchObject({ kind: 'Accepted' });
    const candidate = {
      commandId: runCommandId,
      incarnationId: runIncarnationId,
      preparedAt: Date.parse('2026-09-24T20:00:00.000Z'),
    };
    const lease = {
      version: 1 as const,
      disposition: 'Acquired' as const,
      runId: run.runId,
      incarnationId: runIncarnationId,
      runVersion: 1,
      serverTime: '2026-09-24T20:00:00.000Z',
      expiresAt: '2026-09-24T20:00:45.000Z',
    };
    await expect(file.acquire(bound, candidate)).resolves.toMatchObject({ kind: 'Acquired' });
    await expect(
      file.recordExchange(bound, { exchangeSaid: runAdmissionExchangeSaid }),
    ).resolves.toMatchObject({
      kind: 'Acknowledged',
    });
    await expect(file.recordRun(bound, 'Created', run)).resolves.toMatchObject({
      kind: 'Acknowledged',
    });
    await expect(file.recordLease(bound, lease)).resolves.toMatchObject({
      kind: 'Acknowledged',
    });
    await expect(
      new RunAdmissionFile(directory).locateAcceptedRun(bound.taskId),
    ).resolves.toMatchObject({
      kind: 'Located',
      admission: { kind: 'LeaseAccepted', run, lease },
    });

    const secondPurpose = { ...purpose, ordinal: 2 as const };
    const secondBound = { ...bound, purpose: secondPurpose };
    const secondRun = {
      ...run,
      runId: 'b18f5bb3-30b8-4d06-9247-0d593cd74acf',
      commandId: '72be918b-dc59-4969-a9f5-0eac01fe767e',
      evidenceStreamId: '4ab24d43-dd2c-47ea-a377-6420e8f045a2',
      purpose: secondPurpose,
      acceptedAt: '2026-09-24T20:01:00.000Z',
    };
    const secondIncarnationId = '98aa423e-b656-458a-91de-13eacb764ee7';
    const secondLease = {
      ...lease,
      runId: secondRun.runId,
      incarnationId: secondIncarnationId,
      serverTime: '2026-09-24T20:01:00.000Z',
      expiresAt: '2026-09-24T20:01:45.000Z',
    };
    expect(decodeRunProjection(secondRun)).toMatchObject({ kind: 'Accepted' });
    await expect(
      file.acquire(secondBound, {
        commandId: secondRun.commandId,
        incarnationId: secondIncarnationId,
        preparedAt: Date.parse(secondRun.acceptedAt),
      }),
    ).resolves.toMatchObject({ kind: 'Acquired' });
    await expect(
      file.recordExchange(secondBound, { exchangeSaid: runAdmissionExchangeSaid }),
    ).resolves.toMatchObject({
      kind: 'Acknowledged',
    });
    await expect(file.recordRun(secondBound, 'Created', secondRun)).resolves.toMatchObject({
      kind: 'Acknowledged',
    });
    await expect(
      new RunAdmissionFile(directory).locateAcceptedRun(bound.taskId),
    ).resolves.toMatchObject({
      kind: 'Located',
      admission: { kind: 'LeaseAccepted', run, lease },
    });
    await expect(file.recordLease(secondBound, secondLease)).resolves.toMatchObject({
      kind: 'Acknowledged',
    });
    await expect(
      new RunAdmissionFile(directory).locateAcceptedRun(bound.taskId),
    ).resolves.toMatchObject({
      kind: 'Located',
      admission: { kind: 'LeaseAccepted', run: secondRun, lease: secondLease },
    });

    const retainedBound = binding();
    const retainedExchangeSaid = `E${'B'.repeat(43)}`;
    const retainedRun = {
      ...original,
      runId: '5221966c-1170-4b5e-871c-7427e405b421',
      commandId: '369d57b5-bf4d-4adf-9e37-0fd80492b4ed',
      admissionExchangeSaid: retainedExchangeSaid,
      evidenceStreamId: '1b87d80e-f2f7-464a-a605-c3b22ae01847',
      acceptedAt: '2026-09-24T20:05:00.000Z',
    };
    const retainedIncarnationId = '81531456-c952-497b-8edf-9c748fa15827';
    const retainedLease = {
      ...lease,
      runId: retainedRun.runId,
      incarnationId: retainedIncarnationId,
      serverTime: retainedRun.acceptedAt,
      expiresAt: '2026-09-24T20:05:45.000Z',
    };
    expect(decodeRunProjection(retainedRun)).toMatchObject({ kind: 'Accepted' });
    await expect(
      file.acquire(retainedBound, {
        commandId: retainedRun.commandId,
        incarnationId: retainedIncarnationId,
        preparedAt: Date.parse(retainedRun.acceptedAt),
      }),
    ).resolves.toMatchObject({ kind: 'Acquired' });
    await expect(
      file.recordExchange(retainedBound, { exchangeSaid: retainedExchangeSaid }),
    ).resolves.toMatchObject({ kind: 'Acknowledged' });
    await expect(file.recordRun(retainedBound, 'Created', retainedRun)).resolves.toMatchObject({
      kind: 'Acknowledged',
    });
    await expect(file.recordLease(retainedBound, retainedLease)).resolves.toMatchObject({
      kind: 'Acknowledged',
    });
    await expect(
      new RunAdmissionFile(directory).locateAcceptedRun(bound.taskId),
    ).resolves.toMatchObject({
      kind: 'Located',
      admission: { kind: 'LeaseAccepted', run: retainedRun, lease: retainedLease },
    });

    await expect(
      file.acquire(
        {
          ...bound,
          purpose: { ...purpose, campaignId: '3afbf56a-c4d4-4a3f-9ec9-b6d6c96d6f7f' },
        },
        {
          commandId: 'd77944e9-371c-4d87-adce-9d773f76a87d',
          incarnationId: 'fe723a5b-6f88-44b6-991d-1e4355bd97de',
          preparedAt: Date.parse('2026-09-24T20:02:00.000Z'),
        },
      ),
    ).resolves.toMatchObject({ kind: 'Acquired' });
    await expect(new RunAdmissionFile(directory).locateAcceptedRun(bound.taskId)).resolves.toEqual({
      kind: 'Unavailable',
    });
  });

  it('rejects reuse of the Task slot for a different immutable H1 binding', async () => {
    const { file } = await admissionFile();
    const bound = binding();
    const candidate = {
      commandId: runCommandId,
      incarnationId: runIncarnationId,
      preparedAt: Date.parse('2026-09-24T20:00:00.000Z'),
    };
    await file.acquire(bound, candidate);

    await expect(
      file.acquire({ ...bound, harnessRevisionSaid: bound.taskMandateSaid }, candidate),
    ).resolves.toEqual({ kind: 'BindingConflict' });
  });
});
