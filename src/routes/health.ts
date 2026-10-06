import type { FastifyPluginAsync } from 'fastify';

export const registerHealthRoutes: FastifyPluginAsync = async (app) => {
  // `commit` is the git SHA Railway built this deploy from, so a stale deploy shows up as a SHA that
  // is not the branch head. Null when not running on Railway.
  app.get('/health', async () => ({ status: 'ok', commit: process.env.RAILWAY_GIT_COMMIT_SHA ?? null }));
};
