# Playwright's image ships Chromium plus the system libraries it needs.
# Keep the tag in step with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
COPY configs ./configs

# Run as the image's unprivileged user.
RUN mkdir -p /app/reports && chown -R pwuser:pwuser /app
USER pwuser

ENTRYPOINT ["npx", "tsx", "src/cli.ts"]
CMD ["--help"]
