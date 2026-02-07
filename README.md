# 🔬 SVS Pathology Viewer - MVP

**UGA IAI Seed Project - Aim 2 Implementation**  
Interactive whole-slide image viewer with annotation support for AI-pathology research.

---

## 🎯 Features (2-Week MVP)

- ✅ **SVS Tile Viewer**: OpenSeadragon-based DeepZoom viewer
- ✅ **CosMx Layer Toggle**: Show/hide molecular cell-type overlays
- ✅ **Polygon Annotation**: Draw and label regions (tumor, stroma, lymphocyte)
- ✅ **GeoJSON Support**: Save/load/export annotations
- ✅ **Multi-slide Support**: Switch between different samples

---

## 🏗️ Architecture

```
Frontend (Static HTML/JS)
    ↓
OpenSeadragon + Annotorious
    ↓
Flask Backend (Port 5000)
    ↓
File System
    ├── data/slides/       # Original .svs files
    ├── data/tiles/        # DZI tiles
    └── data/annotations/  # GeoJSON files
```

---

## 📦 Installation

### 1. System Dependencies (macOS)

```bash
# Install OpenSlide (required for SVS support)
brew install openslide

# Install libvips (for tile generation)
brew install vips
```

### 2. Python Environment

```bash
# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

---

## 🚀 Quick Start

### Step 1: Generate Tiles

```bash
# Single file
python tile_generator.py data/slides/sample.svs data/tiles/

# Batch process
python tile_generator.py data/slides/ data/tiles/
```

**Expected output structure:**
```
data/tiles/
└── sample/
    ├── sample.dzi          # Metadata file
    └── sample_files/       # Tile pyramid
        ├── 0/
        ├── 1/
        └── ...
```

### Step 2: Start Backend

```bash
python backend_app.py
```

Server runs on `http://localhost:5000`

### Step 3: Open Frontend

```bash
# Serve with Python
cd frontend/
python3 -m http.server 8080

# Or use any static server
# npx http-server -p 8080
```

Open browser: `http://localhost:8080`

---

## 🎮 Usage Guide

### Basic Workflow

1. **Select Slide**: Choose from dropdown in sidebar
2. **Set Label**: Click tumor/stroma/lymphocyte/other button
3. **Draw Annotation**: Click on viewer to start polygon
4. **Save**: Click "Save Annotations" to persist to backend
5. **Export**: Download GeoJSON for external analysis

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Delete` | Remove selected annotation |
| `Esc` | Cancel current drawing |

### CosMx Layer

- Click "Show Layer" to overlay molecular cell-type data
- Toggle on/off to compare with H&E morphology
- **Note**: MVP shows placeholder data; integrate real CosMx in Week 3+

---

## 📁 File Formats

### GeoJSON Annotation Structure

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Polygon",
        "coordinates": [[[x1,y1], [x2,y2], ...]]
      },
      "properties": {
        "id": "annotation_id",
        "label": "tumor",
        "comment": "Optional note"
      }
    }
  ]
}
```

### DZI Format

OpenSeadragon uses **Deep Zoom Image (DZI)** format:
- `.dzi` file: XML metadata (dimensions, tile size, format)
- `_files/` directory: Pyramid of JPEG tiles

---

## 🔧 API Endpoints

### Backend REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/slides` | List available slides |
| `GET` | `/tiles/<path>` | Serve DZI tiles |
| `GET` | `/api/annotations/<slide_id>` | Load annotations |
| `POST` | `/api/annotations/<slide_id>` | Save annotations |
| `DELETE` | `/api/annotations/<slide_id>` | Delete annotations |
| `GET` | `/api/cosmx/<slide_id>` | Get CosMx overlay |

---

## 🐛 Troubleshooting

### Issue: Tiles not loading

**Check:**
```bash
# Verify DZI file exists
ls data/tiles/sample/sample.dzi

# Check tile directory
ls data/tiles/sample/sample_files/

# Test backend
curl http://localhost:5000/api/slides
```

### Issue: OpenSlide error

```bash
# macOS
brew reinstall openslide

# Ubuntu
sudo apt-get install openslide-tools
```

### Issue: CORS errors

- Ensure Flask CORS is enabled (already in `backend_app.py`)
- Use consistent ports (backend: 5000, frontend: 8080)

---

## 🎨 Customization

### Add New Annotation Labels

**1. Update HTML** (`index.html`):
```html
<button class="label-btn" data-label="necrosis">Necrosis</button>
```

**2. Update CSS** (add style):
```css
.a9s-annotation.necrosis {
    stroke: #9b59b6;
    fill: rgba(155, 89, 182, 0.2);
}
```

### Change Tile Size

**In `tile_generator.py`:**
```python
image.dzsave(
    tile_size=512,  # Change from 256
    overlap=2       # Increase overlap
)
```

---

## 📚 Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Backend | Flask | 3.0 |
| Tile Server | Static files | - |
| Viewer | OpenSeadragon | 4.1.0 |
| Annotations | Annotorious | 2.7.14 |
| Image Processing | pyvips | 2.2.1 |
| Slide Format | OpenSlide | 1.3.1 |

---

## 🗓️ Development Timeline

### Week 1 (Completed)
- ✅ Backend tile serving
- ✅ OpenSeadragon integration
- ✅ Basic annotation drawing

### Week 2 (Current)
- 🔄 GeoJSON persistence
- 🔄 CosMx layer toggle
- 🔄 UI polish & testing

### Week 3+ (Future)
- ⏳ Dual-panel synchronized viewing (H&E + CosMx)
- ⏳ Real CosMx data integration
- ⏳ Quantitative metrics (cTILs, LTR)
- ⏳ Export to Aim 1 training pipeline

---

## 🤝 Contributing

This is a research prototype. For questions:

- **PI**: Eugene Douglass (Pharmaceutical Sciences)
- **Co-PI**: Suchendra Bhandarkar (Computing)
- **Pathology**: Lillian Oliviera, Megan Corbett (CVM)

---

## 📄 License

Developed for UGA IAI Seed Grant (January-June 2026)

---

## 🔗 References

- OpenSeadragon: https://openseadragon.github.io/
- Annotorious: https://recogito.github.io/annotorious/
- OpenSlide: https://openslide.org/
- Project Proposal: `AI-path_IAI-seed_v09.pdf`

---

**Last Updated**: January 2026  
**Status**: MVP Phase (Week 2/6)
