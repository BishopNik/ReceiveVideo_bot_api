FROM node:20

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip

RUN pip3 install yt-dlp

WORKDIR /app

COPY . .

RUN npm install

CMD ["npm", "start"]