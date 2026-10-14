# SubmitFleet: API, MCP (/mcp), dashboard (/app) and the worker in one process.
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:24-alpine
WORKDIR /app
# SQLite lives in /data (a bind-mounted volume on dev2); SUBMITFLEET_SECRET_KEY comes from the vault.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 SUBMITFLEET_HOME=/data
# --chown: the deploy account's umask 007 leaves the checkout unreadable to other users.
COPY --chown=node:node package.json ./
COPY --chown=node:node catalog ./catalog
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/cli.js", "serve", "--port", "3000"]
