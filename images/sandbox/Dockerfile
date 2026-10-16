# Base image for CoCoon sandboxes (works with Docker and Podman).
# Requirements for custom images: sh, git, tmux, a non-root default user and a writable /workspace.
#
# The image has no Node.js: agent CLIs and the Node.js runtime they need live in the shared, read-only toolbox that
# CoCoon mounts at /opt/agents (PATH includes /opt/agents/bin). Debian (glibc) rather than Alpine (musl), because the
# Node.js runtime and the native binaries of the agent CLIs (Claude Code, Codex, OpenCode) are glibc builds.
#
# Build args:
#   TOOLCHAIN=slim|db|full   db adds database clients (psql, mysql, redis-cli); full adds them plus compilers and Python
#   AGENTS="claude-code codex"   bake agent CLIs (and Node.js) into the image (default: none – they come from the toolbox)
FROM docker.io/library/debian:bookworm-slim

ARG TOOLCHAIN=slim
ARG AGENTS=""
# Backwards compatibility: INSTALL_AGENTS=false installs no agent CLIs.
ARG INSTALL_AGENTS=true
# Node.js major version, only used when AGENTS bakes agent CLIs into the image.
ARG NODE_MAJOR=24

RUN set -e; \
    case "$TOOLCHAIN" in \
      slim) extra="" ;; \
      db) extra="postgresql-client mariadb-client redis-tools" ;; \
      full) extra="postgresql-client mariadb-client redis-tools build-essential python3 python3-pip" ;; \
      *) echo "unknown TOOLCHAIN $TOOLCHAIN (slim, db or full)" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends bash ca-certificates curl git tmux ripgrep jq less procps $extra; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /var/log/apt/* /var/log/dpkg.log

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
    if [ -n "$pkgs" ]; then \
      case "$(dpkg --print-architecture)" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "no Node.js build for this architecture" >&2; exit 1 ;; esac; \
      base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; cd /tmp; \
      curl -fsSLO "$base/SHASUMS256.txt"; \
      file=$(grep -o "node-v[0-9.]*-linux-$arch.tar.gz" SHASUMS256.txt | head -n1); \
      curl -fsSLO "$base/$file"; grep " $file\$" SHASUMS256.txt | sha256sum -c -; \
      tar -xzf "$file" -C /usr/local --strip-components=1 --no-same-owner; \
      npm install -g $pkgs; npm cache clean --force; rm -rf /root/.npm /tmp/*; \
    fi

# Login shells (bash -l) reset PATH in /etc/profile – keep the toolbox on it.
RUN printf '%s\n' 'case ":$PATH:" in *:/opt/agents/bin:*) ;; *) PATH="/opt/agents/bin:$PATH"; export PATH ;; esac' > /etc/profile.d/cocoon-toolbox.sh \
 && groupadd --gid 1000 agent && useradd --uid 1000 --gid agent --create-home --shell /bin/bash agent \
 && mkdir -p /workspace && chown agent:agent /workspace

USER agent
WORKDIR /workspace
ENV PATH=/opt/agents/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TERM=xterm-256color LANG=C.UTF-8

CMD ["sleep", "infinity"]
