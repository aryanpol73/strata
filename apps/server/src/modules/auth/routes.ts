import { Router, type CookieOptions, type Request, type Response } from 'express';
import { loginInput, objectId, registerInput } from '@strata/shared';
import { getEnv } from '../../config/env.js';
import { unauthenticated } from '../../lib/errors.js';
import { param, parse, requireClientHeader } from '../../lib/http.js';
import { limits } from '../../lib/rateLimit.js';
import { currentUser, requireUser } from './middleware.js';
import * as auth from './service.js';

const COOKIE = 'strata_rt';

const cookieOptions = (): CookieOptions => {
  const env = getEnv();
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  };
};

const clientInfo = (req: Request) => ({ userAgent: req.get('user-agent') ?? '', ip: req.ip ?? '' });

function finish(res: Response, result: Awaited<ReturnType<typeof auth.refresh>>, status = 200) {
  if (result.refreshToken) res.cookie(COOKIE, result.refreshToken, cookieOptions());
  res.status(status).json({ accessToken: result.accessToken, user: result.user, sessionId: result.sessionId });
}

export const authRoutes = Router();

authRoutes.post('/register', limits.register, async (req, res) => {
  finish(res, await auth.register(parse(registerInput, req.body), clientInfo(req)), 201);
});

authRoutes.post('/login', limits.login, async (req, res) => {
  finish(res, await auth.login(parse(loginInput, req.body), clientInfo(req)));
});

authRoutes.post('/refresh', limits.refresh, requireClientHeader, async (req, res) => {
  const token = req.cookies?.[COOKIE] as string | undefined;
  if (!token) throw unauthenticated();
  try {
    finish(res, await auth.refresh(token));
  } catch (err) {
    res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
    throw err;
  }
});

authRoutes.post('/logout', requireClientHeader, async (req, res) => {
  await auth.logoutByToken(req.cookies?.[COOKIE] as string | undefined);
  res.clearCookie(COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.status(204).end();
});

authRoutes.get('/sessions', requireUser, async (req, res) => {
  const user = currentUser(req);
  res.json({ sessions: await auth.listSessions(user.id, user.sessionId) });
});

authRoutes.delete('/sessions/:id', requireUser, async (req, res) => {
  await auth.revokeOwnSession(currentUser(req).id, parse(objectId, param(req, 'id')));
  res.status(204).end();
});
