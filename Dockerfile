FROM node:22.22.3-bookworm-slim

# Render mounts persistent disks as root-owned. The entrypoint repairs ownership
# of the mounted data volume while privileged, then drops to the unprivileged node
# user before starting the Core service.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/ragam
COPY services/core/src ./services/core/src
COPY docs ./docs
COPY docker-entrypoint.sh /usr/local/bin/ragam-render-entrypoint

RUN chmod 0555 /usr/local/bin/ragam-render-entrypoint \
    && node --check services/core/src/server.mjs \
    && node --check services/core/src/online/app.mjs

ENV NODE_ENV=production \
    AETHERIS_CORE_HOST=0.0.0.0 \
    AETHERIS_ONLINE_DATA_DIR=/var/data/online \
    AETHERIS_COOKIE_SECURE=true \
    AETHERIS_COOKIE_SAMESITE=strict \
    AETHERIS_ONLINE_TIMEOUT_MS=55000

USER root
ENTRYPOINT ["/usr/local/bin/ragam-render-entrypoint"]
CMD ["node", "services/core/src/server.mjs"]
