FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run css:build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/views ./views
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
# Drop root — the app only reads its files and logs to stdout, so the
# unprivileged `node` user (present in the official image) is sufficient. A
# process compromise is then contained to a non-root user inside the container.
USER node
EXPOSE 3000
CMD ["node", "dist/dashboard/server.js"]
