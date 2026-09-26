import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { EvaluationVerifierBundleInput } from '@devrandom/protocol';
import { cesrPublicConditions, type CesrPublicContract } from '@devrandom/runtime';

const run = promisify(execFile);
const sourceFiles = [
  ['AGENTS.md', '25a051a7f8aca58d5c3efa4e82957d9fbdb305e3f5f235c0018f1f25a96a5540'],
  [
    'tests/current_representation.rs',
    '36c3eb7b8e38a91e0573651cd49cf105788286c4b2ae063b47f3b962567b0866',
  ],
  ['tests/tamper_rejection.rs', '163cdc3480d59d53c76bfd012fabf195c357595ced8b151c91e36ae6da8a064f'],
  [
    'tests/legacy_compatibility.rs',
    'bbd7dd3d3abaacca05376c6920444b476efc2ee8ad3cb977d85dbfb11d38b6a2',
  ],
] as const;

const scopedSourceFiles = [
  ['AGENTS.md', '022ee28e79bb51edd35ffffe4ddcbbd61176da66b7c3917fa5980a65103a3482'],
  [
    'tests/current_representation.rs',
    '36c3eb7b8e38a91e0573651cd49cf105788286c4b2ae063b47f3b962567b0866',
  ],
  ['tests/tamper_rejection.rs', '163cdc3480d59d53c76bfd012fabf195c357595ced8b151c91e36ae6da8a064f'],
  [
    'tests/legacy_compatibility.rs',
    '5ed0e714e1a5af21549caa5c3ebec39b82e139107ce6c8412d0411af8efa5138',
  ],
] as const;

export type CesrPublicCatalogueReview =
  | {
      readonly kind: 'Reviewed';
      readonly publicConditions: EvaluationVerifierBundleInput['publicConditions'];
    }
  | { readonly kind: 'SourceMismatch' | 'Unavailable' };

/** Maps one exact Task source revision's disclosed CESR tests to protected verifier inputs. */
export class VerifiedCesrPublicCatalogue {
  async review(input: {
    readonly sourceDirectory: string;
    readonly sourceGitCommit: string;
    readonly sourceGitTree: string;
  }): Promise<CesrPublicCatalogueReview> {
    try {
      const directory = await realpath(input.sourceDirectory);
      const options = { cwd: directory, maxBuffer: 1024 * 1024 };
      const { stdout: identity } = await run(
        'git',
        ['rev-parse', 'HEAD', 'HEAD^{tree}', '--show-toplevel'],
        options,
      );
      const [commit, tree, top] = identity.trimEnd().split('\n');
      if (commit !== input.sourceGitCommit || tree !== input.sourceGitTree || top !== directory)
        return { kind: 'SourceMismatch' };
      const { stdout: changes } = await run(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        options,
      );
      if (changes.length !== 0) return { kind: 'SourceMismatch' };
      for (const [contract, files] of [
        ['FlatGroups', sourceFiles],
        ['ScopedGroups', scopedSourceFiles],
      ] as const satisfies readonly (readonly [
        CesrPublicContract,
        readonly (readonly [string, string])[],
      ])[]) {
        let matches = true;
        for (const [path, expectedDigest] of files) {
          const file = join(directory, path);
          if (!(await lstat(file)).isFile()) return { kind: 'SourceMismatch' };
          const digest = createHash('sha256')
            .update(await readFile(file))
            .digest('hex');
          if (digest !== expectedDigest) {
            matches = false;
            break;
          }
        }
        if (matches) return { kind: 'Reviewed', publicConditions: cesrPublicConditions(contract) };
      }
      return { kind: 'SourceMismatch' };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
