# syntax=docker/dockerfile:1
#
# Multi-stage so the runtime image carries no compiler, no devDependencies and no
# source. The previous single-stage image ran `npm run start:dev` — the file
# watcher — which is not something to ship, and it `npm install`ed rather than
# `npm ci`ing, so the image could contain something the lockfile never described.

# --------------------------------------------------------------------- deps
# `npm ci` deletes node_modules and installs strictly from package-lock.json, so
# an image can never quietly drift from what CI verified.
FROM node:22-bookworm-slim AS deps
WORKDIR /usr/src/app

# Two dependencies build native code: @parcel/watcher and unrs-resolver. Both are
# devDependencies (a chokidar/Nest-CLI watcher and ESLint's resolver), so the
# runtime never needs them — but `npm ci` still tries to compile them here, and
# without a toolchain it reaches for node-gyp and fails. These packages are only
# guaranteed to have prebuilt binaries for glibc, hence bookworm over alpine.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copied on their own so `npm ci` is only re-run when the manifest changes, not on
# every source edit.
COPY package.json package-lock.json ./
RUN npm ci

# -------------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ------------------------------------------------------------------ runtime
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /usr/src/app

# No build toolchain here, and no devDependencies: `bcryptjs` is pure JS and the
# only native packages in the tree are dev-only, so nothing needs to be compiled
# or carried along.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /usr/src/app/dist ./dist
# The migration runner reads the SQL from db/migrations, so the migrations
# have to travel with the image: a deploy runs them before the API starts.
COPY db ./db

# The `node` user ships with the base image (uid 1000). Running as root would
# hand a compromised process the ability to write to the image filesystem.
USER node

EXPOSE 3000

# There is no /health route in this app, so this probes the port instead of
# inventing an endpoint. It is a TCP connect, not an HTTP GET: a 404 from the
# router still proves the process is accepting connections, which is what a
# container health check is supposed to mean.
#
# Shell form so $PORT is expanded — exec form would not expand it, and the port is
# configurable.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "require('net').connect(Number(process.env.PORT)||3000,'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})"

# Deliberately not `--env-file-if-exists=.env`: the image has no .env (it is
# docker-ignored) and configuration arrives as real environment variables from
# docker compose or the platform. `npm run start:prod` is the variant that reads
# a local .env, for running the compiled build directly on a host.
CMD ["node", "dist/main"]
