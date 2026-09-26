import { isAbsolute, join } from 'node:path';
import type { CalibrationCampaignRecords } from '../application/calibration-campaign-progress.js';
import type { CompatibilityCalibrationRecordReading } from '../application/prepared-compatibility-calibration.js';
import { PreparedCompatibilityCalibrationFile } from './prepared-compatibility-calibration-file.js';

/** Selects the existing local settlement index by exact Task and Harness identities. */
export class FileCalibrationCampaignRecords implements CalibrationCampaignRecords {
  readonly #stateRoot: string;
  constructor(stateRoot: string) {
    this.#stateRoot = stateRoot;
  }
  read(
    taskId: string,
    harnessRevisionSaid: string,
  ): Promise<CompatibilityCalibrationRecordReading> {
    if (
      !isAbsolute(this.#stateRoot) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(taskId) ||
      !/^[A-Z][A-Za-z0-9_-]{43}$/u.test(harnessRevisionSaid)
    )
      return Promise.resolve({ kind: 'Corrupt' });
    return new PreparedCompatibilityCalibrationFile(
      join(this.#stateRoot, 'calibration', taskId, harnessRevisionSaid),
    ).load();
  }
}
