import { describe, expect, it } from 'vitest';

import { browserInvocation } from './system-browser.js';

const registrationUrl =
  'http://127.0.0.1:3210/#/registration/0123456789abcdef0123456789abcdef?capability=browser_0123456789abcdefghijklmnopqrstuvwxyz';

describe('system browser presentation', () => {
  it('uses an argument vector rather than a shell on supported desktop platforms', () => {
    expect(browserInvocation('darwin', registrationUrl)).toEqual({
      executable: 'open',
      arguments: [registrationUrl],
    });
    expect(browserInvocation('linux', registrationUrl)).toEqual({
      executable: 'xdg-open',
      arguments: [registrationUrl],
    });
    expect(browserInvocation('win32', registrationUrl)).toEqual({
      executable: 'rundll32.exe',
      arguments: ['url.dll,FileProtocolHandler', registrationUrl],
    });
  });
});
