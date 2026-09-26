FROM node:22.23.3-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:node

FROM node:22.23.3-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    BIPLAN_RUNTIME=node
WORKDIR /app
COPY --from=build --chown=node:node /app/dist-node/ ./
USER node
EXPOSE 8080
CMD ["node", "server.js"]
