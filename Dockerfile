FROM node:22

ENV YT_DLP_JS_RUNTIME=node

RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl && \
    rm -rf /var/lib/apt/lists/*

# установить yt-dlp бинарник (без Python)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY . .

RUN npm install

CMD ["npm", "start"]
