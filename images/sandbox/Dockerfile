# Base image for CoCoon sandboxes (works with Docker and Podman).
# Requirements for custom images: sh, git, tmux, a non-root default user and a writable /workspace.
#
# Build args:
#   TOOLCHAIN=slim|full   full adds compilers and Python (build-essential, python3) for native builds
#   AGENTS="claude-code codex"   bake agent CLIs into the image (default: none – CoCoon mounts them from the shared toolbox)
FROM docker.io/library/node:24-bookworm-slim

ARG TOOLCHAIN=slim
ARG AGENTS=""
# Backwards compatibility: INSTALL_AGENTS=false installs no agent CLIs.
ARG INSTALL_AGENTS=true

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl git tmux ripgrep jq less procps \
    postgresql-client mariadb-client redis-tools \
 && if [ "$TOOLCHAIN" = "full" ]; then apt-get install -y --no-install-recommends build-essential python3 python3-pip; fi \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

RUN set -e; pkgs=""; \
    if [ "$INSTALL_AGENTS" = "true" ]; then \
      for agent in $AGENTS; do \
        case "$agent" in \
          claude-code) pkgs="$pkgs @anthropic-ai/claude-code" ;; \
          codex) pkgs="$pkgs @openai/codex" ;; \
          *) echo "unknown agent $agent" >&2; exit 1 ;; \
        esac; \
      done; \
    fi; \
    if [ -n "$pkgs" ]; then npm install -g $pkgs && npm cache clean --force && rm -rf /root/.npm /tmp/*; fi

# Reuse the uid 1000 "node" user from the base image under a clearer name.
RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node \
 && mkdir -p /workspace && chown agent:agent /workspace

USER agent
WORKDIR /workspace
ENV TERM=xterm-256color LANG=C.UTF-8

CMD ["sleep", "infinity"]
