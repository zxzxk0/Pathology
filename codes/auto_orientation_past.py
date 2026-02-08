"""
Auto Orientation Detection for CosMx-H&E Registration (V4)
Hybrid approach: Supports both FULL and PARTIAL matching

Algorithm:
1. Load images preserving aspect ratio
2. Detect if CosMx is full or partial coverage
3. Full coverage → Phase Correlation (existing V2)
4. Partial coverage → Multi-scale Template Matching (sliding window)
5. Test all 16 orientations (4 rot × 2 flipX × 2 flipY)

Usage:
    python auto_orientation_v4.py --slide-id "SLIDE_ID"
    python auto_orientation_v4.py --slide-id "SLIDE_ID" --mode partial
    python auto_orientation_v4.py --slide-id "SLIDE_ID" --mode full
"""

import numpy as np
import cv2
import json
from pathlib import Path
import argparse
from PIL import Image
import sys
import io

# UTF-8 encoding (Windows)
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

Image.MAX_IMAGE_PIXELS = None


# ============================================================================
# IMAGE LOADING (Preserving Aspect Ratio)
# ============================================================================

def load_he_image(he_path, max_size=1024):
    """Load H&E image preserving aspect ratio"""
    print(f"  [Load] H&E: {Path(he_path).name}")
    
    he_path = Path(he_path)
    
    if he_path.suffix.lower() == '.svs':
        try:
            from openslide import OpenSlide
            slide = OpenSlide(str(he_path))
            
            # Get dimensions and calculate thumbnail size
            w, h = slide.dimensions
            scale = min(max_size / w, max_size / h)
            thumb_size = (int(w * scale), int(h * scale))
            
            thumb = slide.get_thumbnail(thumb_size)
            slide.close()
            
            img = np.array(thumb)
            img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
            
            return img, (w, h)
            
        except Exception as e:
            raise ValueError(f"Failed to load SVS: {e}")
    else:
        pil_img = Image.open(str(he_path))
        orig_size = pil_img.size
        
        if pil_img.mode != 'RGB':
            pil_img = pil_img.convert('RGB')
        
        # Resize preserving aspect ratio
        pil_img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
        
        img = np.array(pil_img)
        img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
        
        return img, orig_size


def load_cosmx_image(cosmx_path, max_size=1024):
    """Load CosMx PNG image preserving aspect ratio"""
    print(f"  [Load] CosMx: {Path(cosmx_path).name}")
    
    pil_img = Image.open(str(cosmx_path))
    orig_size = pil_img.size
    
    if pil_img.mode == 'RGBA':
        bg = Image.new('RGB', pil_img.size, (255, 255, 255))
        bg.paste(pil_img, mask=pil_img.split()[3])
        pil_img = bg
    elif pil_img.mode != 'RGB':
        pil_img = pil_img.convert('RGB')
    
    # Resize preserving aspect ratio
    pil_img.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    
    img = np.array(pil_img)
    img = cv2.cvtColor(img, cv2.COLOR_RGB2BGR)
    
    return img, orig_size


# ============================================================================
# MASK GENERATION
# ============================================================================

def create_he_mask(img):
    """Create tissue mask from H&E image"""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    
    # Remove white background
    _, mask = cv2.threshold(gray, 235, 255, cv2.THRESH_BINARY_INV)
    
    # Morphological operations
    kernel = np.ones((5, 5), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    
    return mask


def create_cosmx_mask(img, dilate_iterations=3):
    """Create mask from CosMx image (colored cell dots)"""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1]
    
    # Combine: non-white AND non-black, OR has color
    mask1 = gray < 250  # Not white
    mask2 = gray > 5    # Not black
    mask3 = saturation > 20  # Has color
    
    mask = ((mask1 & mask2) | mask3).astype(np.uint8) * 255
    
    # Dilate to connect sparse points
    kernel = np.ones((7, 7), np.uint8)
    mask = cv2.dilate(mask, kernel, iterations=dilate_iterations)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    
    return mask


# ============================================================================
# COVERAGE DETECTION
# ============================================================================

