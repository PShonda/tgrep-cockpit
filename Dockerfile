# Multi-stage build: compiles tgrep then bundles with Bun runtime
FROM rust:alpine AS builder
RUN apk add --no-cache git musl-dev
RUN cargo install --git https://github.com/microsoft/tgrep.git tgrep-cli --locked

FROM oven/bun:alpine
RUN apk add --no-cache bash inotify-tools jq
COPY --from=builder /usr/local/cargo/bin/tgrep /usr/local/bin/tgrep

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin
RUN chmod +x ./bin/tgrep-manage.sh

ENV PORT=3150
ENV SOURCE_DIR=/source-code
EXPOSE 3150

CMD ["bun", "run", "src/server.ts"]
