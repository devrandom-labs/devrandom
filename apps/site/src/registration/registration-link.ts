import {
  registrationCapabilityHeadersSchema,
  registrationPathParametersSchema,
} from '@devrandom/protocol';
import Value from 'typebox/value';

export type RegistrationBrowserLink =
  | {
      readonly kind: 'registration-link';
      readonly registrationId: string;
      readonly capability: string;
    }
  | { readonly kind: 'invalid-registration-link' };

export function parseRegistrationFragment(fragment: string): RegistrationBrowserLink {
  const [path, query, unexpected] = fragment.split('?');
  const match = /^#\/registration\/([a-f0-9]{32})$/u.exec(path ?? '');
  if (match === null || query === undefined || unexpected !== undefined) {
    return { kind: 'invalid-registration-link' };
  }

  const parameters = new URLSearchParams(query);
  if ([...parameters.keys()].length !== 1 || !parameters.has('capability')) {
    return { kind: 'invalid-registration-link' };
  }
  const registrationId = match[1];
  const capability = parameters.get('capability');
  if (
    registrationId === undefined ||
    capability === null ||
    !Value.Check(registrationPathParametersSchema, { registrationId }) ||
    !Value.Check(registrationCapabilityHeadersSchema, {
      'x-devrandom-registration-capability': capability,
    }) ||
    !capability.startsWith('browser_')
  ) {
    return { kind: 'invalid-registration-link' };
  }

  return { kind: 'registration-link', registrationId, capability };
}
