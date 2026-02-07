# SVS Viewer MVP - Project Structure

```
svs-viewer-mvp/
│
├── README.md                   # 📚 Complete documentation
├── quickstart.sh               # 🚀 One-command setup script
│
├── backend/                    # Python Flask server
│   ├── app.py                  # Main Flask application
│   ├── tile_generator.py       # SVS → DZI converter
│   └── requirements.txt        # Python dependencies
│
├── frontend/                   # Static web interface
│   ├── index.html              # Main viewer page
│   └── viewer.js               # OpenSeadragon + Annotorious logic
│
└── data/                       # Data directories (create these)
    ├── slides/                 # 📁 Place .svs files here
    ├── tiles/                  # 🖼️  Generated tiles (auto-created)
    └── annotations/            # 📝 Saved GeoJSON files (auto-created)
```

## 🎯 MVP Features Implemented

✅ **Core Functionality**
- [x] SVS tile viewer with pan/zoom
- [x] Slide selection dropdown
- [x] Polygon annotation tool
- [x] Label selection (tumor, stroma, lymphocyte, other)
- [x] GeoJSON save/load/export
- [x] CosMx layer toggle (UI ready, data integration pending)

✅ **User Experience**
- [x] Modern dark theme UI
- [x] Real-time annotation count
- [x] Status bar with feedback
- [x] Navigator mini-map
- [x] Delete mode

## 📋 What You Need to Add

1. **SVS Files**: Place in `data/slides/`
2. **CosMx Data**: Integrate with `/api/cosmx` endpoint
3. **Real Testing**: Test with actual TNBC samples

## 🔄 Integration with Aim 1

This viewer is designed to connect with Aim 1's CNN outputs:

1. **Input**: Load AI-predicted segmentation masks
2. **Review**: Pathologists validate/correct in this interface
3. **Output**: Export corrected GeoJSON back to training pipeline

## 📞 Support

- Check README.md for detailed setup
- Run `./quickstart.sh` for guided installation
- Backend runs on port 5000
- Frontend runs on port 8080