def estimate_coverage_ratio(he_mask, cosmx_mask):
    """
    Estimate if CosMx covers full or partial H&E tissue
    
    Returns:
        ratio: estimated coverage ratio
        mode: 'full' or 'partial'
    """
    he_area = (he_mask > 0).sum()
    cosmx_area = (cosmx_mask > 0).sum()
    
    if he_area == 0:
        return 0, 'unknown'
    
    # Image dimensions
    he_h, he_w = he_mask.shape
    cosmx_h, cosmx_w = cosmx_mask.shape
    
    he_img_area = he_h * he_w
    cosmx_img_area = cosmx_h * cosmx_w
    
    # Tissue density
    he_density = he_area / he_img_area
    cosmx_density = cosmx_area / cosmx_img_area
    
    # Size ratio (image size, not tissue)
    img_size_ratio = cosmx_img_area / he_img_area
    
    # Tissue area ratio
    tissue_ratio = cosmx_area / he_area
    
    print(f"    H&E: {he_w}x{he_h}, tissue={he_area} px ({he_density*100:.1f}%)")
    print(f"    CosMx: {cosmx_w}x{cosmx_h}, tissue={cosmx_area} px ({cosmx_density*100:.1f}%)")
    print(f"    Image size ratio: {img_size_ratio:.2f}")
    print(f"    Tissue area ratio: {tissue_ratio:.2f}")
    
    # Decision logic:
    # 1. If CosMx image is much smaller than H&E → partial
    # 2. If tissue areas are very different → partial
    # 3. If CosMx has more tissue than H&E (unusual) → try partial (template matching)
    
    if img_size_ratio < 0.6:
        mode = 'partial'
        reason = "CosMx image much smaller"
    elif tissue_ratio > 1.5:
        # CosMx has more tissue - unusual, probably need partial matching
        mode = 'partial'
        reason = "CosMx tissue > H&E tissue (unusual)"
    elif tissue_ratio < 0.4:
        mode = 'partial'
        reason = "CosMx tissue much smaller"
    else:
        mode = 'full'
        reason = "Similar coverage"
    
    print(f"    Decision: {mode.upper()} ({reason})")
    
    return tissue_ratio, mode


# ============================================================================
# TRANSFORMATION
# ============================================================================

def apply_transform(img, rotation, flip_x, flip_y):
    """Apply rotation and flips"""
    result = img.copy()
    
    # Rotation
    k = rotation // 90
    if k > 0:
        result = np.rot90(result, k=k)
    
    # Flips
    if flip_x:
        result = np.fliplr(result)
    if flip_y:
        result = np.flipud(result)
    
    return np.ascontiguousarray(result)


def translate_image(img, dx, dy):
    """Translate image by (dx, dy) pixels"""
    M = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(img, M, (img.shape[1], img.shape[0]))


# ============================================================================
# FULL MATCHING (Phase Correlation - existing V2 approach)
# ============================================================================

def phase_correlation_match(he_mask, cosmx_mask_transformed):
    """Find best translation using phase correlation"""
    # Resize CosMx to match H&E size
    he_h, he_w = he_mask.shape
    cosmx_resized = cv2.resize(cosmx_mask_transformed, (he_w, he_h), interpolation=cv2.INTER_AREA)
    
    # Normalize
    f1 = np.float32(he_mask)
    f2 = np.float32(cosmx_resized)
    
    f1 = (f1 - f1.mean()) / (f1.std() + 1e-6)
    f2 = (f2 - f2.mean()) / (f2.std() + 1e-6)
    
    # Phase correlation
    shift, response = cv2.phaseCorrelate(f1, f2)
    dx, dy = int(round(shift[0])), int(round(shift[1]))
    
    # Apply translation and compute overlap
    aligned = translate_image(cosmx_resized, dx, dy)
    
    # IoU score
    intersection = np.logical_and(he_mask > 0, aligned > 0).sum()
    union = np.logical_or(he_mask > 0, aligned > 0).sum()
    iou = intersection / (union + 1e-6)
    
    # If position is significantly negative, the match might be unreliable
    # In that case, also try position (0,0) and compare
    if dx < -he_w // 4 or dy < -he_h // 4:
        # Try center alignment as fallback
        aligned_center = cosmx_resized  # No translation
        intersection_center = np.logical_and(he_mask > 0, aligned_center > 0).sum()
        union_center = np.logical_or(he_mask > 0, aligned_center > 0).sum()
        iou_center = intersection_center / (union_center + 1e-6)
        
        if iou_center > iou:
            dx, dy = 0, 0
            iou = iou_center
    
    # Normalize translation to 0-1
    norm_dx = dx / he_w
    norm_dy = dy / he_h
    
    return {
        'dx': dx,
        'dy': dy,
        'norm_dx': norm_dx,
        'norm_dy': norm_dy,
        'score': iou,
        'scale': 1.0,
        'method': 'phase_correlation'
    }


