import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import {
  SESSION_TTL_MS,
  createSession,
  destroyAllUserSessions,
  destroySession,
  hashSessionToken,
  purgeExpiredSessions,
  resolveSession,
} from '@/server/auth/session';
import { loginUser, registerUser } from '@/server/auth/service';
import { resetDatabase, createTestUser } from '../helpers/db';

beforeEach(resetDatabase);

describe('registration', () => {
  it('creates the user, a workspace, and an OWNER membership', async () => {
    const { user, token } = await registerUser({
      email: 'Owner@Example.Test',
      password: 'correct-horse-battery-staple',
      name: 'Owner',
    });

    expect(user.email).toBe('owner@example.test'); // normalised
    expect(token).toBeTruthy();

    const membership = await prisma.workspaceMembership.findFirst({
      where: { userId: user.id },
      include: { workspace: true },
    });
    expect(membership?.role).toBe('OWNER');
    expect(membership?.workspace.name).toBe("Owner's Workspace");
    expect(membership?.workspace.slug).toBe('owners-workspace');
  });

  it('never stores the password in plaintext', async () => {
    const { user } = await registerUser({
      email: 'plain@example.test',
      password: 'correct-horse-battery-staple',
      name: 'Plain',
    });

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.passwordHash).not.toContain('correct-horse');
    expect(stored.passwordHash.startsWith('scrypt$')).toBe(true);
  });

  it('rejects a duplicate email regardless of case', async () => {
    await registerUser({
      email: 'dup@example.test',
      password: 'correct-horse-battery-staple',
      name: 'First',
    });

    await expect(
      registerUser({
        email: 'DUP@example.test',
        password: 'correct-horse-battery-staple',
        name: 'Second',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects a malformed email', async () => {
    await expect(
      registerUser({ email: 'nope', password: 'correct-horse-battery-staple', name: 'X' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('gives each workspace a unique slug when names collide', async () => {
    await registerUser({
      email: 'a@example.test',
      password: 'correct-horse-battery-staple',
      name: 'Sam',
      workspaceName: 'Acme',
    });
    await registerUser({
      email: 'b@example.test',
      password: 'correct-horse-battery-staple',
      name: 'Kim',
      workspaceName: 'Acme',
    });

    const slugs = (await prisma.workspace.findMany({ select: { slug: true } })).map((w) => w.slug);
    expect(new Set(slugs).size).toBe(2);
  });

  it('writes an audit entry', async () => {
    const { user } = await registerUser({
      email: 'audit@example.test',
      password: 'correct-horse-battery-staple',
      name: 'Audited',
    });

    const entry = await prisma.auditLog.findFirst({ where: { actorId: user.id } });
    expect(entry?.action).toBe('user.registered');
    expect(entry?.actorType).toBe('USER');
  });
});

describe('login', () => {
  const password = 'correct-horse-battery-staple';

  beforeEach(async () => {
    await registerUser({ email: 'known@example.test', password, name: 'Known' });
  });

  it('succeeds with the correct password and opens a session', async () => {
    const { user, token } = await loginUser({ email: 'known@example.test', password });
    const resolved = await resolveSession(token);

    expect(resolved?.user.id).toBe(user.id);
  });

  it('rejects a wrong password', async () => {
    await expect(
      loginUser({ email: 'known@example.test', password: 'wrong-but-long-enough' }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('gives an unknown email the same error as a wrong password', async () => {
    const unknown = await loginUser({ email: 'nobody@example.test', password }).catch((e) => e);
    const wrong = await loginUser({
      email: 'known@example.test',
      password: 'wrong-but-long-enough',
    }).catch((e) => e);

    // Identical code and message: the response must not reveal which emails exist.
    expect(unknown.code).toBe(wrong.code);
    expect(unknown.publicMessage).toBe(wrong.publicMessage);
  });
});

describe('sessions', () => {
  it('stores only a hash of the token, never the token itself', async () => {
    const user = await createTestUser();
    const { token, session } = await createSession({ userId: user.id });

    expect(session.tokenHash).not.toBe(token);
    expect(session.tokenHash).toBe(hashSessionToken(token));

    const rows = await prisma.$queryRaw<
      Array<{ token_hash: string }>
    >`SELECT "tokenHash" AS token_hash FROM sessions`;
    expect(rows[0]?.token_hash).not.toContain(token);
  });

  it('resolves a valid token to its user', async () => {
    const user = await createTestUser();
    const { token } = await createSession({ userId: user.id });

    expect((await resolveSession(token))?.user.id).toBe(user.id);
  });

  it('returns null for absent, empty and unknown tokens', async () => {
    await expect(resolveSession(undefined)).resolves.toBeNull();
    await expect(resolveSession('')).resolves.toBeNull();
    await expect(resolveSession('a-token-that-was-never-issued')).resolves.toBeNull();
  });

  it('rejects an expired session and deletes the row', async () => {
    const user = await createTestUser();
    const { token, session } = await createSession({ userId: user.id });
    await prisma.session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(resolveSession(token)).resolves.toBeNull();
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toBeNull();
  });

  it('sets a 30-day expiry', async () => {
    const user = await createTestUser();
    const now = new Date('2026-01-01T00:00:00.000Z');
    const { session } = await createSession({ userId: user.id, now });

    expect(session.expiresAt.getTime()).toBe(now.getTime() + SESSION_TTL_MS);
  });

  it('revokes immediately on sign-out', async () => {
    const user = await createTestUser();
    const { token } = await createSession({ userId: user.id });

    await destroySession(token);
    await expect(resolveSession(token)).resolves.toBeNull();
  });

  it('signing out is idempotent', async () => {
    const user = await createTestUser();
    const { token } = await createSession({ userId: user.id });

    await destroySession(token);
    await expect(destroySession(token)).resolves.toBeUndefined();
  });

  it('revokes every device at once', async () => {
    const user = await createTestUser();
    const first = await createSession({ userId: user.id });
    const second = await createSession({ userId: user.id });

    expect(await destroyAllUserSessions(user.id)).toBe(2);
    await expect(resolveSession(first.token)).resolves.toBeNull();
    await expect(resolveSession(second.token)).resolves.toBeNull();
  });

  it('purges expired sessions without touching live ones', async () => {
    const user = await createTestUser();
    const live = await createSession({ userId: user.id });
    const stale = await createSession({ userId: user.id });
    await prisma.session.update({
      where: { id: stale.session.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    expect(await purgeExpiredSessions()).toBe(1);
    expect((await resolveSession(live.token))?.user.id).toBe(user.id);
  });

  it('cascades session deletion when the user is deleted', async () => {
    const user = await createTestUser();
    await createSession({ userId: user.id });

    await prisma.user.delete({ where: { id: user.id } });
    expect(await prisma.session.count()).toBe(0);
  });
});
