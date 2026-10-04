# syntax=docker/dockerfile:1.7
FROM messense/cargo-xwin@sha256:9856b895265d4966f212228ba64802cf89337e2a2a537aa2533c1b8784cbc81b AS cargo-xwin
FROM node:24-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe AS windows-builder

ARG WINDOWS_TARGET
ARG PACKAGE_SOURCE_SHA
ARG PACKAGE_RUN_ID
ARG PACKAGE_RUN_ATTEMPT
ARG CARGO_BUILD_JOBS=2
ARG LAPKB_LOCAL_SIGNING_KID
ARG LAPKB_LOCAL_SIGNING_PUBLIC_KEY_B64
ENV LAPKB_LOCAL_SIGNING_KID=${LAPKB_LOCAL_SIGNING_KID} \
    LAPKB_LOCAL_SIGNING_PUBLIC_KEY_B64=${LAPKB_LOCAL_SIGNING_PUBLIC_KEY_B64}
ENV CARGO_HOME=/tmp/checkmate-cargo-home \
    RUSTUP_HOME=/tmp/checkmate-rustup-home \
    CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} \
    CARGO_NET_GIT_FETCH_WITH_CLI=true
ENV PATH="/tmp/checkmate-cargo-home/bin:${PATH}"

COPY --from=cargo-xwin /usr/local/cargo/ /tmp/checkmate-cargo-home/
COPY --from=cargo-xwin /usr/local/rustup/ /tmp/checkmate-rustup-home/
RUN chmod 700 "$CARGO_HOME" "$RUSTUP_HOME"

# Debian 7zip supplies /usr/bin/7z; require its NSIS reader before compilation.
RUN apt-get update \
    && apt-get install --no-install-recommends -y build-essential cmake ca-certificates clang git llvm lld nsis 7zip openssh-client pkg-config \
    && test -x /usr/bin/7z \
    && LC_ALL=C /usr/bin/7z i > /tmp/lapkb-7zip-formats \
    && /usr/bin/grep -Eq '(^|[[:space:]])Nsis([[:space:]]|$)' /tmp/lapkb-7zip-formats \
    && rm -f /tmp/lapkb-7zip-formats \
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

# Check real solid-archive listing semantics before compiling any application.
RUN --network=none LAPKB_NSIS_LISTING_FIXTURE=1 node --test scripts/ci/windows-package.test.mjs

RUN node scripts/ci/validate-pilot-inputs.mjs \
    && cd desktop && npm ci && npm exec -- tsc && npm exec -- vite build

RUN install -d -m 700 /root/.ssh

# Fetch only the two pinned private repositories; no private key enters a layer.
RUN --mount=type=ssh,id=default,required=true \
    --mount=type=secret,id=sdk-public,target=/root/.ssh/sdk.pub,required=true \
    --mount=type=secret,id=protocol-public,target=/root/.ssh/protocol.pub,required=true \
    set -eu; \
    test -S "$SSH_AUTH_SOCK"; \
    agent_identities=/tmp/checkmate-agent-identities; \
    git_config=/tmp/checkmate-private-gitconfig; \
    ssh-add -L > "$agent_identities"; \
    chmod 600 "$agent_identities"; \
    trap 'rm -f "$agent_identities" "$git_config" /root/.ssh/config /root/.ssh/known_hosts' EXIT; \
    node scripts/ci/configure-private-git.mjs \
      /root/.ssh/sdk.pub /root/.ssh/protocol.pub "$agent_identities" \
      /root/.ssh/config "$git_config" /root/.ssh/known_hosts "$SSH_AUTH_SOCK"; \
    export GIT_CONFIG_GLOBAL="$git_config" GIT_CONFIG_NOSYSTEM=1 GIT_SSH_VARIANT=ssh; \
    export GIT_SSH_COMMAND='node /workspace/scripts/ci/repo-ssh.mjs'; \
    export LAPKB_PRIVATE_SSH_CONFIG=/root/.ssh/config LAPKB_SSH_BINARY=/usr/bin/ssh; \
    cargo fetch --locked --manifest-path desktop/src-tauri/Cargo.toml

ENV CARGO_NET_OFFLINE=true \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_SSH_COMMAND=/bin/false

# Public CRT/SDK downloads happen without an SSH mount, before offline compilation.
RUN cargo xwin cache xwin
# Compile native Windows regression sources; this is NOT a Windows test pass.
RUN --network=none cargo xwin test --no-run --locked --offline --features local-staging \
    --manifest-path desktop/src-tauri/Cargo.toml --target "$WINDOWS_TARGET"


RUN --network=none cd desktop && npm run tauri -- build --runner cargo-xwin --target "$WINDOWS_TARGET" --features local-staging --no-bundle --config '{"build":{"beforeBuildCommand":""}}' -- --locked --offline
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

RUN node scripts/ci/windows-package.mjs checkerboard "$WINDOWS_TARGET" /out "$PACKAGE_SOURCE_SHA" "$PACKAGE_RUN_ID" "$PACKAGE_RUN_ATTEMPT" public-staging

RUN --network=none GITHUB_RUN_ID="$PACKAGE_RUN_ID" GITHUB_RUN_ATTEMPT="$PACKAGE_RUN_ATTEMPT" \
    LAPKB_WINDOWS_PACKAGE_APP=checkerboard LAPKB_WINDOWS_PACKAGE_TARGET="$WINDOWS_TARGET" \
    LAPKB_WINDOWS_PACKAGE_OUTPUT=/out LAPKB_WINDOWS_PACKAGE_SOURCE="$PACKAGE_SOURCE_SHA" LAPKB_WINDOWS_PACKAGE_PROFILE=public-staging \
    node --test --test-name-pattern='actual generated NSIS' scripts/ci/windows-package.test.mjs

FROM scratch AS ci-artifacts
COPY --from=windows-builder /out/ /
