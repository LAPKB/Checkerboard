# syntax=docker/dockerfile:1.7
FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS node-runtime
FROM rust:1.97.1-slim-trixie@sha256:8e8cf8f7fd54a2d23d5a743b3a03f56e26b6c774276c33fa0595111704ebb15c AS linux-builder

ARG LINUX_TARGET
ARG CARGO_BUILD_JOBS=2
ENV CARGO_HOME=/tmp/checkmate-cargo-home \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} \
    CARGO_NET_GIT_FETCH_WITH_CLI=true \
    APPIMAGE_EXTRACT_AND_RUN=1 \
    PATH="/usr/local/cargo/bin:${PATH}"
COPY --from=node-runtime /usr/local/ /usr/local/
RUN chmod 700 "$RUSTUP_HOME" \
    && install -d -m 700 "$CARGO_HOME" /root/.ssh
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
      build-essential cmake ca-certificates curl file git libarchive-tools libayatana-appindicator3-dev \
      libgtk-3-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev librsvg2-dev \
      openssh-client patchelf pkg-config python3 rpm wget xdg-utils \
    && test -x /usr/bin/xdg-open \
    && rm -rf /var/lib/apt/lists/*
RUN case "$(uname -m):$LINUX_TARGET" in \
      x86_64:x86_64-unknown-linux-gnu|aarch64:aarch64-unknown-linux-gnu) ;; \
      *) echo "Linux candidate requires a matching native container architecture" >&2; exit 2 ;; \
    esac \
    && rustup target add "$LINUX_TARGET"

WORKDIR /workspace
COPY . .
RUN cd desktop && npm ci && npm exec -- tsc && npm exec -- vite build

# This CI-only source uses public dependencies; no private credentials are mounted.
RUN GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_SSH_COMMAND=/bin/false \
    cargo fetch --locked --manifest-path desktop/src-tauri/Cargo.toml

ENV CARGO_NET_OFFLINE=true \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_SSH_COMMAND=/bin/false
RUN --network=none cd desktop && npm run tauri -- build --target "$LINUX_TARGET" --no-bundle --config '{"build":{"beforeBuildCommand":""}}' -- --locked --offline
# AppImage packaging can fetch public linuxdeploy helpers; no SSH mount or keys remain.
RUN cd desktop && npm run tauri -- bundle --target "$LINUX_TARGET" --bundles appimage,deb,rpm --ci --no-sign
RUN set -eu; \
    base="desktop/src-tauri/target/$LINUX_TARGET/release"; \
    install -d /out; \
    cp "$base/checkmate-desktop" /out/checkmate; \
    for kind in appimage deb rpm; do \
      case "$kind" in appimage) extension=AppImage ;; *) extension="$kind" ;; esac; \
      set -- "$base/bundle/$kind/"*."$extension"; \
      if [ "$#" -ne 1 ] || [ ! -s "$1" ]; then echo "Expected one non-empty $kind artifact" >&2; exit 1; fi; \
      cp "$1" "/out/checkmate.$extension"; \
    done; \
    node scripts/ci/verify-linux-artifacts.mjs "$LINUX_TARGET" /out; \
    chmod 644 /out/*

FROM scratch AS ci-artifacts
COPY --from=linux-builder /out/ /
