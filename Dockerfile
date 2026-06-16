FROM node:20

RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    python3-full \
    curl

# гарантируем pip (ВАЖНО)
RUN python3 -m ensurepip --upgrade || true

RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel

RUN pip3 install yt-dlp

WORKDIR /app

COPY . .

RUN npm install

CMD ["npm", "start"]