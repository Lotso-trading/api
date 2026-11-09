FROM denoland/deno:latest

WORKDIR /app

# Copie exclusive des composants requis pour l'API
COPY packages/shared/ packages/shared/
COPY services/api/ services/api/

WORKDIR /app/services/api

# Pré-cache des dépendances Deno
RUN deno cache src/main.ts

EXPOSE 3000
EXPOSE 3001

CMD ["deno", "run", "-A", "--unsafe-proto", "src/main.ts"]
