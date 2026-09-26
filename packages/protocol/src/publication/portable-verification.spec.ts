import { describe, expect, it } from 'vitest';
import { prepareEvidenceArtifact } from '../evidence/evidence-artifact.js';
import {
  decodePortableHarnessVerification,
  preparePortableHarnessVerification,
} from './portable-verification.js';
const packageSaid = `E${'a'.repeat(43)}`;
function fixture() {
  const bytes = Buffer.from('{"kind":"PublicReferenceObservation","exitCode":0}');
  const artifact = prepareEvidenceArtifact(bytes, 'application/json');
  if (artifact.kind !== 'Prepared') throw new Error('artifact');
  return {
    packageSaid,
    checks: [
      'Sanitization',
      'CapabilityIsolation',
      'PortableBehavior',
      'FreshPublicVerification',
      'ProtectedRegression',
    ].map((name) => ({ name, evidenceSaid: artifact.artifact.d })),
    rawEvidence: [{ artifact: artifact.artifact, bytesBase64Url: bytes.toString('base64url') }],
  };
}
describe('signed portable verification content binding', () => {
  it('requires all five proof obligations with exact addressable raw evidence and package identity', () => {
    const input = fixture();
    const prepared = preparePortableHarnessVerification(input);
    expect(prepared.kind).toBe('Prepared');
    if (prepared.kind !== 'Prepared') throw new Error('verification');
    expect(decodePortableHarnessVerification(prepared.verification, packageSaid).kind).toBe(
      'Accepted',
    );
    expect(
      decodePortableHarnessVerification(prepared.verification, `E${'b'.repeat(43)}`).kind,
    ).toBe('Rejected');
    expect(
      preparePortableHarnessVerification({ ...input, checks: input.checks.slice(0, 4) }).kind,
    ).toBe('Rejected');
    expect(
      preparePortableHarnessVerification({
        ...input,
        rawEvidence: input.rawEvidence.map((entry) => ({
          ...entry,
          bytesBase64Url: Buffer.from('forged').toString('base64url'),
        })),
      }).kind,
    ).toBe('Rejected');
    expect(preparePortableHarnessVerification({ ...input, rawEvidence: [] }).kind).toBe('Rejected');
  });
});
