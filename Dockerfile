FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=3048
EXPOSE 3048
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:3048/api/auth/status >/dev/null || exit 1
# exec form, so node is PID 1 and receives SIGTERM itself
CMD ["node", "server.js"]
