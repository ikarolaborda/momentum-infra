#!/usr/bin/env bash
set -euo pipefail

echo "=== Installing all dependencies ==="

echo "Installing shared packages..."
cd packages/shared && npm install && npm run build && cd ../..
cd packages/database && npm install && cd ../..

echo "Installing services..."
for service in api-gateway event-service booking-service search-service; do
  echo "  $service..."
  cd "services/$service" && npm install && cd ../..
done

echo "Done!"
