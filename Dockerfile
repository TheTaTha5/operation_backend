# The API, built the way Railway builds it (`npm ci && npm run build`) and started the way Railway
# deploys it: migrate first (`preDeployCommand`), then serve. For local use with docker-compose.yml.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# `tsc` does not copy the static landing page, and `app.ts` serves it from beside the compiled code.
COPY src/public ./dist/public
# `dist/migrate.js` reads `../migrations`.
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/server.js"]
