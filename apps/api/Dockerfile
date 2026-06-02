# Build the API + worker (NestJS) from the monorepo root context.
FROM node:20-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile=false
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @planiq/shared build \
 && pnpm --filter @planiq/api build \
 && find apps/api/dist -name '*.js' -exec sed -i 's|packages/shared/src|packages/shared/dist|g' {} +

FROM base AS runtime
# Playwright browsers for PDF export (worker)
RUN npx playwright install --with-deps chromium || true
WORKDIR /repo
# dist resolves @planiq/shared → packages/shared/src (ts path alias)
COPY --from=base /repo/packages/shared/dist ./packages/shared/dist
COPY --from=base /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=base /repo/apps/api/dist ./apps/api/dist
COPY --from=base /repo/apps/api/package.json ./apps/api/package.json
COPY --from=base /repo/node_modules ./node_modules
COPY --from=base /repo/apps/api/node_modules ./apps/api/node_modules
WORKDIR /repo/apps/api
ENV NODE_ENV=production
EXPOSE 4000
CMD ["node", "dist/main.js"]
