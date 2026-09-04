FROM oven/bun:1.4.0-alpine AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1.4.0-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/bun.lock ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3000

CMD ["sh", "-c", "bun run migration:up && bun run start:prod"]