# ============================================================================
# PARTIAL MATCHING (Multi-scale Template Matching)
# ============================================================================

def template_matching_multiscale(he_mask, cosmx_mask_transformed, scales=None):
    """
    Find CosMx location in H&E using multi-scale template matching
    
    CosMx (template) slides over H&E (source) to find best match position
    """
    if scales is None:
        scales = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2]
    
    he_h, he_w = he_mask.shape
    cosmx_h, cosmx_w = cosmx_mask_transformed.shape
    
    best_score = -1
    best_result = None
    
    for scale in scales:
        # Scale the template (CosMx)
        new_w = int(cosmx_w * scale)
        new_h = int(cosmx_h * scale)
        
        # Skip if template is larger than source
        if new_w >= he_w or new_h >= he_h:
            continue
        
        # Skip if template is too small
        if new_w < 20 or new_h < 20:
            continue
        
        scaled_template = cv2.resize(cosmx_mask_transformed, (new_w, new_h), 
                                      interpolation=cv2.INTER_AREA)
        
        # Template matching
        try:
            result = cv2.matchTemplate(he_mask, scaled_template, cv2.TM_CCOEFF_NORMED)
            _, max_val, _, max_loc = cv2.minMaxLoc(result)
            
            if max_val > best_score:
                best_score = max_val
                best_result = {
                    'dx': max_loc[0],
                    'dy': max_loc[1],
                    'norm_dx': max_loc[0] / he_w,
                    'norm_dy': max_loc[1] / he_h,
                    'scale': scale,
                    'score': max_val,
                    'template_size': (new_w, new_h),
                    'method': 'template_matching'
                }
        except cv2.error:
            continue
    
    if best_result is None:
        # Fallback
        return {
            'dx': 0, 'dy': 0, 'norm_dx': 0, 'norm_dy': 0,
            'scale': 1.0, 'score': 0, 'method': 'template_matching_failed'
        }
    
    return best_result


def compute_iou_at_location(he_mask, cosmx_mask_transformed, location, scale):
    """Compute IoU at a specific location and scale"""
    he_h, he_w = he_mask.shape
    cosmx_h, cosmx_w = cosmx_mask_transformed.shape
    
    # Scale template
    new_w = int(cosmx_w * scale)
    new_h = int(cosmx_h * scale)
    
    if new_w < 1 or new_h < 1:
        return 0
    
    scaled = cv2.resize(cosmx_mask_transformed, (new_w, new_h), interpolation=cv2.INTER_AREA)
    
    # Place at location
    x, y = location
    x2 = min(x + new_w, he_w)
    y2 = min(y + new_h, he_h)
    
    if x2 <= x or y2 <= y:
        return 0
    
    # Extract regions
    he_region = he_mask[y:y2, x:x2]
    cosmx_region = scaled[:y2-y, :x2-x]
    
    # IoU
    intersection = np.logical_and(he_region > 0, cosmx_region > 0).sum()
    union = np.logical_or(he_region > 0, cosmx_region > 0).sum()
    
    return intersection / (union + 1e-6)


# ============================================================================
# HYBRID MATCHING (Auto-select best method)
# ============================================================================

