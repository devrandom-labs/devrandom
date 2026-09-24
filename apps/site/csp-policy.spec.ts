import { describe, expect, it } from 'vitest';

import { staticSiteContentSecurityPolicy } from './csp-policy.js';

describe('static site content security policy', () => {
  it('binds every inline script, style element, and style attribute by content hash', () => {
    const policy = staticSiteContentSecurityPolicy([
      '<script>boot()</script><style>body{margin:0}</style><main style="color:red"></main>',
    ]);

    expect(policy).not.toContain("'unsafe-inline'");
    expect(policy.match(/'sha256-[A-Za-z0-9+/=]+'/gu)).toHaveLength(6);
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).toContain("style-src 'self' 'unsafe-hashes'");
    expect(policy).toContain("style-src-attr 'unsafe-hashes'");
    expect(policy).toContain("'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='");
    expect(policy).toContain("object-src 'none'");
  });

  it('deduplicates identical inline content across exported pages', () => {
    const policy = staticSiteContentSecurityPolicy([
      '<script>boot()</script>',
      '<script>boot()</script>',
    ]);

    const scriptDirective = policy
      .split('; ')
      .find((directive) => directive.startsWith('script-src '));
    expect(scriptDirective?.match(/'sha256-[A-Za-z0-9+/=]+'/gu)).toHaveLength(1);
  });
});
