import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  decodeEvaluationExecutionProfile,
  decodeEvaluationPolicy,
  decodeEvaluationSourceInventory,
  type EvaluationExecutionProfile,
  type EvaluationPolicy,
  type EvaluationSourceInventory,
} from '@devrandom/protocol';

const maximumDocumentBytes = 64 * 1024;

export type EvaluationPolicyReading =
  | {
      readonly kind: 'Read';
      readonly policy: EvaluationPolicy;
      readonly profile: EvaluationExecutionProfile;
      readonly inventory: EvaluationSourceInventory;
    }
  | { readonly kind: 'Rejected' };

async function readBoundedJson(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await file.stat();
    if (!status.isFile() || status.size < 2 || status.size > maximumDocumentBytes) {
      throw new Error('Evaluation document size or type invalid');
    }
    return JSON.parse(await file.readFile({ encoding: 'utf8' })) as unknown;
  } finally {
    await file.close();
  }
}

/** The policy names exact immutable siblings; paths never come from a hosted response. */
export class EvaluationPolicyFile {
  async read(path: string): Promise<EvaluationPolicyReading> {
    try {
      const decodedPolicy = decodeEvaluationPolicy(await readBoundedJson(path));
      if (decodedPolicy.kind !== 'Accepted') return { kind: 'Rejected' };
      const policy = decodedPolicy.policy;
      const directory = dirname(path);
      const [profileDocument, inventoryDocument] = await Promise.all([
        readBoundedJson(join(directory, `${policy.executionProfileSaid}.json`)),
        readBoundedJson(join(directory, `${policy.sourceInventorySaid}.json`)),
      ]);
      const profile = decodeEvaluationExecutionProfile(profileDocument);
      const inventory = decodeEvaluationSourceInventory(inventoryDocument);
      if (
        profile.kind !== 'Accepted' ||
        inventory.kind !== 'Accepted' ||
        profile.profile.d !== policy.executionProfileSaid ||
        inventory.inventory.d !== policy.sourceInventorySaid ||
        inventory.inventory.taskId !== policy.taskId ||
        inventory.inventory.taskRevisionSaid !== policy.taskRevisionSaid
      ) {
        return { kind: 'Rejected' };
      }
      return {
        kind: 'Read',
        policy,
        profile: profile.profile,
        inventory: inventory.inventory,
      };
    } catch {
      return { kind: 'Rejected' };
    }
  }
}
