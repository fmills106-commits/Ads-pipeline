import { NextResponse } from 'next/server';
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/auth-constants';
import { route } from '@/server/api/handler';
import { RATE_LIMITS } from '@/server/api/rate-limit';
import { registerUser } from '@/server/auth/service';
import { SESSION_COOKIE_NAME, sessionCookieOptions } from '@/server/auth/session';
import { clientIp } from '@/server/api/request';

const schema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  name: z.string().trim().min(1).max(120),
  workspaceName: z.string().trim().min(1).max(200).optional(),
});

export const POST = route(
  { schema, requireAuth: false, rateLimit: RATE_LIMITS.register },
  async ({ body, request }) => {
    const { user, token } = await registerUser({
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
