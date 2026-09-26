import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { decodeHarnessAuthorityProposal } from '@devrandom/protocol';
import { decodeTaskFileBytes } from '../../task/infrastructure/task-file.js';
/** Bounded proposal document adapter; reuse the CLI's strict JSON byte parser, not Task semantics. */
export class JsonHarnessProposalFile {
  async read(path: string): Promise<ReturnType<typeof decodeHarnessAuthorityProposal>> {
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 2 || stat.size > 8192) return { kind: 'Rejected' };
        return decodeHarnessAuthorityProposal(decodeTaskFileBytes(await file.readFile()));
      } finally {
        await file.close();
      }
    } catch {
      return { kind: 'Rejected' };
    }
  }
}
