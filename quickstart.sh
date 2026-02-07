#!/bin/bash

# Quick Start Script for SVS Viewer MVP
# Run this to set up and launch the application

set -e

echo "🔬 SVS Pathology Viewer - Quick Start"
echo "======================================"
echo ""

# Check Python
if ! command -v python3 &> /dev/null; then
    echo "❌ Python 3 not found. Please install Python 3.8+"
    exit 1
fi

echo "✅ Python found: $(python3 --version)"

# Check if venv exists
if [ ! -d "venv" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv venv
fi

echo "🔄 Activating virtual environment..."
source venv/bin/activate

# Install dependencies
echo "📥 Installing dependencies..."
pip install -q -r backend/requirements.txt

echo ""
echo "✅ Setup complete!"
echo ""
echo "📝 Next steps:"
echo ""
echo "1. Place your .svs files in: data/slides/"
echo "2. Generate tiles:"
echo "   python backend/tile_generator.py data/slides/sample.svs data/tiles/"
echo ""
echo "3. Start backend (in one terminal):"
echo "   python backend/app.py"
echo ""
echo "4. Start frontend (in another terminal):"
echo "   cd frontend && python3 -m http.server 8080"
echo ""
echo "5. Open browser: http://localhost:8080"
echo ""
echo "📚 For detailed instructions, see README.md"
echo ""
