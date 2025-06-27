FROM node:18-alpine

# Install ffmpeg and other dependencies
RUN apk add --no-cache ffmpeg python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Download yt-dlp during build
RUN npm run postinstall

# Create temp directory for processing
RUN mkdir -p /app/temp && chmod 777 /app/temp

# Expose port
EXPOSE 8234

# Environment variables
ENV NODE_ENV=production
ENV PORT=8234
ENV TEMP_DIR=/app/temp
ENV ENABLE_AUTH=false
ENV ENABLE_WEBHOOKS=false

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8234/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1); })"

# Run as non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Start the server
CMD ["node", "server.js"]