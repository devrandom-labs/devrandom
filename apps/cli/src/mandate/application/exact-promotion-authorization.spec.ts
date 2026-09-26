import { describe, expect, it } from 'vitest';

import { taskProjectionFixture } from '../../../test/task-source-fixture.js';
import { bindExactPromotionMandate } from './exact-promotion-authorization.js';

describe('post-M promotion authorization boundary', () => {
  it('refuses a forged or mismatched M before local issuance', () => {
    const outcome = bindExactPromotionMandate({
      task: taskProjectionFixture(),
      manifest: { d: 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      initialReadyAuthorization: undefined,
    });
    expect(outcome).toEqual({ kind: 'BindingRejected' });
  });
});
