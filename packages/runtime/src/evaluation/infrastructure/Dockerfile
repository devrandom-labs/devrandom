FROM node:24-slim@sha256:ccd0612136f105d59d7266585b0bff88016e3da94c8ebfc8ad1154b529f59e7b AS node
FROM rust:1.98.1-bookworm@sha256:93ce27a88655056a51dbdd8f5f2d7ddc071c7b0070fb288a37b5a285fc83971e
COPY --from=node /usr/local/bin/node /usr/local/bin/node
CMD ["sleep", "1"]
