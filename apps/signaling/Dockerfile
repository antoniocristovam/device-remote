# Build from the repo root: docker build -f apps/signaling/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY apps/signaling apps/signaling
RUN npm ci --workspace @rc/signaling --include-workspace-root \
 && npm run build -w @rc/protocol \
 && npm run build -w @rc/signaling \
 && npm prune --omit=dev --workspace @rc/signaling

FROM node:22-alpine
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo /repo
USER node
EXPOSE 8787
CMD ["node", "apps/signaling/dist/index.js"]
