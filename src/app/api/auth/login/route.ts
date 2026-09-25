import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH } from '@/lib/auth-constants';
import { route } from '@/server/api/handler';
import { RATE_LIMITS } from '@/server/api/rate-limit';
import { loginUser } from '@/server/auth/service';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '@/server/auth/session';
import { clientIp } from '@/server/api/request';

const schema = z.object({
  email: z.string().email().max(320),
  // No minimum here: rejecting a short password before verification would tell
  // an attacker the stored password is longer than what they tried.
  password: z.string().max(PASSWORD_MAX_LENGTH),
});

export const POST = route(
  { schema, requireAuth: false, rateLimit: RATE_LIMITS.login },
  async ({ body, request }) => {
    const { user, token } = await loginUser({
      ...body,
      ipAddress: clientIp(request),
      userAgent: request.headers.get('user-agent'),
    });

    const response = NextResponse.json({
      data: { id: user.id, email: user.email, name: user.name },
    });
    response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
    return response;
  },
);
