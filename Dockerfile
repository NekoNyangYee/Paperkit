# syntax=docker/dockerfile:1
FROM rust:1-bookworm AS build
ARG TARGETARCH
WORKDIR /build

# Workspace manifests are needed for Cargo resolution; desktop/PDFium are not built.
COPY Cargo.toml Cargo.lock ./
COPY apps/backend/Cargo.toml apps/backend/Cargo.toml
COPY apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.toml
COPY crates/pdf-core/Cargo.toml crates/pdf-core/Cargo.toml
RUN mkdir -p apps/desktop/src-tauri/src crates/pdf-core/src \
    && printf 'fn main() {}\n' > apps/desktop/src-tauri/src/main.rs \
    && touch crates/pdf-core/src/lib.rs
# Build only this package; cargo fetch would download the entire GUI workspace.
COPY apps/backend/src apps/backend/src
COPY apps/backend/migrations apps/backend/migrations
RUN --mount=type=cache,id=paperkit-registry-${TARGETARCH},target=/usr/local/cargo/registry \
    --mount=type=cache,id=paperkit-target-${TARGETARCH},target=/build/target \
    find apps/backend/src apps/backend/migrations -type f -exec touch {} + \
    && cargo build --release --locked -p paperkit-api \
    && cp target/release/paperkit-api /usr/local/bin/paperkit-api

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 paperkit \
    && useradd --uid 10001 --gid 10001 --no-create-home paperkit \
    && mkdir /data /backup \
    && chown 10001:10001 /data /backup \
    && chmod 700 /data /backup
COPY --from=build /usr/local/bin/paperkit-api /usr/local/bin/paperkit-api
USER 10001:10001
ENV BIND_ADDRESS=0.0.0.0:8080 DATABASE_PATH=/data/paperkit.sqlite3
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=8s --start-period=20s --retries=3 \
    CMD ["/usr/local/bin/paperkit-api", "--healthcheck"]
ENTRYPOINT ["/usr/local/bin/paperkit-api"]
