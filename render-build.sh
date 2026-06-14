#!/usr/bin/env bash
set -o errexit

echo "🚀 Starting Render build for Gravity Maze..."

pip install --upgrade pip
pip install -r requirements.txt

echo "📁 Preparing static files..."
mkdir -p static

# If files are in root, move/copy them into static/.
# (For local repos you might already have correct structure.)
if [ -f "index.html" ]; then cp -f index.html static/index.html; fi
if [ -f "main.js" ];  then cp -f main.js static/main.js; fi
if [ -f "style.css" ]; then cp -f style.css static/styles.css; fi
if [ -f "styles.css" ]; then cp -f styles.css static/styles.css; fi

echo "✅ Build completed successfully!"

