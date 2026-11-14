# Imagem do servidor Grudados (Render usa isto, e o docker-compose local também).
FROM node:20-alpine

WORKDIR /app

# Instala dependências primeiro (melhor cache de build)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copia o código
COPY src ./src

ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]
