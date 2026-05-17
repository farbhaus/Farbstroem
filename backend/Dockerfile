FROM rust:1-alpine AS builder
# perl/make/gcc/linux-headers compile vendored OpenSSL (pulled in by
# webauthn-rs) statically into the musl binary — no system libssl needed.
RUN apk add --no-cache musl-dev perl make gcc linux-headers
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release 2>/dev/null; rm -rf src
COPY src/ ./src/
COPY schema.sql ./
RUN touch src/main.rs && cargo build --release

FROM alpine:3.20
RUN apk add --no-cache ca-certificates \
    && addgroup -S app && adduser -S -G app app \
    && mkdir -p /data && chown -R app:app /data
WORKDIR /app
COPY --from=builder /app/target/release/stream-backend .
COPY schema.sql ./
USER app
CMD ["./stream-backend"]
