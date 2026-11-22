FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY dist ./dist
COPY deploy ./deploy
RUN chmod 644 /app/deploy/seed-uploads/demo/*.png
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm","start"]
