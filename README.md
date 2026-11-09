# ⚙️ Lotso Trading — API Core (`services/api`)

[![Deno 2.0+](https://img.shields.io/badge/Runtime-Deno_2.0+-black?logo=deno&logoColor=white)](https://deno.com/)
[![TypeScript Strict](https://img.shields.io/badge/TypeScript-Strict_Z%C3%A9ro_Any-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![NestJS](https://img.shields.io/badge/Framework-NestJS_12-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
[![MongoDB](https://img.shields.io/badge/Database-MongoDB_Mongoose-47A248?logo=mongodb&logoColor=white)](https://www.mongodb.com/)
[![WebSockets](https://img.shields.io/badge/Realtime-WebSocket_Gateway-blue?logo=socketdotio&logoColor=white)](https://github.com/websockets/ws)

Le micro-service `api` est le **centre névralgique de données, de persistance et d'orchestration administrative** de l'écosystème Lotso Trading. Développé sous **NestJS** avec typage strict, il expose une API REST complète, une persistance optimisée sous **MongoDB** avec index composés, et une gateway **WebSocket** diffusant en temps réel les événements de trading.

---

## ⚡ Fonctionnalités Clés

- **Persistance Optimisée sous MongoDB** :
  - Index composés pour des requêtes sub-milliseconde sur les transactions (`targetAddress`, `timestamp`, `status`).
  - Schémas Mongoose stricts validés par des DTOs runtime.
  - Pipelines d'agrégation natifs pour le calcul du PnL cumulé, du win rate et des volumes échangés.
- **Gateway WebSocket Temps Réel** :
  - Diffusion instantanée des trades détectés, validés, exécutés ou rejetés.
  - Télémétrie en direct de l'état du bot et des alertes de risque.
- **Gestion Complète des Entités Métier** :
  - *Targets* : CRUD et activation/désactivation des baleines suivies.
  - *Trades* : Historisation détaillée, déduplication et logs d'exécution.
  - *Positions* : Suivi dynamique des positions ouvertes et évaluation du PnL non réalisé.
  - *Config* : Pilotage à chaud des paramètres du RiskManager (slippage, switch `ALL`, pourcentages).

---

## 🏛️ Architecture Modulaire NestJS

```text
src/
├── main.ts                         # Bootstrap de l'application NestJS
├── app.module.ts                   # Module racine
├── config/                         # Configuration typée et validation des variables d'environnement
├── database/                       # Modèles Mongoose et indexation
│   ├── schemas/
│   │   ├── target.schema.ts        # Baleines cibles surveillées
│   │   ├── trade.schema.ts         # Historique des ordres et déduplication
│   │   ├── position.schema.ts      # Positions ouvertes
│   │   └── config.schema.ts        # Configuration dynamique du RiskManager
│   └── database.module.ts
└── modules/
    ├── targets/                    # Gestion des adresses cibles
    ├── trades/                     # Historique des transactions
    ├── positions/                  # Suivi des positions ouvertes
    ├── config/                     # Paramètres de trading à chaud
    └── metrics/                    # Pipelines d'agrégation analytique
```

---

## 🔌 Points d'Accès Principaux (REST & WebSocket)

| Méthode | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/targets` | Liste de toutes les baleines surveillées |
| `POST` | `/targets` | Ajouter une nouvelle baleine cible |
| `PATCH` | `/targets/:id` | Activer, désactiver ou modifier une cible |
| `GET` | `/trades` | Historique paginé des trades avec filtres (statut, cible, date) |
| `GET` | `/positions` | Inventaire des positions ouvertes avec calcul du PnL |
| `GET` | `/config` | Récupérer la configuration active du RiskManager |
| `PUT` | `/config` | Mettre à jour les paramètres de risque en direct |
| `GET` | `/metrics/summary`| Métriques agrégées (PnL total, Win Rate, Volume USDC) |
| `WS` | `ws://host:port` | Gateway temps réel des événements de trading |

---

## ⚙️ Configuration & Variables d'Environnement

```bash
# Serveur
PORT=3000
NODE_ENV="development"

# Base de Données MongoDB
MONGODB_URI="mongodb://localhost:27017/copy_trading"

# CORS & Sécurité
CORS_ORIGIN="http://localhost:5173"
```

---

## 🚀 Commandes Rapides

```bash
# Démarrer l'API en mode développement (rechargement à chaud)
deno task dev

# Démarrer en production
deno task start

# Lancer la suite de tests
deno task test

# Vérifier la compilation et les types
deno check src/main.ts
```

---

<div align="center">
  <sub>Composant officiel de l'écosystème <b><a href="https://github.com/Lotso-trading">Lotso Trading</a></b></sub>
</div>
