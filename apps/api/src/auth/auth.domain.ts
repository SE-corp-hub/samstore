// Auth domain — password hashing + JWT sign/verify.
// bcrypt 3.x is ESM-only; these are async.

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiresIn: string; // e.g. "7d"
}

const BCRYPT_ROUNDS = 12;

/**
 * Pinned signing algorithm. Without this, `jwt.verify` accepts any algorithm the
 * key length permits, which is the classic algorithm-confusion footgun. One entry
 * now, so a future migration to RS256 is a deliberate edit rather than a silent
 * acceptance of whatever a token claims.
 */
const JWT_ALGORITHM = "HS256" as const;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface TokenPayload {
  sub: string; // user id
  role: string;
  email: string;
  phone?: string;
  // for store-scoped roles: the store the user belongs to
  storeId?: string;
  /** Rice Ops M2: User.tokenVersion at signing; a bump signs the user out everywhere. */
  tv?: number;
}

export function signToken(payload: TokenPayload, config: AuthConfig): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: JWT_ALGORITHM,
  } as jwt.SignOptions);
}

export interface VerifiedToken {
  sub: string;
  role: string;
  email: string;
  phone?: string;
  storeId?: string;
  tv?: number;
  iat: number;
  exp: number;
}

export class InvalidTokenError extends Error {
  constructor(message = "Invalid or expired token") {
    super(message);
    this.name = "InvalidTokenError";
  }
}

export function verifyToken(token: string, config: AuthConfig): VerifiedToken {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { algorithms: [JWT_ALGORITHM] }) as VerifiedToken;
    return decoded;
  } catch {
    throw new InvalidTokenError();
  }
}

export { JWT_ALGORITHM };