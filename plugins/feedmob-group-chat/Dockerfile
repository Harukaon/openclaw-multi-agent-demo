FROM node:22.23.2-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
COPY index.ts ./index.ts
RUN npm ci --ignore-scripts
RUN npm run build

FROM ghcr.io/harukaon/feedmob-openclaw-cf:latest
USER root
RUN mkdir -p /opt/feedmob-group-chat/node_modules && \
    ln -s /usr/local/lib/node_modules/openclaw /opt/feedmob-group-chat/node_modules/openclaw
COPY --from=build /build/dist /opt/feedmob-group-chat/dist
COPY package.json /opt/feedmob-group-chat/package.json
RUN node --input-type=module -e "import('/opt/feedmob-group-chat/dist/index.js').then(m => { if (m.default?.channelPlugin?.id !== 'feedmob-group-chat') process.exit(1) })"
COPY openclaw.plugin.json /opt/feedmob-group-chat/openclaw.plugin.json
COPY camofox-openclaw.plugin.json /opt/camofox-plugin/openclaw.plugin.json
USER node
