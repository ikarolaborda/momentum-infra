#!/usr/bin/env bash
set -euo pipefail

echo "=== Installing all dependencies ==="

echo "Installing shared packages..."
cd momentum-shared && npm install && npm run build && cd ../..
cd momentum-database && npm install && cd ../..

echo "Installing services..."
for service in api-gateway event-service booking-service search-service; do
  echo "  $service..."
  cd "$service" && npm install && cd ../..
done

echo "Done!"
