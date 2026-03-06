"""
Flask Backend for SVS Tile Viewer with Annotation & QC Support
Serves DZI tiles, manages GeoJSON annotations, and Phase 1 QC Status
"""

from flask import Flask, jsonify, request, send_from_directory, make_response
from flask_cors import CORS
import json
from pathlib import Path
from datetime import datetime

app = Flask(__name__)
CORS(app)

# Configuration
TILES_DIR = Path(r"D:\병리\data\tiles")
ANNOTATIONS_DIR = Path(r"D:\병리\data\annotations")
COSMX_DIR = Path(r"D:\병리\data\cosmx")
COSMX_TILES_DIR = Path(r"D:\병리\data\cosmx_tiles")
QC_DIR = Path(r"D:\병리\data\qc_results") # Phase 1: QC 상태 저장 폴더

# Ensure directories exist
TILES_DIR.mkdir(parents=True, exist_ok=True)
ANNOTATIONS_DIR.mkdir(parents=True, exist_ok=True)
COSMX_DIR.mkdir(parents=True, exist_ok=True)
COSMX_TILES_DIR.mkdir(parents=True, exist_ok=True)
QC_DIR.mkdir(parents=True, exist_ok=True)

# ============================================================================
# COMMON RESPONSE HEADERS (CORS/CORP)
# ============================================================================

def _add_common_headers(resp):
    resp.headers['Access-Control-Allow-Origin'] = '*'
    resp.headers['Access-Control-Allow-Headers'] = '*'
    resp.headers['Access-Control-Allow-Methods'] = 'GET,HEAD,OPTIONS'
    resp.headers['Cross-Origin-Resource-Policy'] = 'cross-origin'
    resp.headers['Cache-Control'] = 'no-store'
    return resp

@app.after_request
def after_request(resp):
    return _add_common_headers(resp)

# ============================================================================
# TILE SERVING ENDPOINTS
# ============================================================================

@app.route('/api/slides', methods=['GET'])
def list_slides():
    slides = []
    for slide_dir in TILES_DIR.iterdir():
        if slide_dir.is_dir():
            dzi_file = slide_dir / f"{slide_dir.name}.dzi"
            if dzi_file.exists():
                slides.append({
                    'id': slide_dir.name,
                    'name': slide_dir.name,
                    'dzi_url': f"/tiles/{slide_dir.name}/{slide_dir.name}.dzi"
                })
    return jsonify(slides)

@app.route('/tiles/<path:filepath>')
def serve_tiles(filepath):
    return send_from_directory(TILES_DIR, filepath)

# ============================================================================
# QC STATUS ENDPOINTS (For Phase 1 Sample Selection)
# ============================================================================

@app.route('/api/qc/<slide_id>', methods=['GET'])
def get_qc_status(slide_id):
    qc_file = QC_DIR / f"{slide_id}.json"
    if qc_file.exists():
        with open(qc_file, 'r', encoding='utf-8') as f:
            return jsonify(json.load(f))
    return jsonify({'status': 'unreviewed'})

@app.route('/api/qc/<slide_id>', methods=['POST'])
def save_qc_status(slide_id):
    qc_file = QC_DIR / f"{slide_id}.json"
    data = request.json
    
    qc_data = {
        'slide_id': slide_id,
        'status': data.get('status'),
        'timestamp': datetime.now().isoformat(),
        'reviewer': 'admin'
    }
    
    with open(qc_file, 'w', encoding='utf-8') as f:
        json.dump(qc_data, f, indent=2)
        
    return jsonify({'status': 'success', 'qc_status': qc_data['status']})

# ============================================================================
# ANNOTATION ENDPOINTS (GeoJSON)
# ============================================================================

@app.route('/api/annotations/<slide_id>', methods=['GET'])
def get_annotations(slide_id):
    annotation_file = ANNOTATIONS_DIR / f"{slide_id}.json"
    if not annotation_file.exists():
        return jsonify({"type": "FeatureCollection", "features": []})
    with open(annotation_file, 'r', encoding='utf-8') as f:
        return jsonify(json.load(f))

@app.route('/api/annotations/<slide_id>', methods=['POST'])
def save_annotations(slide_id):
    annotation_file = ANNOTATIONS_DIR / f"{slide_id}.json"
    data = request.json
    if not isinstance(data, dict) or data.get('type') != 'FeatureCollection':
        return jsonify({'error': 'Invalid GeoJSON format'}), 400
    with open(annotation_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    return jsonify({'status': 'success', 'saved': len(data.get('features', []))})

@app.route('/api/annotations/<slide_id>', methods=['DELETE'])
def delete_annotations(slide_id):
    annotation_file = ANNOTATIONS_DIR / f"{slide_id}.json"
    if annotation_file.exists():
        annotation_file.unlink()
        return jsonify({'status': 'deleted'})
    return jsonify({'status': 'not_found'}), 404

# ============================================================================
# COSMX DZI ENDPOINTS
# ============================================================================

@app.route('/api/cosmx/<slide_id>/dzi', methods=['GET'])
def get_cosmx_dzi(slide_id):
    dzi_file = COSMX_TILES_DIR / slide_id / f"{slide_id}.dzi"
    if not dzi_file.exists():
        return jsonify({'error': 'No CosMx data for this slide'}), 404
    return jsonify({
        'has_cosmx': True,
        'dzi_url': f"/cosmx_tiles/{slide_id}/{slide_id}.dzi",
        'slide_id': slide_id
    })

@app.route('/api/cosmx/<slide_id>/transform', methods=['GET'])
def get_cosmx_transform(slide_id):
    transform_file = COSMX_TILES_DIR / slide_id / 'transform.json'
    if transform_file.exists():
        with open(transform_file, 'r', encoding='utf-8') as f:
            return jsonify(json.load(f))
    return jsonify({
        'version': '1.0',
        'slide_id': slide_id,
        'transform': 'identity',
        'notes': 'No transform file found'
    })

@app.route('/cosmx_tiles/<path:filepath>')
def serve_cosmx_tiles(filepath):
    return send_from_directory(COSMX_TILES_DIR, filepath)

# ============================================================================
# HEALTH CHECK
# ============================================================================

@app.route('/health')
def health():
    return jsonify({'status': 'healthy', 'service': 'SVS Tile Viewer'})

if __name__ == '__main__':
    print("🚀 Starting SVS Tile Viewer Backend...")
    print(f"📂 QC directory: {QC_DIR.absolute()}")
    app.run(debug=True, host='0.0.0.0', port=5000)