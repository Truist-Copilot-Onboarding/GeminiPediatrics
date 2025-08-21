# Small, production Node image
FROM node:20-alpine

WORKDIR /app

# Install only prod deps
COPY package*.json ./
RUN npm ci --omit=dev

# App code
COPY server.js ./

# Heroku ignores EXPOSE, but it's fine to document
EXPOSE 3000

# Start
CMD ["node", "server.js"]

