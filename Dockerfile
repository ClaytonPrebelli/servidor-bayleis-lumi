# Imagem do microsservico Baileys, para o Render.
#
# O Render precisa de um Dockerfile porque o servico e' Node e o plano
# gratuito nao instala nada: a imagem ja vem com o runtime.
#
# A imagem e' slim, e nao alpine, de proposito. O Baileys puxa sharp, que tem
# binario nativo dependente de libc. Alpine usa musl e nao glibc, e o binario
# do Debian quebra com "not found", sem erro claro.
FROM node:24-slim

WORKDIR /app

# Dependencias em uma camada so.
#
# O manifesto vem antes do codigo: enquanto o package.json nao muda, o npm
# aproveita o cache da camada. Copiar tudo antes faria o build inteiro rodar a
# cada push de uma linha no codigo.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# A porta e' lida do ambiente pelo proprio servico, com 3001 como padrao.
ENV PORT=3001
ENV NODE_ENV=production

EXPOSE 3001

CMD ["node", "src/index.js"]
