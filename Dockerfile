# ipfs-agentd — all-in-one image: MCP daemon, chat CLI, git remote helpers,
# and the GitHub-like repo web service. One container = one service instance;
# mount repos per instance at /data/repos.
#
#   docker build -t ipfs-agentd .
#   docker run -p 8080:8080 -v /srv/myrepo:/data/repos/myrepo ipfs-agentd
#   docker run -p 8080:8080 -v /srv/myrepo:/data/repos/myrepo \
#     -e PUBLISH=1 -e SERVE_NAME=team ipfs-agentd   # + gnostr announce
#
# BASE is overridable for offline/regulated builds (e.g. an internal mirror).
ARG BASE=node:22-alpine
FROM ${BASE}

# ubuntu-based act/runner images already carry node+git; alpine needs git
RUN (command -v git >/dev/null 2>&1 || apk add --no-cache git) \
 && (command -v node >/dev/null 2>&1 || (echo "node missing in BASE" >&2; exit 1))

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    REPOS=/data/repos

COPY package.json package-lock.json ./
# registry flake resilience: bounded retry with backoff, then fail the build
RUN for i in 1 2 3 4 5; do \
      npm ci --omit=dev --no-audit --no-fund && break; \
      echo "npm ci attempt $i failed — retrying in $((i*5))s" >&2; sleep $((i*5)); \
      [ "$i" = 5 ] && exit 1; \
    done
COPY src ./src
# interop tooling ships in the image so CI can run a containerized peer
# straight from the baked /app (no bind-mount of host node_modules)
COPY test ./test

# non-root runtime; repos arrive as volume mounts. Override RUN_USER=root for
# base images without a 'node' account (e.g. act runner images used offline).
ARG RUN_USER=node
RUN mkdir -p /data/repos && chown -R ${RUN_USER}:${RUN_USER} /data /app 2>/dev/null || true
USER ${RUN_USER}
VOLUME ["/data/repos"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

# serve the GitHub-like repo browser; override CMD for daemon/chat:
#   docker run … ipfs-agentd node src/mcp-server.js        (MCP stdio)
#   docker run … ipfs-agentd node src/bin.js chat --topic ops
CMD ["node", "src/bin.js", "serve", "--root", "/data/repos"]
