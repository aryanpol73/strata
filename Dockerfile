FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/e2e/package.json apps/e2e/
RUN MONGOMS_DISABLE_POSTINSTALL=1 pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @strata/web build && pnpm --filter @strata/server build
RUN pnpm --filter @strata/server deploy --prod --legacy /deploy

FROM node:24-slim
ENV NODE_ENV=production WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /repo/apps/server/dist ./dist
COPY --from=build /repo/apps/web/dist ./web
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
