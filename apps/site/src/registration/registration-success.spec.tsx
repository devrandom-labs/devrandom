import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RegistrationSuccess } from './registration-success.tsx';

describe('registration success page', () => {
  it('reports issuer delivery without claiming local CLI admission', () => {
    const html = renderToStaticMarkup(<RegistrationSuccess />);

    expect(html).toContain('credential was issued');
    expect(html).toContain('return to your terminal');
    expect(html).not.toContain('identity is verified');
    expect(html).not.toContain('Devrandom is ready');
  });
});
