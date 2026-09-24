import { describe, expect, it } from 'vitest';
import { findHandwrittenStyleSheets, isHandwrittenStyleSheet } from './design-system-boundary.js';

describe('site design-system boundary', () => {
  it('rejects handwritten stylesheet extensions', () => {
    expect(isHandwrittenStyleSheet('registration.css')).toBe(true);
    expect(isHandwrittenStyleSheet('registration.scss')).toBe(true);
    expect(isHandwrittenStyleSheet('registration.tsx')).toBe(false);
  });

  it('finds no handwritten stylesheets in the site source', async () => {
    expect(await findHandwrittenStyleSheets(process.cwd())).toEqual([]);
  });
});
