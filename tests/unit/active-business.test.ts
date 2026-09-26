import { describe, expect, it } from 'vitest';
import { chooseActiveBusiness } from '@/server/tenancy/active-business';
import type { Business } from '@prisma/client';

/**
 * Which business the screens are about.
 *
 * Every page used to take `businesses[0]`, so a workspace with two websites
 * could only reach the first. The choice now comes from a cookie — and a
 * cookie is attacker-supplied input, so the property worth proving is not that
 * switching works but that switching cannot reach anything the session does
 * not already entitle you to.
 */

const business = (id: string): Business => ({ id, name: id }) as Business;

describe('chooseActiveBusiness', () => {
  it('honours a request for one the workspace has', () => {
    const list = [business('a'), business('b')];
    expect(chooseActiveBusiness(list, 'b')?.id).toBe('b');
  });

  it('ignores an id the workspace does not have', () => {
    // The whole security argument: the candidates come from the workspace, so
    // another account's business id selects nothing rather than leaking it.
    const list = [business('a'), business('b')];
    expect(chooseActiveBusiness(list, 'someone-elses-business')?.id).toBe('a');
  });

  it('falls back to the first when nothing is requested', () => {
    expect(chooseActiveBusiness([business('a')], undefined)?.id).toBe('a');
  });

  it('returns null for a workspace with no businesses', () => {
    // Not an error: a new account has none until setup runs.
    expect(chooseActiveBusiness([], undefined)).toBeNull();
    expect(chooseActiveBusiness([], 'anything')).toBeNull();
  });

  it('is not fooled by a junk cookie', () => {
    const list = [business('a')];
    for (const junk of ['', '../../a', 'null', 'undefined']) {
      expect(chooseActiveBusiness(list, junk)?.id).toBe('a');
    }
  });
});
