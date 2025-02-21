FROM oven/bun:1.0.25

WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./

# Install dependencies
RUN bun install --production

# Copy source files
COPY src ./src
COPY tsconfig.json ./

# Create data directory
RUN mkdir -p data

# Set environment
ENV NODE_ENV=production

# Expose default port
EXPOSE 3000

# Start master
CMD ["bun", "run", "src/master.ts"]
