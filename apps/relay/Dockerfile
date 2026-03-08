FROM node:20-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy package files
COPY package.json pnpm-lock.yaml* ./
COPY apps/signaling/package.json ./apps/signaling/
COPY tsconfig.base.json ./

# Install dependencies
RUN pnpm install --filter @quicksave/signaling --frozen-lockfile

# Copy source
COPY apps/signaling ./apps/signaling

# Build
RUN pnpm --filter @quicksave/signaling build

# Run as non-root
USER node

EXPOSE 8080

ENV PORT=8080
ENV NODE_ENV=production

CMD ["node", "apps/signaling/dist/index.js"]
