FROM node:20-alpine
# Chromium runs the local Lighthouse check for password-protected storefronts.
RUN apk add --no-cache openssl chromium
ENV CHROME_PATH=/usr/bin/chromium-browser

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN npm run build

CMD ["npm", "run", "docker-start"]
