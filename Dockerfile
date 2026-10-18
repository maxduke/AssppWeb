# Build stages run on the build machine's native architecture (BUILDPLATFORM)
# and produce platform-independent artifacts; only the runtime layer is built
# per target platform. Supported runtime platforms are amd64 and arm64.
FROM --platform=$BUILDPLATFORM node:22-alpine AS frontend-build
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Share native-build dependencies without coupling asset extraction to source
# or test changes. Runtime native modules are installed per target below.
FROM --platform=$BUILDPLATFORM node:22-alpine AS backend-deps
RUN apk add --no-cache python3 make g++
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci

FROM backend-deps AS backend-build
COPY backend/ ./
RUN npm run build

# Downloads the public Apple update package once (~380 MB over range
# requests), verifies the pinned digests, strips fat binaries to their x86_64
# slices, and emits ~22.5 MB of assets. Cache invalidation is limited to the
# dependency lockfile, extraction service/config and extraction entrypoint.
FROM backend-deps AS sap-assets
COPY backend/src/config.ts ./src/config.ts
COPY backend/src/services/sapAssets.ts ./src/services/sapAssets.ts
COPY backend/scripts/extract-sap-assets.mts ./scripts/extract-sap-assets.mts
ARG SAP_ASSETS_OUT=/out
RUN DATA_DIR=/tmp/sap-extract-work node --import tsx scripts/extract-sap-assets.mts ${SAP_ASSETS_OUT}

FROM node:22-alpine
RUN apk add --no-cache zip
WORKDIR /app
COPY --from=backend-build /app/backend/dist ./dist
COPY backend/package*.json ./
# Native modules install per target platform: @node-rs/crc32 (via
# yauzl-promise) ships prebuilt napi binaries, but bufferutil (via wisp-js)
# has no linux-arm64-musl prebuild and falls back to source compilation.
# The toolchain is added and removed inside one layer, so it never bloats
# the final image.
RUN apk add --no-cache --virtual .node-build python3 make g++ \
    && npm ci --omit=dev \
    && apk del .node-build \
    && npm cache clean --force
COPY --from=frontend-build /app/frontend/dist ./public
COPY frontend/src/apple/sap/vendor/COPYING* frontend/src/apple/sap/vendor/AUTHORS.TXT frontend/src/apple/sap/vendor/NOTICE ./public/licenses/unicorn/
COPY --from=sap-assets /out /opt/asspp/sap-assets
RUN mkdir -p /data/packages
EXPOSE 8080
ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown
ENV DATA_DIR=/data PORT=8080 BUILD_COMMIT=$BUILD_COMMIT BUILD_DATE=$BUILD_DATE
CMD ["node", "dist/index.js"]
