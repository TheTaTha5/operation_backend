import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

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

export class OidcAuthenticator {
  private readonly issuer?: string;
  private readonly audience?: string;
  private discovery?: Promise<OidcConfiguration>;
  private jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor() {
    const issuer = process.env.OIDC_ISSUER;
    const required = process.env.AUTH_REQUIRED === 'true';
    if (required && (!issuer || !process.env.OIDC_AUDIENCE)) throw new Error('OIDC_ISSUER and OIDC_AUDIENCE are required when AUTH_REQUIRED=true');
    this.issuer = issuer;
    this.audience = process.env.OIDC_AUDIENCE;
  }

  get enabled(): boolean { return Boolean(this.issuer && this.audience); }

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
    try {
      const { payload } = await jwtVerify(token, await this.keySet(), { issuer: this.issuer, audience: this.audience });
      const user = userFromPayload(payload);
      request.user = user;
      return user;
    } catch (error) {
      if ((error as Error & { statusCode?: number }).statusCode) throw error;
      unauthorized('Invalid or expired access token');
    }
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
