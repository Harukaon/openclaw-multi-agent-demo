FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.23.2-bookworm-slim
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATABASE_FILE=/data/platform.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e 'fetch("http://127.0.0.1:8787/health").then(r=>{if(!r.ok) process.exit(1)}).catch(()=>process.exit(1))'
CMD ["node", "dist/server.js"]
