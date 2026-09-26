import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { EvaluationVerifierBundleInput } from '@devrandom/protocol';

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

type Conditions = EvaluationVerifierBundleInput['publicConditions'];
type Expected = Conditions[number]['expected'];
const first = 'EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRST';
const second = 'EABCDefghijk0123456789-_ABCDEFGHIJKLMNOPQRSU';

function condition(id: string, stimulus: string, expected: Expected): Conditions[number] {
  return { id, stimulusBase64Url: Buffer.from(stimulus).toString('base64url'), expected };
}

function rejected(
  error: 'AnyRejection' | 'InvalidFrame' | 'InvalidPayload' | 'UnsupportedVersion',
) {
  return { kind: 'Rejected', error } as const;
}

/** The 14 original public assertions, including their explicit negative error classes. */
function disclosedConditions(): Conditions {
  return [
    condition('cesr-current-direct-unmarked', `-AAN-_AAACAA${first}-AAL${first}`, {
      kind: 'Parsed',
      receipts: [
        { version: 'Current', payload: first },
        { version: 'Current', payload: first },
      ],
    }),
    condition('cesr-tamper-count-mismatch', `-AAM-_AAACAA${first}`, rejected('AnyRejection')),
    condition(
      'cesr-tamper-truncated-payload',
      `-AAN-_AAACAA${first.slice(0, 40)}`,
      rejected('AnyRejection'),
    ),
    condition('cesr-tamper-extra-bytes', `-AAN-_AAACAA${first}!`, rejected('AnyRejection')),
    condition('cesr-tamper-unsupported-version', `-AAN-_AAADAA${first}`, rejected('AnyRejection')),
    condition(
      'cesr-tamper-invalid-payload',
      `-AAL${first.replace('E', '!')}`,
      rejected('AnyRejection'),
    ),
    condition('cesr-tamper-empty-group', '-AAA', rejected('AnyRejection')),
    condition('cesr-tamper-marker-without-payload', '-AAC-_AAABAA', rejected('AnyRejection')),
    condition('cesr-tamper-malformed-first-group', `-AAA-AAL${first}`, rejected('AnyRejection')),
    condition(
      'cesr-legacy-two-payloads-then-default',
      `-AAY-_AAABAA${first}${second}-AAL${first}`,
      {
        kind: 'Parsed',
        receipts: [
          { version: 'Legacy', payload: first },
          { version: 'Legacy', payload: second },
          { version: 'Current', payload: first },
        ],
      },
    ),
    condition(
      'cesr-legacy-partial-second-payload',
      `-AAY-_AAABAA${first}${second.slice(0, 40)}`,
      rejected('InvalidFrame'),
    ),
    condition(
      'cesr-legacy-bad-group-count',
      `-AAX-_AAABAA${first}${second}`,
      rejected('AnyRejection'),
    ),
    condition(
      'cesr-legacy-unsupported-marker',
      `-AAY-_AAADAA${first}${second}`,
      rejected('UnsupportedVersion'),
    ),
    condition(
      'cesr-legacy-invalid-second-payload',
      `-AAY-_AAABAA${first}${second.replace('E', '!')}`,
      rejected('InvalidPayload'),
    ),
  ];
}

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
      for (const [path, expectedDigest] of sourceFiles) {
        const file = join(directory, path);
        if (!(await lstat(file)).isFile()) return { kind: 'SourceMismatch' };
        const digest = createHash('sha256')
          .update(await readFile(file))
          .digest('hex');
        if (digest !== expectedDigest) return { kind: 'SourceMismatch' };
      }
      return { kind: 'Reviewed', publicConditions: disclosedConditions() };
    } catch {
      return { kind: 'Unavailable' };
    }
  }
}
