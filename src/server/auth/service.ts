import type { Session, User } from '@prisma/client';
import { prisma } from '@/lib/db';
import { conflict, unauthenticated, validationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { AUDIT_ACTIONS, recordAudit } from '@/server/audit/log';
import { slugify } from '@/lib/slug';
import { hashPassword, verifyPassword } from './password';
import { createSession } from './session';

/**
 * Registration and login.
 *
 * Registration also creates the user's first workspace: a user with no
 * workspace has nowhere to put a business, and an empty-state that requires a
 * second setup step before anything is possible is worse than a sensible
 * default the user can rename.
 */

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  /** Defaults to "<name>'s Workspace". */
  workspaceName?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuthResult {
  user: User;
  session: Session;
  /** The raw session token, to be set as an httpOnly cookie by the caller. */
  token: string;
}

export async function registerUser(input: RegisterInput): Promise<AuthResult> {
  const email = normaliseEmail(input.email);
  const name = input.name.trim();
  if (name.length === 0) throw validationError('Name is required');

  const passwordHash = await hashPassword(input.password);

  // The unique constraint on email is the real guard against a race between
  // two concurrent registrations; the pre-check only produces a better message.
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw conflict('An account with that email already exists');

  const workspaceName = input.workspaceName?.trim() || `${name}'s Workspace`;

  const { user, workspace } = await prisma.$transaction(async (tx) => {
    const createdUser = await tx.user.create({ data: { email, passwordHash, name } });
    const createdWorkspace = await tx.workspace.create({
      data: {
        name: workspaceName,
        slug: await uniqueWorkspaceSlug(workspaceName, tx),
        memberships: { create: { userId: createdUser.id, role: 'OWNER' } },
      },
    });
    return { user: createdUser, workspace: createdWorkspace };
  });

  const { token, session } = await createSession({
    userId: user.id,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });

  await recordAudit({
    workspaceId: workspace.id,
    actorType: 'USER',
    actorId: user.id,
    action: AUDIT_ACTIONS.userRegistered,
    objectType: 'User',
    objectId: user.id,
    ipAddress: input.ipAddress ?? null,
  });

  logger().info('User registered', { userId: user.id, workspaceId: workspace.id });
  return { user, session, token };
}

export interface LoginInput {
  email: string;
  password: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Verifies credentials and opens a session.
 *
 * A missing user still runs a password verification against a dummy hash, so
 * response time does not reveal whether an email is registered.
 */
export async function loginUser(input: LoginInput): Promise<AuthResult> {
  const email = normaliseEmail(input.email);
  const user = await prisma.user.findUnique({ where: { email } });

  const passwordMatches = user
    ? await verifyPassword(input.password, user.passwordHash)
    : await verifyPassword(input.password, await dummyHash());

  if (!user || !passwordMatches) {
    logger().warn('Failed login attempt', { email, ipAddress: input.ipAddress });
    throw unauthenticated('Invalid email or password', {
      publicMessage: 'Invalid email or password.',
    });
  }

  const { token, session } = await createSession({
    userId: user.id,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });

  const membership = await prisma.workspaceMembership.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'asc' },
    select: { workspaceId: true },
  });
  if (membership) {
    await recordAudit({
      workspaceId: membership.workspaceId,
      actorType: 'USER',
      actorId: user.id,
      action: AUDIT_ACTIONS.userLoggedIn,
      objectType: 'User',
      objectId: user.id,
      ipAddress: input.ipAddress ?? null,
    });
  }

  logger().info('User logged in', { userId: user.id });
  return { user, session, token };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw validationError('A valid email address is required');
  if (email.length > 320) throw validationError('Email address is too long');
  return email;
}

/**
 * A cached hash of a fixed string, used purely to equalise timing on the
 * unknown-email path. Computed once because scrypt is intentionally slow.
 */
let cachedDummyHash: Promise<string> | undefined;
function dummyHash(): Promise<string> {
  cachedDummyHash ??= hashPassword('timing-equalisation-placeholder-value');
  return cachedDummyHash;
}

async function uniqueWorkspaceSlug(
  name: string,
  tx: { workspace: { findUnique: (args: { where: { slug: string } }) => Promise<unknown> } },
): Promise<string> {
  const base = slugify(name) || 'workspace';
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await tx.workspace.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
  }
  // Give up on readability rather than on correctness.
  return `${base}-${Date.now().toString(36)}`;
}
