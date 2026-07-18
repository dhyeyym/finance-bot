FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./

RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV NODE_ENV=production
ENV STATE_FILE=/data/state.json

CMD ["node", "index.js"]
