import type { FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import { timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword, type StoredUser } from './domain/users.js';

/**
 * Who is calling. A staff login carries its `users` row, read fresh on every request, so a change
 * of rights, a disable or a sign-out takes effect at once (legacy kept them in a 30-day cookie).
 * Love Kingdom's API key carries no row: it opens availability and nothing else.
 */
export type AuthenticatedUser = { subject: string; username: string; user?: StoredUser; apiKey?: true };

declare module 'fastify' {
  interface FastifyRequest { user?: AuthenticatedUser }
}

/** Where logins are looked up: either store. */
export type UserSource = {
  user(id: number): StoredUser | undefined | Promise<StoredUser | undefined>;
  userByUsername(username: string): StoredUser | undefined | Promise<StoredUser | undefined>;
};

/** Marks this service's own tokens, so no other HS256 token signed with the same secret passes. */
const ISSUER = 'operation-backend';
const TOKEN_SECONDS = 12 * 60 * 60;
/** Failed logins for one username: 15 within 3 minutes locks it until the oldest is 3 minutes old. */
const FAILURE_LIMIT = 15;
const FAILURE_WINDOW_MS = 3 * 60 * 1000;
/** Checked when the username is unknown, so a wrong username costs the same time as a wrong password. */
const DECOY_HASH = hashPassword('decoy');

/** Constant-time regardless of where the strings first differ, and safe when their lengths differ. */
function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a), bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

export class Authenticator {
  private readonly secret?: Uint8Array;
  /** Per instance, in memory: a restart or a second instance starts its own count. */
  private readonly failures = new Map<string, number[]>();

  constructor() {
    const secret = process.env.AUTH_JWT_SECRET;
    if (process.env.AUTH_REQUIRED === 'true' && !secret) throw new Error('AUTH_JWT_SECRET is required when AUTH_REQUIRED=true');
    this.secret = secret ? new TextEncoder().encode(secret) : undefined;
  }

  /** Off only without `AUTH_JWT_SECRET`: local development and the tests that do not test login. */
  get enabled(): boolean { return this.secret !== undefined; }

  /**
   * Love Kingdom's server reads availability with the `X-Api-Key` header it already sends legacy's
   * `/api/b2c/availability`, matched against `B2C_API_KEY`. Undefined when the request carries no
   * key: the Bearer token decides then. A key that is sent and wrong is `401`, never a silent
   * fall-through to Bearer.
   */
  authenticateApiKey(request: FastifyRequest): AuthenticatedUser | undefined {
    const sent = request.headers['x-api-key'];
    if (sent === undefined) return undefined;
    const key = process.env.B2C_API_KEY;
    if (!key) unauthorized('X-Api-Key is not accepted: B2C_API_KEY is not set');
    if (typeof sent !== 'string' || !safeEqual(sent, key)) unauthorized('Invalid X-Api-Key');
    const user: AuthenticatedUser = { subject: 'love-kingdom', username: 'love-kingdom', apiKey: true };
    request.user = user;
    return user;
  }

  async authenticate(request: FastifyRequest, users: UserSource): Promise<AuthenticatedUser | undefined> {
    if (!this.secret) return undefined;
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) unauthorized('A Bearer access token is required: POST /v1/login');
    let payload;
    try {
      ({ payload } = await jwtVerify(header.slice('Bearer '.length), this.secret, { issuer: ISSUER }));
    } catch { unauthorized('Invalid or expired access token'); }
    const user = await users.user(Number(payload!.sub));
    if (!user || user.disabled_at !== null) unauthorized('This login no longer exists or is disabled');
    // Legacy `logout_after`: a sign-out, a disable or a password reset ends every earlier session.
    const issuedAt = Number(payload!.iat_ms);
    if (user!.tokens_valid_after !== null && !(issuedAt > Date.parse(user!.tokens_valid_after))) unauthorized('This session has ended; log in again');
    const authenticated: AuthenticatedUser = { subject: String(user!.id), username: user!.username, user: user! };
    request.user = authenticated;
    return authenticated;
  }

  /** Legacy's login: a username matched ignoring case, and its scrypt hash checked as it is. */
  async login(username: string, password: string, users: UserSource): Promise<{ token: string; expiresIn: number; user: StoredUser }> {
    if (!this.secret) refuse('Login is not configured: AUTH_JWT_SECRET is not set', 503);
    const key = username.trim().toLowerCase();
    const now = Date.now();
    const recent = (this.failures.get(key) ?? []).filter((at) => now - at < FAILURE_WINDOW_MS);
    if (recent.length >= FAILURE_LIMIT) {
      refuse(`Too many failed logins for ${username}; try again in ${Math.ceil((recent[0] + FAILURE_WINDOW_MS - now) / 1000)} seconds`, 429);
    }
    const user = await users.userByUsername(username.trim());
    const matches = verifyPassword(password, user?.pass_hash ?? DECOY_HASH);
    if (!user || !matches || user.disabled_at !== null) {
      this.failures.set(key, [...recent, now]);
      unauthorized('Invalid username or password');
    }
    this.failures.delete(key);
    // Always after the user's cutoff, so a login in the same millisecond as a sign-out still counts.
    const issuedAt = Math.max(now, user!.tokens_valid_after === null ? 0 : Date.parse(user!.tokens_valid_after) + 1);
    const token = await new SignJWT({ preferred_username: user!.username, iat_ms: issuedAt })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(String(user!.id))
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_SECONDS}s`)
      .sign(this.secret!);
    return { token, expiresIn: TOKEN_SECONDS, user: user! };
  }
}

function refuse(message: string, statusCode: number): never {
  const error = new Error(message);
  (error as Error & { statusCode: number }).statusCode = statusCode;
  throw error;
}
function unauthorized(message: string): never { return refuse(message, 401); }