def find_best_alignment_hybrid(he_mask, cosmx_mask, mode='auto'):
    """
    Find best alignment using hybrid approach
    
    Args:
        he_mask: H&E tissue mask
        cosmx_mask: CosMx tissue mask
        mode: 'auto', 'full', or 'partial'
    
    Returns:
        best candidate, all candidates
    """
    print("\n[Algorithm] Hybrid Matching (Full + Partial)")
    
    # Detect coverage mode
    if mode == 'auto':
        ratio, detected_mode = estimate_coverage_ratio(he_mask, cosmx_mask)
    else:
        detected_mode = mode
        print(f"    Forced mode: {detected_mode.upper()}")
    
    # Test all 16 orientations
    print("\n  [Testing] 16 orientations...")
    print("  " + "-" * 95)
    print("  {:>3} {:>6} {:>6} {:>6} {:>10} {:>10} {:>8} {:>12} {:>12}".format(
        "#", "Rot", "FlipX", "FlipY", "Score", "IoU", "Scale", "Position", "Method"
    ))
    print("  " + "-" * 95)
    
    candidates = []
    idx = 0
    
    for rotation in [0, 90, 180, 270]:
        for flip_x in [False, True]:
            for flip_y in [False, True]:
                idx += 1
                
                # Transform CosMx mask
                transformed = apply_transform(cosmx_mask, rotation, flip_x, flip_y)
                
                # Match based on mode
                if detected_mode == 'full':
                    result = phase_correlation_match(he_mask, transformed)
                else:
                    result = template_matching_multiscale(he_mask, transformed)
                
                # Compute IoU for verification
                if detected_mode == 'partial' and result['score'] > 0:
                    iou = compute_iou_at_location(
                        he_mask, transformed,
                        (result['dx'], result['dy']),
                        result['scale']
                    )
                else:
                    iou = result['score']
                
                # Combined score
                combined = 0.7 * result['score'] + 0.3 * iou
                
                candidate = {
                    'rotation': rotation,
                    'flipX': flip_x,
                    'flipY': flip_y,
                    'dx': result['dx'],
                    'dy': result['dy'],
                    'norm_dx': result['norm_dx'],
                    'norm_dy': result['norm_dy'],
                    'scale': result['scale'],
                    'match_score': result['score'],
                    'iou_score': iou,
                    'combined_score': combined,
                    'method': result['method']
                }
                candidates.append(candidate)
                
                print("  {:>3} {:>6} {:>6} {:>6} {:>10.4f} {:>10.4f} {:>8.2f} {:>12} {:>12}".format(
                    idx,
                    f"{rotation}°",
                    "Y" if flip_x else "N",
                    "Y" if flip_y else "N",
                    result['score'],
                    iou,
                    result['scale'],
                    f"({result['dx']}, {result['dy']})",
                    result['method'][:12]
                ))
    
    print("  " + "-" * 95)
    
    # Find best candidate
    best = max(candidates, key=lambda x: x['combined_score'])
    
    # FALLBACK: If best score is very low, try the other method
    if best['combined_score'] < 0.15 and detected_mode == 'full':
        print("\n  [Fallback] Low score with phase_correlation, trying template_matching...")
        
        fallback_candidates = []
        for rotation in [0, 90, 180, 270]:
            for flip_x in [False, True]:
                for flip_y in [False, True]:
                    transformed = apply_transform(cosmx_mask, rotation, flip_x, flip_y)
                    result = template_matching_multiscale(he_mask, transformed)
                    
                    iou = compute_iou_at_location(
                        he_mask, transformed,
                        (result['dx'], result['dy']),
                        result['scale']
                    )
                    combined = 0.7 * result['score'] + 0.3 * iou
                    
                    fallback_candidates.append({
                        'rotation': rotation,
                        'flipX': flip_x,
                        'flipY': flip_y,
                        'dx': result['dx'],
                        'dy': result['dy'],
                        'norm_dx': result['norm_dx'],
                        'norm_dy': result['norm_dy'],
                        'scale': result['scale'],
                        'match_score': result['score'],
                        'iou_score': iou,
                        'combined_score': combined,
                        'method': 'template_fallback'
                    })
        
        fallback_best = max(fallback_candidates, key=lambda x: x['combined_score'])
        
        if fallback_best['combined_score'] > best['combined_score']:
            print(f"    Fallback improved: {best['combined_score']:.4f} → {fallback_best['combined_score']:.4f}")
            best = fallback_best
            candidates = fallback_candidates
            detected_mode = 'partial_fallback'
        else:
            print(f"    Fallback not better: {fallback_best['combined_score']:.4f}")
    
    # Top 3
    sorted_candidates = sorted(candidates, key=lambda x: -x['combined_score'])
    print("\n  [Top 3 Results]")
    for i, c in enumerate(sorted_candidates[:3], 1):
        print(f"    {i}. Rot={c['rotation']}°, FlipX={c['flipX']}, FlipY={c['flipY']}, "
              f"Scale={c['scale']:.2f}, Score={c['combined_score']:.4f}")
    
    print(f"\n  [Best] Rotation={best['rotation']}°, FlipX={best['flipX']}, FlipY={best['flipY']}")
    print(f"         Scale={best['scale']:.2f}, Position=({best['dx']}, {best['dy']})")
    print(f"         Score={best['combined_score']:.4f}")
    
    return best, candidates, detected_mode


