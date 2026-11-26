# cocoond for Kubernetes (COCOON_DRIVER=kubernetes). Build from the repository root:
#   docker build -f deploy/kubernetes/Dockerfile -t <registry>/cocoon:<tag> .
FROM docker.io/library/node:24-bookworm-slim
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages packages
RUN pnpm install --frozen-lockfile && pnpm build:web
# The egress proxy and the port gateway run as processes of cocoond.
COPY images images
# No self-update from git in a container: a new version is a new image.
ENV COCOON_DRIVER=kubernetes COCOON_HOST=0.0.0.0 COCOON_DATA_DIR=/data COCOON_UPDATE_CHECK=0
USER 1000:1000
EXPOSE 7420 7431 7432
CMD ["node_modules/.bin/tsx", "packages/server/src/supervisor.ts"]
