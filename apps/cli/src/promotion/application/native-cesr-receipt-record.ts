import { isDeepStrictEqual } from 'node:util';

import { cesrVerifierObservationSchema } from '@devrandom/protocol';
import Type from 'typebox';
import Value from 'typebox/value';

const said = Type.String({ pattern: '^[A-Z][A-Za-z0-9_-]{43}$' });
const receiptRecordSchema = Type.Object(
  {
    executableSaid: said,
    stimulusSaid: said,
    caseScope: Type.Union([Type.Literal('Public'), Type.Literal('Protected')]),
    observation: cesrVerifierObservationSchema,
    stdout: Type.String({ maxLength: 512 * 1024 }),
    effectiveLimitsDigest: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  },
  { additionalProperties: false },
);

function parseNativeStdout(stdout: string): unknown {
  const text = stdout.trimEnd();
  if (text.startsWith('DV1|P|') && !text.includes('\n')) {
    const raw = text.slice(6);
    const receipts =
      raw === ''
        ? []
        : raw.split(',').map((part) => {
            const fields = part.split(':');
            const version = fields[0];
            const payload = fields[1];
            if (
              fields.length !== 2 ||
              (version !== 'Legacy' && version !== 'Current') ||
              payload === undefined ||
              !/^[A-Z][A-Za-z0-9_-]{43}$/u.test(payload)
            )
              throw new Error('invalid native receipt');
            return { version, payload };
          });
    return { kind: 'Parsed', receipts };
  }
  const rejected = /^DV1\|R\|(InvalidFrame|InvalidPayload|UnsupportedVersion)$/u.exec(text);
  if (rejected?.[1] !== undefined) return { kind: 'Rejected', error: rejected[1] };
  return undefined;
}

/** Replays the exact native receipt stdout; JSON observation alone is not a grade. */
export function interpretNativeCesrReceiptRecord(
  candidate: unknown,
  binding: {
    readonly caseScope: 'Public' | 'Protected';
    readonly executableSaid: string;
    readonly stimulusSaid: string;
  },
):
  | {
      readonly kind: 'Interpreted';
      readonly observation: Type.Static<typeof cesrVerifierObservationSchema>;
    }
  | { readonly kind: 'Invalid' } {
  if (
    !Value.Check(receiptRecordSchema, candidate) ||
    candidate.caseScope !== binding.caseScope ||
    candidate.executableSaid !== binding.executableSaid ||
    candidate.stimulusSaid !== binding.stimulusSaid
  )
    return { kind: 'Invalid' };
  try {
    return isDeepStrictEqual(parseNativeStdout(candidate.stdout), candidate.observation)
      ? { kind: 'Interpreted', observation: candidate.observation }
      : { kind: 'Invalid' };
  } catch {
    return { kind: 'Invalid' };
  }
}
