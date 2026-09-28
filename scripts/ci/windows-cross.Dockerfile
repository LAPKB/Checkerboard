# syntax=docker/dockerfile:1.7
FROM messense/cargo-xwin@sha256:9856b895265d4966f212228ba64802cf89337e2a2a537aa2533c1b8784cbc81b AS cargo-xwin
FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS windows-builder

ARG WINDOWS_TARGET
ARG CARGO_BUILD_JOBS=2
ENV CARGO_HOME=/tmp/checkmate-cargo-home \
    RUSTUP_HOME=/tmp/checkmate-rustup-home \
    CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} \
    CARGO_NET_GIT_FETCH_WITH_CLI=true
ENV PATH="/tmp/checkmate-cargo-home/bin:${PATH}"

COPY --from=cargo-xwin /usr/local/cargo/ /tmp/checkmate-cargo-home/
COPY --from=cargo-xwin /usr/local/rustup/ /tmp/checkmate-rustup-home/
RUN chmod 700 "$CARGO_HOME" "$RUSTUP_HOME"

RUN apt-get update \
    && apt-get install --no-install-recommends -y build-essential cmake ca-certificates clang git llvm lld nsis openssh-client pkg-config \
    && rm -rf /var/lib/apt/lists/* \
    && cargo xwin --version

RUN case "$WINDOWS_TARGET" in \
      x86_64-pc-windows-msvc|aarch64-pc-windows-msvc) ;; \
      *) echo "Unsupported Windows target: $WINDOWS_TARGET" >&2; exit 2 ;; \
    esac \
    && rustup toolchain install 1.97.1 --profile minimal \
    && rustup default 1.97.1 \
    && rustup target add "$WINDOWS_TARGET"

WORKDIR /workspace
COPY . .

RUN cd desktop && npm ci && npm exec -- tsc && npm exec -- vite build

RUN install -d -m 700 /root/.ssh

RUN GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_SSH_COMMAND=/bin/false \
    cargo fetch --locked --manifest-path desktop/src-tauri/Cargo.toml

ENV CARGO_NET_OFFLINE=true \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_SSH_COMMAND=/bin/false

# Public CRT/SDK downloads happen without an SSH mount, before offline compilation.
RUN cargo xwin cache xwin


RUN --network=none cd desktop && npm run tauri -- build --runner cargo-xwin --target "$WINDOWS_TARGET" --no-bundle --config '{"build":{"beforeBuildCommand":""}}' -- --locked --offline
# Tauri may download public NSIS helpers; no source credentials remain in this step.
RUN cd desktop && npm run tauri -- bundle --target "$WINDOWS_TARGET" --bundles nsis --ci --no-sign

RUN set -eu; \
    app="desktop/src-tauri/target/$WINDOWS_TARGET/release/checkmate-desktop.exe"; \
    nsis_dir="desktop/src-tauri/target/$WINDOWS_TARGET/release/bundle/nsis"; \
    test -s "$app"; \
    set -- "$nsis_dir"/*.exe; \
    if [ "$#" -ne 1 ] || [ ! -s "$1" ]; then \
      echo "Expected exactly one non-empty NSIS installer in $nsis_dir" >&2; exit 1; \
    fi; \
    install -d /out; \
    cp "$app" /out/checkmate.exe; \
    cp "$1" /out/checkmate-nsis-installer.exe; \
    chmod 644 /out/checkmate.exe /out/checkmate-nsis-installer.exe

FROM scratch AS ci-artifacts
COPY --from=windows-builder /out/ /
