#!/usr/bin/env bash
set -euo pipefail

echo "=== Starting all Momentum services ==="
echo "Press Ctrl+C to stop all services"
echo ""

# Copy prisma schema to services that need it
for service in event-service booking-service search-service; do
  if [ ! -d "services/$service/prisma" ]; then
    cp -r momentum-database/prisma "services/$service/prisma"
  fi
done

# Start all services in background
cd momentum-api-gateway && npm run start:dev &
PID1=$!
cd ../..

cd momentum-event-service && npm run start:dev &
PID2=$!
cd ../..

cd momentum-booking-service && npm run start:dev &
PID3=$!
cd ../..

cd momentum-search-service && npm run start:dev &
PID4=$!
cd ../..

echo "Services starting..."
echo "  API Gateway:     http://localhost:3000"
echo "  Event Service:   http://localhost:3001"
echo "  Booking Service: http://localhost:3002"
echo "  Search Service:  http://localhost:3003"
echo ""

trap "kill $PID1 $PID2 $PID3 $PID4 2>/dev/null" EXIT INT TERM
wait
