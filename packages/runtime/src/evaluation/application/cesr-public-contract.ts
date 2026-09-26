import type { EvaluationVerifierBundleInput } from '@devrandom/protocol';

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
function flatConditions(): Conditions {
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

export type CesrPublicContract = 'FlatGroups' | 'ScopedGroups';

function frame(body: string, large = false): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let count = body.length / 4;
  let digits = '';
  for (let index = 0; index < (large ? 5 : 2); index += 1) {
    digits = alphabet.charAt(count % 64) + digits;
    count = Math.floor(count / 64);
  }
  return `${large ? '--A' : '-A'}${digits}${body}`;
}

function scopedConditions(): Conditions {
  const inherited = frame(first);
  const overridden = frame(`-_AAACAA${second}`, true);
  const restored = frame(second, true);
  const outer = frame(`-_AAABAA${inherited}${overridden}${restored}${first}`, true);
  const legacy = frame(`-_AAABAA${second}`);
  let deepest = first;
  for (let depth = 0; depth < 64; depth += 1) deepest = frame(deepest);
  const invalid = [
    frame(`-AAM${first}`, true),
    frame(`${first}-_AAABAA${second}`),
    frame('-AAA'),
    frame('-AAC-_AAABAA', true),
    frame(frame(`-_AAADAA${first}`)),
    `--A_____${first}`,
    `--AAA!AL${first}`,
    `--AAAAAL${first}!`,
    `-_AAABAA${frame(first)}`,
    `-AéA${first}`,
    // Byte length is 44; this intentionally exercises non-ASCII payload rejection.
    `-AAL${'E' + 'A'.repeat(40) + 'éA'}`,
  ];
  return [
    ...flatConditions(),
    ...(
      [
        ['small', 2],
        ['boundary', 373],
      ] as const
    ).map(([name, count]) =>
      condition(`cesr-scoped-large-${name}`, frame(`-_AAABAA${first.repeat(count)}`, true), {
        kind: 'Parsed',
        receipts: Array.from({ length: count }, () => ({
          version: 'Legacy' as const,
          payload: first,
        })),
      }),
    ),
    condition('cesr-scoped-inherit-override-restore', outer + frame(first), {
      kind: 'Parsed',
      receipts: [
        { version: 'Legacy', payload: first },
        { version: 'Current', payload: second },
        { version: 'Legacy', payload: second },
        { version: 'Legacy', payload: first },
        { version: 'Current', payload: first },
      ],
    }),
    condition('cesr-scoped-legacy-child', frame(`${first}${legacy}${first}`), {
      kind: 'Parsed',
      receipts: [
        { version: 'Current', payload: first },
        { version: 'Legacy', payload: second },
        { version: 'Current', payload: first },
      ],
    }),
    ...invalid.map((stimulus, index) =>
      condition(`cesr-scoped-invalid-${String(index)}`, stimulus, rejected('AnyRejection')),
    ),
    condition('cesr-scoped-maximum-depth', deepest, {
      kind: 'Parsed',
      receipts: [{ version: 'Current', payload: first }],
    }),
    condition('cesr-scoped-excessive-depth', frame(deepest), rejected('AnyRejection')),
  ];
}

/** Evaluation owns the complete disclosed oracle surface for each reviewed Task contract. */
export function cesrPublicConditions(contract: CesrPublicContract): Conditions {
  return contract === 'FlatGroups' ? flatConditions() : scopedConditions();
}

/** Select by every disclosed stimulus and expectation, never an untrusted contract flag. */
export function matchCesrPublicContract(conditions: Conditions): CesrPublicContract | undefined {
  for (const contract of ['FlatGroups', 'ScopedGroups'] as const) {
    const expected = cesrPublicConditions(contract);
    if (
      conditions.length === expected.length &&
      conditions.every((actual, index) => {
        const known = expected[index];
        if (
          known === undefined ||
          actual.id !== known.id ||
          actual.stimulusBase64Url !== known.stimulusBase64Url
        )
          return false;
        if (actual.expected.kind === 'Rejected')
          return (
            known.expected.kind === 'Rejected' && actual.expected.error === known.expected.error
          );
        return (
          known.expected.kind === 'Parsed' &&
          actual.expected.receipts.length === known.expected.receipts.length &&
          actual.expected.receipts.every((receipt, ordinal) => {
            if (known.expected.kind !== 'Parsed') return false;
            const retained = known.expected.receipts[ordinal];
            return (
              retained !== undefined &&
              receipt.version === retained.version &&
              receipt.payload === retained.payload
            );
          })
        );
      })
    )
      return contract;
  }
  return undefined;
}
