# Multi-stage: compile with dev deps, ship only production deps + dist.
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
# Admin/diagnostic scripts (scripts/*.mjs). Shipped because the host has no
# node and no node_modules — `docker compose exec backend node scripts/x.mjs`
# is the only way to run them on the server. They import only `pg`/`bcrypt`,
# both production deps, so nothing extra is installed for them. They read
# config from the environment (compose env_file), not from a .env file: .env
# is deliberately absent from the image (see .dockerignore).
COPY scripts ./scripts
EXPOSE 4000
CMD ["node", "dist/main.js"]
