import path from 'node:path';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { getEnv } from './config/env.js';
import { errorHandler, notFoundHandler } from './lib/http.js';
import { authRoutes } from './modules/auth/routes.js';
import { requireUser } from './modules/auth/middleware.js';
import { blockRoutes, roomBlockRoutes } from './modules/blocks/routes.js';
import { branchRoutes, messageBranchRoutes, roomBranchRoutes } from './modules/branches/routes.js';
import { canvasRoutes, roomCanvasRoutes } from './modules/canvas/routes.js';
import { notificationRoutes } from './modules/delivery/routes.js';
import { branchGuestRoutes, guestLinkRoutes, guestRoutes } from './modules/guests/routes.js';
import { mediaRoutes } from './modules/media/routes.js';
import { messageRoutes, roomMessageRoutes, searchRoutes } from './modules/messages/routes.js';
import { roomRoutes } from './modules/rooms/routes.js';
import { userRoutes } from './modules/users/routes.js';

function apiRouter() {
  const api = Router();

  api.get('/health', (_req, res) => {
    const db = mongoose.connection.readyState === 1;
    res.status(db ? 200 : 503).json({ status: db ? 'ok' : 'degraded' });
  });

  api.use('/auth', authRoutes);
  api.use('/guest', guestRoutes);
  api.use('/media', mediaRoutes);
  api.use('/users', userRoutes);
  api.use('/notifications', notificationRoutes);
  api.use('/search', searchRoutes);
  api.use('/guest-links', guestLinkRoutes);
  api.use('/rooms', requireUser, roomRoutes, roomMessageRoutes, roomBranchRoutes, roomBlockRoutes, roomCanvasRoutes);
  api.use('/messages', requireUser, messageRoutes, messageBranchRoutes);
  api.use('/branches', requireUser, branchRoutes, branchGuestRoutes);
  api.use('/blocks', requireUser, blockRoutes);
  api.use('/canvas', requireUser, canvasRoutes);
  api.use(notFoundHandler);
  return api;
}

export function createApp() {
  const env = getEnv();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'],
          connectSrc: ["'self'", 'wss:', 'https://api.cloudinary.com'],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cors({ origin: env.CORS_ORIGINS.split(','), credentials: true }));
  app.use(compression());
  app.use(cookieParser());
  app.use(express.json({ limit: '256kb' }));

  app.use('/api', apiRouter());

  if (env.WEB_DIST) {
    const dist = path.resolve(env.WEB_DIST);
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api|\/socket\.io).*/, (_req, res) => {
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(errorHandler);
  return app;
}
