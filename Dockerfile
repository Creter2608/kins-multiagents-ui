# Dockerfile for AI-Ready Autonomous Sandbox
FROM node:22-bookworm-slim

# Install security tools, git, python3, and curl
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global --add safe.directory '*'

# Set working directory
WORKDIR /workspace

# Default command
CMD ["npm", "test"]
