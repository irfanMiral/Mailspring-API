FROM node:22-alpine

# better-sqlite3 ships prebuilt binaries for most platforms, but keep a native
# toolchain around as a fallback in case none matches this image's arch/libc.
RUN apk add --no-cache python3 make g++

COPY . /app
RUN mkdir /data && ln -s /data /app/data
RUN chown -R 1000:1000 /app

ENV NODE_ENV=production
WORKDIR /app
USER 1000:1000
RUN npm install --omit=dev

EXPOSE 5101
VOLUME ["/data"]

ENTRYPOINT ["node", "index.js"]
