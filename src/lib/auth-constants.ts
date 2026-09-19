/**
 * Auth constants safe to import from client components.
 *
 * `src/server/auth/password.ts` pulls in `node:crypto`, so the client bundle
 * cannot import it. These values live here and are re-used there, keeping the
 * form's `minLength` and the server's validation in sync from one definition.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
