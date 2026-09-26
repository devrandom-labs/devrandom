import { join } from 'node:path';

import type { CalibrationCampaignHistory } from '../application/verified-failure-campaign.js';
import { PreparedCompatibilityCalibrationFile } from '../../run/infrastructure/prepared-compatibility-calibration-file.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const said = /^[A-Z][A-Za-z0-9_-]{43}$/u;

/** The local campaign index supplies IDs only; hosted Run/evidence remains authoritative. */
export class PreparedCompatibilityCampaignHistoryFile implements CalibrationCampaignHistory {
  readonly #stateRoot: string;

  constructor(stateRoot: string) {
    this.#stateRoot = stateRoot;
  }

  async read(input: {
    readonly taskId: string;
    readonly harnessRevisionSaid: string;
  }): ReturnType<CalibrationCampaignHistory['read']> {
    if (!uuid.test(input.taskId) || !said.test(input.harnessRevisionSaid)) {
      return { kind: 'Unavailable' };
    }
    const file = new PreparedCompatibilityCalibrationFile(
      join(this.#stateRoot, 'calibration', input.taskId, input.harnessRevisionSaid),
    );
    const reading = await file.load();
    if (reading.kind === 'NotFound') return { kind: 'Missing' };
    if (reading.kind !== 'Loaded') return { kind: 'Unavailable' };
    const attempts = reading.record.attempts;
    if (attempts.length !== 5 || attempts.some((attempt) => attempt.kind === 'Rejected')) {
      return { kind: 'Missing' };
    }
    return { kind: 'Found', runIds: attempts.map((attempt) => attempt.runId) };
  }
}
