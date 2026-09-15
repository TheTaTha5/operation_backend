import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose';
import { timingSafeEqual } from 'node:crypto';

export type AuthenticatedUser = {
  subject: string;
  username?: string;
  email?: string;
  scopes: string[];
  groups: string[];
};

declare module 'fastify' {
  interface FastifyRequest { user?: AuthenticatedUser }
}

type OidcConfiguration = { jwks_uri: string };
type PasswordUser = { username: string; password: string; groups: string[] };

/**
 * Not an OIDC claim — scopes this authenticator's own HS256 tokens to itself, so a token minted by
 * `/v1/login` is never mistaken for (or accidentally accepted as) one from the OIDC issuer.
 */
const PASSWORD_AUTH_ISSUER = 'operation-backend-password-auth';

function parsePasswordUsers(raw: string | undefined): PasswordUser[] {
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('AUTH_PASSWORD_USERS must be valid JSON'); }
  if (!Array.isArray(parsed)) throw new Error('AUTH_PASSWORD_USERS must be a JSON array');
  return parsed.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`AUTH_PASSWORD_USERS[${index}] must be an object`);
    const { username, password, groups } = entry as Record<string, unknown>;
    if (typeof username !== 'string' || !username) throw new Error(`AUTH_PASSWORD_USERS[${index}].username is required`);
    if (typeof password !== 'string' || !password) throw new Error(`AUTH_PASSWORD_USERS[${index}].password is required`);
    if (!Array.isArray(groups) || !groups.every((group): group is string => typeof group === 'string')) throw new Error(`AUTH_PASSWORD_USERS[${index}].groups must be a string array`);
    return { username, password, groups };
  });
}

/** Constant-time regardless of where the strings first differ, and safe when their lengths differ. */
function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a), bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export class OidcAuthenticator {
  private readonly issuer?: string;
  private readonly audience?: string;
  private discovery?: Promise<OidcConfiguration>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private readonly passwordSecret?: Uint8Array;
  private readonly passwordUsers: PasswordUser[];

  constructor() {
    const issuer = process.env.OIDC_ISSUER;
    const required = process.env.AUTH_REQUIRED === 'true';
    const secret = process.env.AUTH_JWT_SECRET;
    this.passwordSecret = secret ? new TextEncoder().encode(secret) : undefined;
    this.passwordUsers = parsePasswordUsers(process.env.AUTH_PASSWORD_USERS);
    if (required && !(issuer && process.env.OIDC_AUDIENCE) && !this.passwordSecret) {
      throw new Error('OIDC_ISSUER and OIDC_AUDIENCE, or AUTH_JWT_SECRET, are required when AUTH_REQUIRED=true');
    }
    this.issuer = issuer;
    this.audience = process.env.OIDC_AUDIENCE;
  }

  get enabled(): boolean { return Boolean((this.issuer && this.audience) || this.passwordSecret); }

  /** Whether `/v1/login` has anyone to issue a token to. */
  get passwordAuthEnabled(): boolean { return Boolean(this.passwordSecret && this.passwordUsers.length > 0); }

  private async keySet() {
    if (!this.issuer) throw new Error('OIDC is not configured');
    this.discovery ??= fetch(`${this.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);
        return response.json() as Promise<OidcConfiguration>;
      });
    const configuration = await this.discovery;
    this.jwks ??= createRemoteJWKSet(new URL(configuration.jwks_uri));
    return this.jwks;
  }

  async authenticate(request: FastifyRequest): Promise<AuthenticatedUser | undefined> {
    if (!this.enabled) return undefined;
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) unauthorized('A Bearer access token is required');
    const token = header.slice('Bearer '.length);

    // A token is tried against whichever issuers are configured; unrecognised-issuer/signature
    // failures fall through so both an OIDC access token and a password-login token can be live
    // at once. Any other failure (expiry, malformed token) still surfaces as 401.
    if (this.passwordSecret) {
      try {
        const { payload } = await jwtVerify(token, this.passwordSecret, { issuer: PASSWORD_AUTH_ISSUER });
        const user = userFromPayload(payload);
        request.user = user;
        return user;
      } catch { /* not a password-auth token (or expired) — try OIDC below if configured */ }
    }
    if (this.issuer && this.audience) {
      try {
        const { payload } = await jwtVerify(token, await this.keySet(), { issuer: this.issuer, audience: this.audience });
        const user = userFromPayload(payload);
        request.user = user;
        return user;
      } catch (error) {
        if ((error as Error & { statusCode?: number }).statusCode) throw error;
      }
    }
    unauthorized('Invalid or expired access token');
  }

  /**
   * Temporary testing login: exchanges a username/password from `AUTH_PASSWORD_USERS` for a
   * short-lived HS256 token signed with `AUTH_JWT_SECRET`. This is a deliberate, scoped exception
   * to this service's normal "validate tokens, do not issue them" boundary — see CLAUDE.md.
   */
  async issuePasswordToken(username: string, password: string): Promise<{ token: string; expiresIn: number }> {
    if (!this.passwordSecret) unauthorized('Password login is not configured');
    const user = this.passwordUsers.find((candidate) => safeEqual(candidate.username, username));
    if (!user || !safeEqual(user.password, password)) unauthorized('Invalid username or password');
    const expiresIn = 12 * 60 * 60;
    const token = await new SignJWT({ preferred_username: user.username, groups: user.groups })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.username)
      .setIssuer(PASSWORD_AUTH_ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${expiresIn}s`)
      .sign(this.passwordSecret);
    return { token, expiresIn };
  }
}

export function requireAnyScope(user: AuthenticatedUser | undefined, scopes: string[]): void {
  if (!user) return; // Local development mode: OIDC has not been configured.
  if (scopes.some((scope) => user.scopes.includes(scope) || user.groups.includes(scope) || user.groups.includes('admin'))) return;
  const error = new Error(`Missing required permission: ${scopes.join(' or ')}`);
  (error as Error & { statusCode: number }).statusCode = 403;
  throw error;
}

function userFromPayload(payload: JWTPayload): AuthenticatedUser {
  if (!payload.sub) unauthorized('Access token has no subject');
  const groups = Array.isArray(payload.groups) ? payload.groups.filter((value): value is string => typeof value === 'string') : [];
  const scope = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
  return { subject: payload.sub, username: typeof payload.preferred_username === 'string' ? payload.preferred_username : undefined, email: typeof payload.email === 'string' ? payload.email : undefined, scopes: scope, groups };
}

function unauthorized(message: string): never {
  const error = new Error(message);
  (error as Error & { statusCode: number }).statusCode = 401;
  throw error;
}
