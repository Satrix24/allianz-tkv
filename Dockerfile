FROM mcr.microsoft.com/playwright:v1.53.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Install Playwright browsers (Chromium only)
RUN npx playwright install chromium

COPY . .

RUN mkdir -p data downloads

ENV NODE_ENV=production
ENV PORT=10000
ENV PLAYWRIGHT_HEADLESS=true

EXPOSE 10000

CMD ["node", "server.js"]
