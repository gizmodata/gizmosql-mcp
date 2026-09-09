# Container image for the Streamable HTTP transport (remote MCP connector).
#
#   docker build -t gizmosql-mcp .
#   docker run --rm -p 3000:3000 \
#     -e GIZMOSQL_HOST=... -e GIZMOSQL_USERNAME=... -e GIZMOSQL_PASSWORD=... \
#     -e GIZMOSQL_MCP_PUBLIC_URL=https://mcp.example.com/mcp \
#     -e GIZMOSQL_MCP_OAUTH_ISSUER=https://login.microsoftonline.com/<tenant>/v2.0 \
#     -e GIZMOSQL_MCP_OAUTH_AUDIENCE=<client-id> \
#     gizmosql-mcp
#
# Build the image on the architecture it will run on (the release workflow
# builds linux/amd64 and linux/arm64 natively and merges them): the runtime
# stage's `npm ci` downloads the native GizmoSQL ADBC driver for the build
# machine's platform.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json LICENSE README.md CHANGELOG.md ./
# Production dependencies; the client's postinstall fetches the ADBC driver.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1
ENTRYPOINT ["node", "dist/cli.js", "--transport", "http", "--host", "0.0.0.0"]
CMD ["--port", "3000"]