# ============================================================================
# REFINEMENT (Optional)
# ============================================================================

def refine_alignment(he_mask, cosmx_mask, best, search_range=30, search_step=3):
    """Refine alignment with local search"""
    print("\n  [Refining] Local search around best position...")
    
    rotation = best['rotation']
    flip_x = best['flipX']
    flip_y = best['flipY']
    init_dx = best['dx']
    init_dy = best['dy']
    scale = best['scale']
    
    # Transform CosMx
    transformed = apply_transform(cosmx_mask, rotation, flip_x, flip_y)
    
    best_score = best['combined_score']
    best_dx, best_dy = init_dx, init_dy
    
    for dx in range(init_dx - search_range, init_dx + search_range + 1, search_step):
        for dy in range(init_dy - search_range, init_dy + search_range + 1, search_step):
            if dx < 0 or dy < 0:
                continue
            
            iou = compute_iou_at_location(he_mask, transformed, (dx, dy), scale)
            
            if iou > best_score:
                best_score = iou
                best_dx, best_dy = dx, dy
    
    print(f"    Before: ({init_dx}, {init_dy}) → After: ({best_dx}, {best_dy})")
    print(f"    Score: {best['combined_score']:.4f} → {best_score:.4f}")
    
    return best_dx, best_dy, best_score


# ============================================================================
# VISUALIZATION (Debug)
# ============================================================================

