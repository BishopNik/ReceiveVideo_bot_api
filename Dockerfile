FROM node:20

RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl

# установить yt-dlp бинарник (без Python)
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY . .

RUN npm install

CMD ["npm", "start"]