import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { existsSync } from 'fs';
import { resolve } from 'path';

export function createApp() {
  const app = express();

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", "ws:", "wss:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        scriptSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false, // Required for Socket.IO
  }));

  // Middleware
  app.use(cors({
    origin: process.env.NODE_ENV === 'production' ? false : 'http://localhost:5173',
    credentials: true,
  }));
  app.use(express.json({ limit: '1mb' }));

  // Health check (no auth)
  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve static Vue SPA in production
  if (process.env.NODE_ENV === 'production') {
    const clientDist = resolve(process.cwd(), 'client/dist');
    if (existsSync(clientDist)) {
      app.use(express.static(clientDist));
      // SPA fallback — serve index.html for non-API routes
      app.get(/^\/(?!api|socket\.io).*/, (_req, res) => {
        res.sendFile(resolve(clientDist, 'index.html'));
      });
    }
  }

  return app;
}
