import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerHealthRoutes } from './routes/health.js';
import { registerOperationsRoutes } from './routes/operations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });

  app.register(fastifyStatic, {
    root: join(__dirname, 'public'),
    prefix: '/',
  });

  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.register(registerHealthRoutes, { prefix: '/api' });
  app.register(registerOperationsRoutes);

  return app;
}
