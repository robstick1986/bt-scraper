FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js scrape.js docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV PORT=8787

EXPOSE 8787

ENTRYPOINT ["./docker-entrypoint.sh"]