def visualize_alignment(he_mask, cosmx_mask, best, output_path):
    """Create debug visualization"""
    # Transform CosMx
    transformed = apply_transform(cosmx_mask, best['rotation'], best['flipX'], best['flipY'])
    
    # Scale
    scale = best['scale']
    new_h = int(transformed.shape[0] * scale)
    new_w = int(transformed.shape[1] * scale)
    scaled = cv2.resize(transformed, (new_w, new_h), interpolation=cv2.INTER_AREA)
    
    # Create RGB visualization
    he_h, he_w = he_mask.shape
    vis = np.zeros((he_h, he_w, 3), dtype=np.uint8)
    
    # H&E in blue
    vis[:, :, 0] = he_mask  # Blue channel
    
    # CosMx in green (at detected position)
    dx, dy = best['dx'], best['dy']
    
    # Handle negative positions (clip to valid range)
    # Source (scaled CosMx) coordinates
    src_x1 = max(0, -dx)
    src_y1 = max(0, -dy)
    src_x2 = min(new_w, he_w - dx)
    src_y2 = min(new_h, he_h - dy)
    
    # Destination (vis) coordinates
    dst_x1 = max(0, dx)
    dst_y1 = max(0, dy)
    dst_x2 = min(he_w, dx + new_w)
    dst_y2 = min(he_h, dy + new_h)
    
    # Check if there's valid overlap
    if src_x2 > src_x1 and src_y2 > src_y1 and dst_x2 > dst_x1 and dst_y2 > dst_y1:
        # Ensure dimensions match
        w = min(src_x2 - src_x1, dst_x2 - dst_x1)
        h = min(src_y2 - src_y1, dst_y2 - dst_y1)
        
        if w > 0 and h > 0:
            cosmx_roi = scaled[src_y1:src_y1+h, src_x1:src_x1+w]
            vis[dst_y1:dst_y1+h, dst_x1:dst_x1+w, 1] = np.maximum(
                vis[dst_y1:dst_y1+h, dst_x1:dst_x1+w, 1],
                cosmx_roi
            )
    
    # Add text info
    cv2.putText(vis, f"Rot:{best['rotation']} FlipX:{best['flipX']} FlipY:{best['flipY']}", 
                (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    cv2.putText(vis, f"Pos:({dx},{dy}) Scale:{best['scale']:.2f} Score:{best['combined_score']:.3f}",
                (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    
    cv2.imwrite(str(output_path), vis)
    print(f"  [Debug] Saved: {output_path}")


# ============================================================================
# MAIN
# ============================================================================

def process_single_slide(slide_id, data_dir, mode, refine, debug, size):
    """Process a single slide"""
    slides_dir = data_dir / 'slides'
    cosmx_dir = data_dir / 'cosmx'
    cosmx_tiles_dir = data_dir / 'cosmx_tiles' / slide_id
    
    # Find H&E file
    he_svs = slides_dir / f"{slide_id}.svs"
    he_png = slides_dir / f"{slide_id}.png"
    
    if he_svs.exists():
        he_path = he_svs
    elif he_png.exists():
        he_path = he_png
    else:
        print(f"[SKIP] H&E not found for {slide_id}")
        return None
    
    # Find CosMx file
    cosmx_path = cosmx_dir / f"{slide_id}.png"
    
    if not cosmx_path.exists():
        for png_file in cosmx_dir.glob("*.png"):
            if png_file.stem.lower() == slide_id.lower():
                cosmx_path = png_file
                break
        else:
            print(f"[SKIP] CosMx not found for {slide_id}")
            return None
    
    print(f"\n[Processing] {slide_id}")
    print(f"  H&E: {he_path.name}")
    print(f"  CosMx: {cosmx_path.name}")
    
    # Load images
    he_img, he_orig_size = load_he_image(he_path, size)
    cosmx_img, cosmx_orig_size = load_cosmx_image(cosmx_path, size)
    
    # Create masks
    he_mask = create_he_mask(he_img)
    cosmx_mask = create_cosmx_mask(cosmx_img)
    
    # Find best alignment
    best, candidates, detected_mode = find_best_alignment_hybrid(
        he_mask, cosmx_mask, mode=mode
    )
    
    # Optional refinement
    if refine:
        dx, dy, score = refine_alignment(he_mask, cosmx_mask, best)
        best['dx'] = dx
        best['dy'] = dy
        best['norm_dx'] = dx / he_mask.shape[1]
        best['norm_dy'] = dy / he_mask.shape[0]
        best['refined_score'] = score
    
    # Debug visualization
    if debug:
        cosmx_tiles_dir.mkdir(parents=True, exist_ok=True)
        debug_path = cosmx_tiles_dir / "alignment_debug_v4.png"
        visualize_alignment(he_mask, cosmx_mask, best, debug_path)
    
    # Calculate scale
    he_orig_w, he_orig_h = he_orig_size
    cosmx_orig_w, cosmx_orig_h = cosmx_orig_size
    size_ratio = (cosmx_orig_w / he_orig_w + cosmx_orig_h / he_orig_h) / 2
    final_scale = best['scale']
    
    # Prepare output
    transform_data = {
        "version": "4.0",
        "slide_id": slide_id,
        "method": f"auto_orientation_v4_{detected_mode}",
        "algorithm": "hybrid (phase_correlation + template_matching)",
        "coverage_mode": detected_mode,
        "original_sizes": {
            "he": [he_orig_w, he_orig_h],
            "cosmx": [cosmx_orig_w, cosmx_orig_h],
            "size_ratio": size_ratio
        },
        "transform": {
            "rotation": best['rotation'],
            "flipX": best['flipX'],
            "flipY": best['flipY'],
            "translateX": best['norm_dx'],
            "translateY": best['norm_dy'],
            "translateX_pixels": best['dx'],
            "translateY_pixels": best['dy'],
            "scale": final_scale
        },
        "detection": {
            "combined_score": best['combined_score'],
            "match_score": best['match_score'],
            "iou_score": best['iou_score'],
            "detection_scale": best['scale'],
            "processing_size": size,
            "he_shape": list(he_mask.shape),
            "cosmx_shape": list(cosmx_mask.shape),
            "top_candidates": [
                {
                    "rotation": c['rotation'],
                    "flipX": c['flipX'],
                    "flipY": c['flipY'],
                    "scale": round(c['scale'], 3),
                    "score": round(c['combined_score'], 4),
                    "position": [c['dx'], c['dy']]
                }
                for c in sorted(candidates, key=lambda x: -x['combined_score'])[:5]
            ]
        }
    }
    
    # Save
    cosmx_tiles_dir.mkdir(parents=True, exist_ok=True)
    output_file = cosmx_tiles_dir / "transform.json"
    
    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(transform_data, f, indent=2)
    
    print(f"  [Result] Rot={best['rotation']}°, FlipX={best['flipX']}, Scale={final_scale:.3f}, Score={best['combined_score']:.4f}")
    print(f"  [Saved] {output_file}")
    
    return {
        'slide_id': slide_id,
        'score': best['combined_score'],
        'rotation': best['rotation'],
        'flipX': best['flipX'],
        'flipY': best['flipY'],
        'scale': final_scale
    }


def main():
    parser = argparse.ArgumentParser(description='Auto Orientation V4 (Hybrid: Full + Partial)')
    parser.add_argument('--slide-id', help='Single slide ID (optional if --all)')
    parser.add_argument('--all', action='store_true', help='Process ALL slides in cosmx folder')
    parser.add_argument('--data-dir', default=r'D:\병리\data', help='Data directory')
    parser.add_argument('--mode', choices=['auto', 'full', 'partial'], default='auto',
                        help='Matching mode: auto, full, or partial')
    parser.add_argument('--refine', action='store_true', help='Perform local refinement')
    parser.add_argument('--debug', action='store_true', help='Save debug visualization')
    parser.add_argument('--size', type=int, default=1024, help='Max processing size')
    args = parser.parse_args()
    
    print("=" * 70)
    print("Auto Orientation V4 - Hybrid (Full + Partial Matching)")
    print("=" * 70)
    
    data_dir = Path(args.data_dir)
    
    # ====== BATCH MODE: Process all slides ======
    if args.all:
        cosmx_dir = data_dir / 'cosmx'
        
        if not cosmx_dir.exists():
            print(f"[ERROR] CosMx directory not found: {cosmx_dir}")
            return False
        
        # Get all CosMx files
        cosmx_files = list(cosmx_dir.glob("*.png"))
        print(f"\n[Batch Mode] Found {len(cosmx_files)} CosMx files")
        print("=" * 70)
        
        results = []
        for i, cosmx_path in enumerate(cosmx_files, 1):
            slide_id = cosmx_path.stem
            print(f"\n[{i}/{len(cosmx_files)}] {slide_id}")
            print("-" * 50)
            
            try:
                result = process_single_slide(
                    slide_id, data_dir, args.mode, args.refine, args.debug, args.size
                )
                if result:
                    results.append(result)
            except Exception as e:
                print(f"  [ERROR] {e}")
                continue
        
        # Summary
        print("\n" + "=" * 70)
        print("BATCH SUMMARY")
        print("=" * 70)
        print(f"  Total:     {len(cosmx_files)}")
        print(f"  Processed: {len(results)}")
        print(f"  Skipped:   {len(cosmx_files) - len(results)}")
        
        if results:
            avg_score = sum(r['score'] for r in results) / len(results)
            print(f"  Avg Score: {avg_score:.4f}")
            
            # Low score warnings
            low_scores = [r for r in results if r['score'] < 0.4]
            if low_scores:
                print(f"\n  ⚠️  Low score slides (may need manual adjustment):")
                for r in low_scores:
                    print(f"      - {r['slide_id']}: {r['score']:.4f}")
        
        print("=" * 70)
        return True
    
    # ====== SINGLE MODE: Process one slide ======
    if not args.slide_id:
        print("[ERROR] Please specify --slide-id or use --all for batch processing")
        print("  Example: python auto_orientation.py --slide-id \"SLIDE_ID\"")
        print("  Example: python auto_orientation.py --all")
        return False
    
    print(f"\n[OK] H&E: {args.slide_id}")
    
    result = process_single_slide(
        args.slide_id, data_dir, args.mode, args.refine, args.debug, args.size
    )
    
    if result:
        print("\n" + "=" * 70)
        print("RESULT")
        print("=" * 70)
        print(f"  Rotation:    {result['rotation']}°")
        print(f"  Flip X:      {result['flipX']}")
        print(f"  Flip Y:      {result['flipY']}")
        print(f"  Scale:       {result['scale']:.4f}")
        print(f"  Score:       {result['score']:.4f}")
        print("=" * 70)
    
    return result is not None


if __name__ == '__main__':
    try:
        success = main()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"\n[ERROR] {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)