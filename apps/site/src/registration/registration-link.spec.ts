import { describe, expect, it } from 'vitest';

import { parseRegistrationFragment } from './registration-link.ts';

const registrationId = 'a'.repeat(32);
const capability = `browser_${'b'.repeat(43)}`;

describe('registration browser link', () => {
  it('accepts only the exact Registration Session and browser capability fragment', () => {
    expect(
      parseRegistrationFragment(`#/registration/${registrationId}?capability=${capability}`),
    ).toEqual({ kind: 'registration-link', registrationId, capability });
  });

  it.each([
    ['', 'absent fragment'],
    [`#/registration/${registrationId}`, 'missing capability'],
    [`#/registration/${registrationId}?capability=cli_${'c'.repeat(43)}`, 'CLI capability'],
    [
      `#/registration/${registrationId}?capability=${capability}&redirect=https://evil.test`,
      'redirect input',
    ],
    [`#/registration/${registrationId}/success?capability=${capability}`, 'different path'],
  ])('rejects %s (%s)', (fragment) => {
    expect(parseRegistrationFragment(fragment)).toEqual({ kind: 'invalid-registration-link' });
  });
});
