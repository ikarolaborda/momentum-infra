# Momentum Infrastructure

Infrastructure repository for the **Momentum Distributed Ticketing Platform** — a production-grade system designed for 10 million simultaneous users.

This repository uses **git submodules** to reference all service and package repositories.

## Architecture

```
momentum-infra/                    ← You are here
├── momentum-api-gateway/          → git submodule
├── momentum-event-service/        → git submodule
├── momentum-booking-service/      → git submodule
├── momentum-search-service/       → git submodule
├── momentum-shared/               → git submodule
├── momentum-database/             → git submodule
├── infra/                         Infrastructure configs (K8s, Docker)
├── docs/                          Architecture docs, ADRs, runbooks
├── tests/                         Cross-service integration & e2e tests
├── load-tests/                    k6 load test scripts
└── scripts/                       Platform-wide utility scripts
```

## System Diagram

```
                    ┌─────────────────┐
                    │  Load Balancer  │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   API Gateway   │ x3+ instances
                    │  (Rate Limit,   │
                    │   Anti-Bot,     │
                    │   Queue/Auth)   │
                    └──┬─────┬─────┬──┘
                       │     │     │
          ┌────────────┤     │     ├────────────┐
          │            │     │     │            │
  ┌───────▼──────┐  ┌──▼─────▼──┐  ┌──────▼───────┐
  │ Event Service│  │  Booking  │  │Search Service│
  │   (CRUD,     │  │  Service  │  │(Elasticsearch│
  │   Caching)   │  │(Reserve,  │  │  Indexer)    │
  └───────┬──────┘  │ Payment)  │  └──────┬───────┘
          │         └──┬────┬───┘         │
          │            │    │             │
   ┌──────▼──────┐  ┌──▼────▼──┐   ┌─────▼──────┐
   │ PostgreSQL  │  │  Redis   │   │Elasticsearch│
   │ (Primary +  │  │ (Cluster)│   │  (Cluster)  │
   │  Replicas)  │  └──────────┘   └─────────────┘
   └──────┬──────┘
          │
   ┌──────▼──────┐
   │   Outbox    │──► Kafka ──► Search Indexer
   └─────────────┘
```

## Quick Start

### Prerequisites
- Node.js >= 22
- Docker & Docker Compose
- Git

### One-Command Setup

```bash
git clone --recurse-submodules https://github.com/ikarolaborda/momentum-infra.git
cd momentum-infra
npm run setup
```

### If already cloned without submodules

```bash
git submodule update --init --recursive
npm run setup
```

### Start Development

```bash
# Start infrastructure only (PostgreSQL, Redis, ES, Kafka)
npm run dev:infra

# Start all services
bash scripts/start-all.sh
```

### Service Endpoints

| Service | Port | Swagger Docs |
|---------|------|-------------|
| API Gateway | 3000 | http://localhost:3000/docs |
| Event Service | 3001 | http://localhost:3001/docs |
| Booking Service | 3002 | http://localhost:3002/docs |
| Search Service | 3003 | http://localhost:3003/docs |

## Repositories

| Repository | Description |
|-----------|-------------|
| [momentum-api-gateway](https://github.com/ikarolaborda/momentum-api-gateway) | Gateway, auth, rate limiting, anti-bot, queue |
| [momentum-event-service](https://github.com/ikarolaborda/momentum-event-service) | Event CRUD, caching, outbox |
| [momentum-booking-service](https://github.com/ikarolaborda/momentum-booking-service) | Reservations, payments, concurrency control |
| [momentum-search-service](https://github.com/ikarolaborda/momentum-search-service) | Elasticsearch search, indexing pipeline |
| [momentum-shared](https://github.com/ikarolaborda/momentum-shared) | Shared types, DTOs, utilities |
| [momentum-database](https://github.com/ikarolaborda/momentum-database) | Prisma schema, migrations, seed data |

## Submodule Workflow

### Updating submodules to latest

```bash
git submodule update --remote --merge
```

### Working on a specific service

```bash
cd momentum-event-service
git checkout -b feature/my-feature
# ... make changes ...
git commit -m "feat: add new endpoint"
git push origin feature/my-feature
# Create PR in the service repo
```

### After service PRs are merged

```bash
git submodule update --remote momentum-event-service
git add momentum-event-service
git commit -m "chore: update event-service submodule"
git push
```

## Testing

```bash
# Integration tests (requires running services)
npm run test:integration

# E2E tests (requires running services)
npm run test:e2e

# Load tests (requires k6)
npm run loadtest:events
npm run loadtest:search
npm run loadtest:booking
npm run loadtest:surge
```

## Documentation

- [Architecture Overview](docs/architecture/architecture-overview.md)
- [Booking Consistency Strategy](docs/architecture/booking-consistency-strategy.md)
- [Search Architecture](docs/architecture/search-architecture.md)
- [Anti-Bot & Fairness](docs/architecture/anti-bot-and-fairness.md)
- [Scaling Assumptions](docs/architecture/scaling-assumptions.md)
- [Operational Runbook](docs/runbooks/operational-runbook.md)

### Architecture Decision Records
- [ADR 0001 - Stack Selection](docs/adr/0001-stack-selection.md)
- [ADR 0002 - Search Engine](docs/adr/0002-search-engine.md)
- [ADR 0003 - Message Broker](docs/adr/0003-message-broker.md)
- [ADR 0004 - Concurrency Strategy](docs/adr/0004-concurrency-strategy.md)
- [ADR 0005 - Multi-Repo Architecture](docs/adr/0005-multi-repo-architecture.md)

## License

Private — All rights reserved.
