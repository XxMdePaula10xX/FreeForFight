# Single-image deploy: build the client, then run the server which also serves
# the built client (client/dist) and the WebSocket on the same port.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm install
COPY shared ./shared
COPY server ./server
COPY client ./client
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
RUN npm install --omit=dev
# tsx is a dev tool but tiny; install it to run TypeScript directly
RUN npm install -g tsx@4
COPY shared ./shared
COPY server ./server
COPY --from=build /app/client/dist ./client/dist
EXPOSE 8787
ENV PORT=8787
CMD ["tsx", "server/src/index.ts"]
