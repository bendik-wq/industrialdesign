# G&L Studio editor: node + ffmpeg, run on Cloudflare Containers (class StudioEditor, src/studio/container.ts).
# The Worker sends it jobs (analyse a raw recording, render an edit plan); it streams the raw from the Worker over a
# short-lived signed link, keeps it on local disk and uploads results back the same way. No secrets live in the image.
# Debian's ffmpeg includes libx264, libx265, libass (burned-in captions), loudnorm, afftdn and silencedetect.
ARG BASE=node:22-bookworm-slim
FROM ${BASE}

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-inter fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && ffmpeg -hide_banner -encoders 2>/dev/null | grep -E 'libx264|libx265' \
  && ffmpeg -hide_banner -filters 2>/dev/null | grep -E ' (subtitles|loudnorm|afftdn|silencedetect) '

WORKDIR /app
COPY server.mjs /app/server.mjs
RUN mkdir -p /work && chown node:node /work

ENV PORT=8080 WORK_DIR=/work NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
