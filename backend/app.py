"""
Flask Backend for SVS Tile Viewer with Annotation Support
Serves DZI tiles and manages GeoJSON annotations
"""

from flask import Flask, jsonify, request, send_from_directory, make_response
from flask_cors import CORS
import json
from pathlib import Path

app = Flask(__name__)
CORS(app)
 
# Configuration
BASE_DIR = Path(__file__).resolve().parent.parent

DATA_DIR = BASE_DIR / "data"
TILES_DIR = DATA_DIR / "tiles"
ANNOTATIONS_DIR = DATA_DIR / "annotations"
SLIDES_DIR = DATA_DIR / "slides"
COSMX_DIR = DATA_DIR / "cosmx"
COSMX_TILES_DIR = DATA_DIR / "cosmx_tiles"
# Ensure directories exist
TILES_DIR.mkdir(parents=True, exist_ok=True)
ANNOTATIONS_DIR.mkdir(parents=True, exist_ok=True)
COSMX_DIR.mkdir(parents=True, exist_ok=True)
COSMX_TILES_DIR.mkdir(parents=True, exist_ok=True)

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
    """CosMx DZI ì •ë³´ ë°˜í™˜"""
    dzi_file = COSMX_TILES_DIR / slide_id / f"{slide_id}.dzi"
    
    if not dzi_file.exists():
        return jsonify({'error': 'No CosMx data for this slide'}), 404
    
    print(f"[CosMx] âœ… DZI found: {slide_id}")
    return jsonify({
        'has_cosmx': True,
        'dzi_url': f"/cosmx_tiles/{slide_id}/{slide_id}.dzi",
        'slide_id': slide_id
    })

@app.route('/api/save-transform', methods=['POST'])
def save_transform():
    """Save transform.json for a slide"""
    try:
        data = request.json
        slide_id = data.get('slide_id')
        transform_data = data.get('transform_data')
        
        if not slide_id or not transform_data:
            return jsonify({'error': 'Missing slide_id or transform_data'}), 400
        
        # Save to cosmx_tiles/SLIDE_ID/transform.json
        output_dir = DATA_DIR / 'cosmx_tiles' / slide_id
        output_dir.mkdir(parents=True, exist_ok=True)
        
        output_file = output_dir / 'transform.json'
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(transform_data, f, indent=2)
        
        return jsonify({'success': True, 'path': str(output_file)})
    
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    
@app.route('/api/cosmx/<slide_id>/transform', methods=['GET'])
def get_cosmx_transform(slide_id):
    """CosMx Transform ì •ë³´ ë°˜í™˜"""
    transform_file = COSMX_TILES_DIR / slide_id / 'transform.json'
    
    if transform_file.exists():
        with open(transform_file, 'r', encoding='utf-8') as f:
            transform_data = json.load(f)
            print(f"[CosMx] ðŸ“ Transform loaded: {slide_id}")
            return jsonify(transform_data)
    
    # ê¸°ë³¸ê°’ (Identity)
    print(f"[CosMx] â„¹ï¸ No transform file, using identity: {slide_id}")
    return jsonify({
        'version': '1.0',
        'slide_id': slide_id,
        'transform': 'identity',
        'notes': 'No transform file found'
    })

@app.route('/cosmx_tiles/<path:filepath>')
def serve_cosmx_tiles(filepath):
    """CosMx DZI íƒ€ì¼ ì œê³µ"""
    return send_from_directory(COSMX_TILES_DIR, filepath)

@app.route('/api/cosmx/<slide_id>/stats', methods=['GET'])
def get_cosmx_stats(slide_id):
    """CosMx í†µê³„ ì •ë³´"""
    dzi_file = COSMX_TILES_DIR / slide_id / f"{slide_id}.dzi"
    
    if not dzi_file.exists():
        return jsonify({'error': 'No CosMx data found'}), 404
    
    return jsonify({
        'sample_id': slide_id,
        'has_cosmx': True,
        'type': 'dzi',
        'file': f"{slide_id}.dzi"
    })

# ============================================================================
# HEALTH CHECK
# ============================================================================

@app.route('/health')
def health():
    return jsonify({'status': 'healthy', 'service': 'SVS Tile Viewer'})

if __name__ == '__main__':
    print("ðŸš€ Starting SVS Tile Viewer Backend...")
    print(f"ðŸ“ Tiles directory: {TILES_DIR.absolute()}")
    print(f"ðŸ“ Annotations directory: {ANNOTATIONS_DIR.absolute()}")
    print(f"ðŸ§¬ CosMx directory: {COSMX_DIR.absolute()}")
    print(f"ðŸ§¬ CosMx tiles directory: {COSMX_TILES_DIR.absolute()}")
    app.run(debug=True, host='0.0.0.0', port=5000)