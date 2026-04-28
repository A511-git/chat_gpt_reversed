# Use official Node.js LTS image
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy the rest of the application code
COPY . .

# Create persistent data directories (mounted as volumes at runtime)
RUN mkdir -p /app/data/jobs /app/data/logs

# Use a non‑root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Expose the port your app listens on (default 3000, can be overridden)
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]