FROM node:20-alpine

WORKDIR /app

# System tools for fallback cert + optional LE issuance
RUN apk add --no-cache openssl certbot

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./

# Document both ports
EXPOSE 80 443

# Defaults for dual-port mode
ENV HTTP_PORT=80
ENV HTTPS_PORT=443
# Set your domain + certbot email via env or edit server.js CONFIG
# ENV HOSTNAME=example.com
# ENV CERTBOT_EMAIL=admin@example.com
# ENV CERTBOT_ENABLED=true
# ENV CERTBOT_STAGING=false

CMD ["node", "server.js"]

