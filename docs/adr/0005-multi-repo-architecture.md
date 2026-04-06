# ADR 0005: Multi-Repository Architecture with Git Submodules

## Status
Accepted

## Date
2026-04-06

## Context

The Momentum ticketing platform was initially built as a monorepo using npm workspaces. As the platform matures toward production deployment, several factors drive the need for independent service repositories:

1. **Independent deployment cycles** — Each microservice should be deployable independently without rebuilding the entire platform
2. **Team autonomy** — Different teams can own different services with independent CI/CD pipelines
3. **Access control** — Fine-grained repository permissions per service
4. **Build isolation** — Service builds don't depend on sibling service code
5. **Version independence** — Services can evolve at different rates
6. **CI/CD efficiency** — Only the changed service's pipeline runs on commits

## Decision

Restructure from a monorepo to a multi-repository architecture:

### Repository Layout

| Repository | Purpose |
|-----------|---------|
| `momentum-infra` | Infrastructure repo (this repo) with git submodules, docker-compose, K8s manifests, docs, cross-service tests, load tests |
| `momentum-api-gateway` | API Gateway service |
| `momentum-event-service` | Event management service |
| `momentum-booking-service` | Booking and reservation service |
| `momentum-search-service` | Search and indexing service |
| `momentum-shared` | Shared types, DTOs, constants, utilities |
| `momentum-database` | Prisma schema, migrations, seed data |

### Git Submodules

The infrastructure repository uses git submodules to reference all service and package repositories:

```
momentum-infra/
├── services/
│   ├── api-gateway/       → submodule → momentum-api-gateway
│   ├── event-service/     → submodule → momentum-event-service
│   ├── booking-service/   → submodule → momentum-booking-service
│   └── search-service/    → submodule → momentum-search-service
├── packages/
│   ├── shared/            → submodule → momentum-shared
│   └── database/          → submodule → momentum-database
```

### Dependency Strategy

- **Shared package**: Services depend on `@momentum/shared` via git URL (`git+https://github.com/org/momentum-shared.git`)
- **Database schema**: Services that need Prisma copy or symlink the `prisma/` directory from `@momentum/database`
- **Local development**: The infra repo provides a `scripts/setup.sh` that initializes submodules, installs dependencies, and links packages

## Consequences

### Positive
- Independent service deployment and CI/CD
- Clear ownership boundaries
- Faster CI pipelines (only affected service rebuilds)
- Better access control per service
- Easier onboarding (developers only clone relevant repos)

### Negative
- Submodule management overhead (developers must update submodules)
- Cross-service changes require coordinated PRs
- Shared package updates require version bumps in consumers
- Local development setup is slightly more complex

### Mitigations
- Infrastructure repo provides `scripts/setup.sh` for one-command local setup
- CI workflows in each service are self-contained
- Platform-level CI in infra repo runs cross-service integration tests
- Clear documentation for submodule workflow
