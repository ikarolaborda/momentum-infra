#!/usr/bin/env bash
set -euo pipefail

echo "=== Momentum Platform Setup ==="
echo "Infrastructure repository with git submodules"
echo ""

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "Node.js >= 22 is required."; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Docker is required."; exit 1; }
command -v git >/dev/null 2>&1 || { echo "Git is required."; exit 1; }

echo "1. Initializing git submodules..."
git submodule update --init --recursive

echo "2. Installing dependencies for shared packages..."
cd packages/shared && npm install && npm run build && cd ../..
cd packages/database && npm install && cd ../..

echo "3. Installing dependencies for services..."
for service in api-gateway event-service booking-service search-service; do
  echo "   Installing $service..."
  cd "services/$service"

  # Link/copy prisma schema for services that need it
  if [ "$service" != "api-gateway" ]; then
    rm -rf prisma
    cp -r ../../packages/database/prisma ./prisma
    npx prisma generate
  fi

  npm install
  cd ../..
done

echo "4. Starting infrastructure (PostgreSQL, Redis, Elasticsearch, Kafka)..."
docker compose up -d

echo "5. Waiting for services to be healthy..."
echo "   Waiting for PostgreSQL..."
until docker compose exec -T postgres pg_isready -U momentum 2>/dev/null; do sleep 1; done
echo "   Waiting for Redis..."
until docker compose exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; do sleep 1; done
echo "   Waiting for Elasticsearch..."
until curl -sf http://localhost:9200/_cluster/health > /dev/null 2>&1; do sleep 1; done

echo "6. Running database migrations..."
cd packages/database
npx prisma migrate dev --name init 2>/dev/null || npx prisma migrate deploy
cd ../..

echo "7. Seeding database..."
cd packages/database && npx ts-node prisma/seed.ts && cd ../..

echo ""
echo "=== Setup Complete! ==="
echo ""
echo "Start all services:"
echo "  bash scripts/start-all.sh"
echo ""
echo "Or start individually:"
echo "  cd services/api-gateway && npm run start:dev"
echo "  cd services/event-service && npm run start:dev"
echo "  cd services/booking-service && npm run start:dev"
echo "  cd services/search-service && npm run start:dev"
echo ""
echo "Service endpoints:"
echo "  API Gateway:     http://localhost:3000 (Swagger: http://localhost:3000/docs)"
echo "  Event Service:   http://localhost:3001 (Swagger: http://localhost:3001/docs)"
echo "  Booking Service: http://localhost:3002 (Swagger: http://localhost:3002/docs)"
echo "  Search Service:  http://localhost:3003 (Swagger: http://localhost:3003/docs)"
