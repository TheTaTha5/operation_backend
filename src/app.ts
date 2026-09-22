import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
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

  const corsOrigins = process.env.CORS_ORIGIN?.split(',').map((origin) => origin.trim()).filter(Boolean);
  app.register(fastifyCors, { origin: corsOrigins?.length ? corsOrigins : false });

  // Live API documentation: Swagger UI is generated from the registered Fastify routes at startup.
  // Register it before operations routes so the documentation page itself is not behind API auth.
  app.register(fastifySwagger, {
    openapi: {
      info: { title: 'Operation Backend API', version: '0.1.0', description: 'Boat operations and booking API' },
      tags: [
        { name: 'Bookings', description: 'Booking creation, search, and amendments' },
        { name: 'Operations', description: 'Deployments, availability, and seat locks' },
      ],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
  });
  app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  app.register(fastifyStatic, {
    root: join(__dirname, 'public'),
    prefix: '/',
  });

  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.register(registerHealthRoutes, { prefix: '/api' });
  app.register(registerOperationsRoutes);

  return app;
}
