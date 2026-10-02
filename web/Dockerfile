FROM node:22.23.3-bookworm-slim AS build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
COPY contracts/ /app/contracts/
COPY collector/identity/ /app/collector/identity/
COPY collector/normalize/ /app/collector/normalize/
RUN npm run build:node

FROM node:22.23.3-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    BIPLAN_RUNTIME=node
WORKDIR /app
COPY --from=build --chown=node:node /app/web/dist-node/ ./
USER node
EXPOSE 8080
CMD ["node", "server.js"]
