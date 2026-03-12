#!/bin/bash
set -e

echo "=== Blue Water Agents Build ==="
echo "Node: $(node --version)"
echo "npm: $(npm --version)"

echo ""
echo "Running build..."
npm run build

echo ""
echo "=== Verifying build output ==="
if [ -f "dist/index.cjs" ]; then
  echo "OK dist/index.cjs: $(du -sh dist/index.cjs | cut -f1)"
else
  echo "ERROR: dist/index.cjs not found!"
  exit 1
fi

if [ -d "dist/public" ]; then
  echo "OK dist/public: $(du -sh dist/public | cut -f1)"
else
  echo "ERROR: dist/public not found!"
  exit 1
fi

echo ""
echo "=== Build complete ==="
