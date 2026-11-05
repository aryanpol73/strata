import type { Request, RequestHandler } from 'express';
import type { GuestScope } from '@strata/shared';
import { unauthenticated } from '../../lib/errors.js';
import { verifyUserToken } from '../../lib/tokens.js';
import { DeviceSession, User } from '../../models/identity.js';
import type { Types } from 'mongoose';

export interface AuthedUser {
  id: string;
  name: string;
  sessionId: string;
}

export interface GuestContext {
  sessionId: string;
  capabilityId: string;
  roomId: Types.ObjectId;
  name: string;
  scope: GuestScope;
  expiresAt: Date;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser;
      guest?: GuestContext;
    }
  }
}

/**
 * Verifies an access token and confirms the session is still live, so revoking a device takes effect at once
 * rather than when the token happens to expire. A guest token fails here because its audience differs.
 */
export async function authenticateUser(token: string): Promise<AuthedUser> {
  const claims = await verifyUserToken(token);
  const [session, user] = await Promise.all([
    DeviceSession.exists({ _id: claims.sid, userId: claims.sub, revokedAt: null, expiresAt: { $gt: new Date() } }),
    User.findById(claims.sub).select('displayName').lean(),
  ]);
  if (!session || !user) throw unauthenticated('Your session has ended');
  return { id: claims.sub, name: user.displayName, sessionId: claims.sid };
}

export const bearer = (req: Request): string | null => {
  const header = req.get('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
};

export const requireUser: RequestHandler = async (req, _res, next) => {
  const token = bearer(req);
  if (!token) throw unauthenticated();
  req.user = await authenticateUser(token);
  next();
};

/** For handlers placed after `requireUser`. */
export const currentUser = (req: Request): AuthedUser => {
  if (!req.user) throw unauthenticated();
  return req.user;
};
