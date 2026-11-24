FROM node:24-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY client ./client
ENV NODE_ENV=production PORT=8080 DATA_PATH=/data/chain.json
EXPOSE 8080
CMD ["node", "--max-old-space-size=96", "server/start.js"]
