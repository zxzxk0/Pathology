"""
CosMx-H&E Fine Registration (V1)
V8 auto_orientation의 transform.json을 초기값으로 읽어
position(dx,dy) + scale을 grid search로 fine-tune.

rotation / flipX / flipY 는 V8 결과 그대로 고정.

알고리즘:
  1. V8 transform.json 읽기 → rotation/flip/scale/dx/dy 초기값
  2. Coarse grid search: scale ±20% × position ±10% 범위
  3. Fine grid search:   최적 근처 ±5% 범위 밀도 높게
  4. NCC tiebreaker (동률 flip 방향 보정)
  5. 결과를 transform_registered.json 으로 저장 + overlay 저장

실행:
  python register_fine.py --slide-id SLIDE_ID
  python register_fine.py --all
"""

import numpy as np
import cv2
import json
from pathlib import Path
import argparse
from PIL import Image
import sys
import io

if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

Image.MAX_IMAGE_PIXELS = None


# ============================================================================
# IMAGE LOADING
# ============================================================================

def load_he_image(he_path, max_size=1024):
    he_path = Path(he_path)
    if he_path.suffix.lower() == '.svs':
        from openslide import OpenSlide
        slide = OpenSlide(str(he_path))
        w, h  = slide.dimensions
        sc    = min(max_size / w, max_size / h)
        thumb = slide.get_thumbnail((int(w*sc), int(h*sc)))
        slide.close()
        return cv2.cvtColor(np.array(thumb), cv2.COLOR_RGB2BGR), (w, h)
    pil = Image.open(str(he_path))
    orig = pil.size
    if pil.mode != 'RGB': pil = pil.convert('RGB')
    pil.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR), orig


def load_cosmx_image(cosmx_path, max_size=1024):
    pil = Image.open(str(cosmx_path))
    orig = pil.size
    if pil.mode == 'RGBA':
        bg = Image.new('RGB', pil.size, (255,255,255))
        bg.paste(pil, mask=pil.split()[3]); pil = bg
    elif pil.mode != 'RGB': pil = pil.convert('RGB')
    pil.thumbnail((max_size, max_size), Image.Resampling.LANCZOS)
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR), orig


# ============================================================================
# MASK
# ============================================================================

def create_he_mask(img):
    gray    = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gray, 235, 255, cv2.THRESH_BINARY_INV)
    # 사각 테두리 직접 제거
    mask = _remove_rect_border(mask)
    k    = np.ones((5,5), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,  k)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((9,9), np.uint8))
    return mask


def create_cosmx_mask(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    sat  = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[:,:,1]
    raw  = (((gray < 250) & (gray > 5)) | (sat > 20)).astype(np.uint8) * 255
    # fiducial 제거
    raw  = _remove_fiducial(raw, *raw.shape[:2])
    k    = np.ones((7,7), np.uint8)
    mask = cv2.dilate(raw, k, iterations=3)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((15,15), np.uint8))
    return mask


def _remove_rect_border(mask, min_fill=0.55, max_t=30):
    h, w = mask.shape
    for t in range(3, max_t+1):
        if 2*t >= h or 2*t >= w: break
        if all([(mask[t-1, t:-t]>0).mean() > min_fill,
                (mask[-t,  t:-t]>0).mean() > min_fill,
                (mask[t:-t, t-1]>0).mean() > min_fill,
                (mask[t:-t, -t ]>0).mean() > min_fill]):
            c = mask.copy()
            c[:t,:]=0; c[-t:,:]=0; c[:,:t]=0; c[:,-t:]=0
            return c
    return mask


def _remove_fiducial(mask, h, w, max_r=0.003):
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    clean = np.zeros_like(mask)
    for i in range(1, n):
        a  = stats[i, cv2.CC_STAT_AREA]
        bw = stats[i, cv2.CC_STAT_WIDTH]
        bh = stats[i, cv2.CC_STAT_HEIGHT]
        if bw==0 or bh==0: continue
        if (a/(h*w) < max_r and min(bw,bh)/max(bw,bh) > 0.6
                and a/(bw*bh) > 0.65 and a > 10):
            continue
        clean[labels==i] = 255
    return clean


# ============================================================================
# TRANSFORM
# ============================================================================

def apply_transform(img, rotation, flip_x, flip_y):
    r = img.copy()
    k = rotation // 90
    if k: r = np.rot90(r, k=k)
    if flip_x: r = np.fliplr(r)
    if flip_y: r = np.flipud(r)
    return np.ascontiguousarray(r)


# ============================================================================
# SCORING — coverage-aware precision/IoU
# ============================================================================

def coverage_score(he_mask, cosmx_scaled, dx, dy, cov_ratio=1.0):
    """
    ✅ F1 기반 score — Precision × Recall 균형
    
    Precision = inter / cosmx_tissue  → CosMx가 조직 위에 올라간 비율
    Recall    = inter / he_tissue     → H&E 조직이 CosMx에 커버된 비율
    F1        = 2*P*R / (P+R)        → 둘 다 높아야 높은 점수
    
    "CosMx를 배경에 버리지 말고, H&E 조직을 최대한 커버하라"를 동시에 달성.
    cov_ratio에 따라 Recall 가중치 조절:
      - cov < 0.4 (partial): F1에서 Precision 비중 높임 (CosMx 일부만 스캔)
      - cov > 0.7 (full):    F1 그대로 (Recall도 중요)
    """
    he_h, he_w = he_mask.shape
    ch, cw     = cosmx_scaled.shape
    x1=max(0,dx); y1=max(0,dy)
    x2=min(he_w,dx+cw); y2=min(he_h,dy+ch)
    sx=max(0,-dx); sy=max(0,-dy)
    rw=x2-x1; rh=y2-y1
    if rw<=0 or rh<=0: return 0.0
    if sy+rh>ch or sx+rw>cw: return 0.0

    he_r     = he_mask[y1:y2, x1:x2]
    cx_r     = cosmx_scaled[sy:sy+rh, sx:sx+rw]
    inter    = float(np.logical_and(he_r>0, cx_r>0).sum())
    cx_total = float((cosmx_scaled > 0).sum())          # 전체 CosMx tissue
    he_total = float((he_mask > 0).sum())                # 전체 H&E tissue

    prec   = inter / (cx_total + 1e-6)   # CosMx 중 H&E 위 비율
    recall = inter / (he_total + 1e-6)   # H&E 중 CosMx 커버 비율
    f1     = 2 * prec * recall / (prec + recall + 1e-6)

    # partial 케이스: recall 기대치가 낮으니 weighted F1 (precision 비중 높임)
    if cov_ratio < 0.4:
        # precision 70% + recall 30%
        score = 0.7 * prec + 0.3 * recall
    elif cov_ratio > 0.7:
        # F1 그대로 (coverage 목표)
        score = f1
    else:
        alpha = (cov_ratio - 0.4) / 0.3   # 0→1
        score = (1-alpha) * (0.7*prec + 0.3*recall) + alpha * f1

    return score


# ============================================================================
# GRID SEARCH REGISTRATION
# ============================================================================

def grid_search(he_mask, cosmx_transformed, init_dx, init_dy, init_scale,
                cov_ratio, dx_range, dy_range,
                scale_down, scale_up,          # ✅ 비대칭 scale 범위
                dx_step, dy_step, scale_step, label=""):
    """
    (dx, dy, scale) 3D grid search.
    scale_down: init에서 아래로 탐색할 비율 (예: 0.15 → init*0.85까지)
    scale_up:   init에서 위로 탐색할 비율  (예: 0.50 → init*1.50까지)
    → scale이 작게 잡힌 케이스 수정을 위해 상방 범위를 넓게
    """
    he_h, he_w   = he_mask.shape
    cx_h, cx_w   = cosmx_transformed.shape[:2]

    best_score = -1
    best       = {'dx': init_dx, 'dy': init_dy, 'scale': init_scale, 'score': -1}

    s_lo = max(0.30, init_scale * (1.0 - scale_down))
    # ✅ 수정: H&E 크기 기반 상한 클리핑 제거 (template matching 제약이었음)
    # CosMx가 H&E보다 커도 coverage_score가 클리핑해서 계산함
    s_hi = init_scale * (1.0 + scale_up)
    scales = np.arange(s_lo, s_hi + scale_step * 0.5, scale_step)

    dx_vals = range(int(init_dx - dx_range),
                    int(init_dx + dx_range) + 1, int(max(1, dx_step)))
    dy_vals = range(int(init_dy - dy_range),
                    int(init_dy + dy_range) + 1, int(max(1, dy_step)))

    n_total = len(scales) * len(dx_vals) * len(dy_vals)
    print(f"    {label}: scale {s_lo:.2f}~{s_hi:.2f} ({len(scales)} steps) × "
          f"{len(dx_vals)}×{len(dy_vals)} pos = {n_total} evals")

    for scale in scales:
        nw = max(1, int(cx_w * scale))
        nh = max(1, int(cx_h * scale))
        # ✅ 수정: template matching 제약 제거
        # registration은 IoU/Precision 직접 계산이므로 CosMx >= H&E도 허용
        # 단, 너무 크면 overlap=0 이 되므로 H&E의 200%까지만 허용
        if nw > he_w * 2 or nh > he_h * 2 or nw < 10 or nh < 10:
            continue
        cosmx_s = cv2.resize(cosmx_transformed, (nw, nh), interpolation=cv2.INTER_AREA)

        for dx in dx_vals:
            for dy in dy_vals:
                sc = coverage_score(he_mask, cosmx_s, dx, dy, cov_ratio)
                if sc > best_score:
                    best_score = sc
                    best = {'dx': int(dx), 'dy': int(dy),
                            'scale': float(scale), 'score': sc}

    best['score'] = best_score
    return best


def tissue_centroid(mask):
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return mask.shape[1]//2, mask.shape[0]//2
    return int(xs.mean()), int(ys.mean())


def tissue_bbox_wh(mask):
    ys, xs = np.where(mask > 0)
    if len(xs) == 0:
        return mask.shape[1], mask.shape[0]
    return int(xs.max()-xs.min()+1), int(ys.max()-ys.min()+1)


def centroid_candidates(he_mask, cosmx_transformed, init_scale, cov_ratio, n_scales=6):
    """
    tissue centroid 매칭으로 초기 후보 위치/스케일 생성.
    H&E centroid ↔ CosMx centroid를 맞추는 (dx, dy)를 scale별로 계산.
    """
    he_h, he_w  = he_mask.shape
    cx_h, cx_w  = cosmx_transformed.shape[:2]
    he_cx, he_cy = tissue_centroid(he_mask)
    cx_cx, cx_cy = tissue_centroid(cosmx_transformed)
    he_bw, he_bh = tissue_bbox_wh(he_mask)
    cx_bw, cx_bh = tissue_bbox_wh(cosmx_transformed)

    # tissue bbox 비율 기반 center scale
    s_w = he_bw / (cx_bw + 1e-6)
    s_h = he_bh / (cx_bh + 1e-6)
    s_center = (s_w + s_h) / 2.0
    s_lo = max(0.30, s_center * 0.60)
    s_hi = s_center * 1.60

    candidates = []
    for scale in np.linspace(s_lo, s_hi, n_scales):
        nw = max(1, int(cx_w * scale))
        nh = max(1, int(cx_h * scale))
        if nw < 10 or nh < 10:
            continue
        # centroid 기반 dx, dy
        dx = he_cx - int(cx_cx * scale)
        dy = he_cy - int(cx_cy * scale)
        # 이미지 경계 내로 클리핑
        dx = max(-nw//2, min(he_w, dx))
        dy = max(-nh//2, min(he_h, dy))
        cx_s = cv2.resize(cosmx_transformed, (nw, nh), interpolation=cv2.INTER_AREA)
        sc   = coverage_score(he_mask, cx_s, dx, dy, cov_ratio)
        candidates.append({'dx': dx, 'dy': dy, 'scale': float(scale), 'score': sc})

    candidates.sort(key=lambda x: -x['score'])
    return candidates


def register_slide(he_mask, cosmx_mask, init_transform, cov_ratio, he_size):
    rotation = init_transform['rotation']
    flip_x   = init_transform['flipX']
    flip_y   = init_transform['flipY']
    he_h, he_w = he_mask.shape

    init_scale = init_transform.get('scale', 1.0)
    init_dx    = init_transform.get('dx_px', 0)
    init_dy    = init_transform.get('dy_px', 0)

    print(f"\n  Initial: scale={init_scale:.3f} dx={init_dx} dy={init_dy}")
    print(f"  Coverage ratio: {cov_ratio:.3f}  "
          f"→ {'Precision-weighted' if cov_ratio<0.4 else 'F1' if cov_ratio>0.7 else 'Blend'}")

    # ── init score 계산 ───────────────────────────────────────────────────────
    cosmx_t = apply_transform(cosmx_mask, rotation, flip_x, flip_y)
    nw0 = max(1, int(cosmx_t.shape[1] * init_scale))
    nh0 = max(1, int(cosmx_t.shape[0] * init_scale))
    if nw0 > 0 and nh0 > 0:
        cx_s0      = cv2.resize(cosmx_t, (nw0, nh0), interpolation=cv2.INTER_AREA)
        init_score = coverage_score(he_mask, cx_s0, init_dx, init_dy, cov_ratio)
    else:
        init_score = 0.0
    print(f"  Init score: {init_score:.4f}")

    # ── Stage 0: 16방향 전체 Rescue ────────────────────────────────────────
    # init score < 0.15 → rotation까지 포함해 16방향 전체 탐색
    # 각 방향에서: (A) tissue centroid 후보 + (B) 성긴 canvas sweep 병행
    if init_score < 0.15:
        print("\n  [Stage 0] 16-orientation rescue (centroid + sweep)...")
        all_orientations = [
            (rot, fx, fy)
            for rot in [0, 90, 180, 270]
            for fx  in [False, True]
            for fy  in [False, True]
        ]
        rescue_best_score = -1
        rescue_best       = None
        rescue_best_ori   = (rotation, flip_x, flip_y)

        for rot, fx, fy in all_orientations:
            cx_t = apply_transform(cosmx_mask, rot, fx, fy)

            # (A) centroid 후보 스코어링 (빠름)
            cands = centroid_candidates(he_mask, cx_t, init_scale, cov_ratio, n_scales=8)
            best_cand = cands[0] if cands else None

            # (B) 성긴 canvas sweep
            sweep = grid_search(
                he_mask, cx_t,
                init_dx    = he_w // 2,
                init_dy    = he_h // 2,
                init_scale = init_scale,
                cov_ratio  = cov_ratio,
                dx_range   = he_w * 0.55,
                dy_range   = he_h * 0.55,
                scale_down = 0.15,
                scale_up   = 0.70,
                dx_step    = max(30, he_w // 20),   # 더 성기게
                dy_step    = max(30, he_h // 20),
                scale_step = 0.10,
                label      = f"R={rot} FX={fx} FY={fy}"
            )

            # 둘 중 더 나은 것 선택
            local_best = sweep
            if best_cand and best_cand['score'] > sweep['score']:
                local_best = best_cand

            print(f"    Rot={rot:>3} FX={fx} FY={fy}: "
                  f"centroid={cands[0]['score']:.3f}@s={cands[0]['scale']:.2f} "
                  f"sweep={sweep['score']:.3f}  → {local_best['score']:.3f}")

            if local_best['score'] > rescue_best_score:
                rescue_best_score = local_best['score']
                rescue_best       = local_best
                rescue_best_ori   = (rot, fx, fy)

        rotation, flip_x, flip_y = rescue_best_ori
        cosmx_t    = apply_transform(cosmx_mask, rotation, flip_x, flip_y)
        init_dx    = rescue_best['dx']
        init_dy    = rescue_best['dy']
        init_scale = rescue_best['scale']
        print(f"\n  → Rescue best: Rot={rotation} FX={flip_x} FY={flip_y} "
              f"scale={init_scale:.3f} ({init_dx},{init_dy}) "
              f"score={rescue_best_score:.4f}")

    else:
        # init이 괜찮으면 flip 4가지만 빠르게 스캔
        print(f"\n  [Flip scan] Testing 4 flip combinations (Rot={rotation} fixed)...")
        flip_combos = [
            (flip_x,     flip_y,     "V8 init"),
            (not flip_x, flip_y,     "FX flip"),
            (flip_x,     not flip_y, "FY flip"),
            (not flip_x, not flip_y, "both flip"),
        ]
        best_flip_score = init_score
        for fx, fy, label in flip_combos:
            cx_t = apply_transform(cosmx_mask, rotation, fx, fy)
            nw = max(1, int(cx_t.shape[1] * init_scale))
            nh = max(1, int(cx_t.shape[0] * init_scale))
            if nw > 0 and nh > 0:
                cx_s = cv2.resize(cx_t, (nw, nh), interpolation=cv2.INTER_AREA)
                sc   = coverage_score(he_mask, cx_s, init_dx, init_dy, cov_ratio)
            else:
                sc = 0.0
            print(f"    FX={fx} FY={fy} ({label}): {sc:.4f}")
            if sc > best_flip_score:
                best_flip_score = sc
                flip_x, flip_y  = fx, fy
        cosmx_t = apply_transform(cosmx_mask, rotation, flip_x, flip_y)
        print(f"  → Best flip: FX={flip_x} FY={flip_y} ({best_flip_score:.4f})")

    # ── Stage 1: Coarse search ──────────────────────────────────────────────
    print("\n  [Stage 1] Coarse search (scale bias: upward)...")
    coarse = grid_search(
        he_mask, cosmx_t, init_dx, init_dy, init_scale, cov_ratio,
        dx_range   = he_w  * 0.25,
        dy_range   = he_h  * 0.25,
        scale_down = 0.15,
        scale_up   = 0.60,
        dx_step    = max(10, he_w // 50),
        dy_step    = max(10, he_h // 50),
        scale_step = 0.05,
        label="Coarse"
    )
    print(f"    Coarse best: scale={coarse['scale']:.3f} "
          f"dx={coarse['dx']} dy={coarse['dy']} score={coarse['score']:.4f}")

    # ── Stage 2: Fine search ────────────────────────────────────────────────
    print("\n  [Stage 2] Fine search...")
    fine = grid_search(
        he_mask, cosmx_t, coarse['dx'], coarse['dy'], coarse['scale'], cov_ratio,
        dx_range   = max(40, he_w * 0.05),
        dy_range   = max(40, he_h * 0.05),
        scale_down = 0.10,
        scale_up   = 0.10,
        dx_step    = max(3, he_w // 150),
        dy_step    = max(3, he_h // 150),
        scale_step = 0.01,
        label="Fine"
    )
    print(f"    Fine best:   scale={fine['scale']:.3f} "
          f"dx={fine['dx']} dy={fine['dy']} score={fine['score']:.4f}")

    # ── Stage 3: Pixel-level micro search ──────────────────────────────────
    print("\n  [Stage 3] Micro search...")
    micro = grid_search(
        he_mask, cosmx_t, fine['dx'], fine['dy'], fine['scale'], cov_ratio,
        dx_range   = 20,
        dy_range   = 20,
        scale_down = 0.02,
        scale_up   = 0.02,
        dx_step    = 1,
        dy_step    = 1,
        scale_step = 0.005,
        label="Micro"
    )
    print(f"    Micro best:  scale={micro['scale']:.3f} "
          f"dx={micro['dx']} dy={micro['dy']} score={micro['score']:.4f}")

    micro['flipX'] = flip_x
    micro['flipY'] = flip_y
    return micro


# ============================================================================
# PROCESS
# ============================================================================

def process_single_slide(slide_id, data_dir, size, init_version='8'):
    slides_dir      = data_dir / 'slides'
    cosmx_dir       = data_dir / 'cosmx'
    tiles_dir       = data_dir / 'cosmx_tiles' / slide_id

    # transform.json 읽기
    json_path = tiles_dir / 'transform.json'
    if not json_path.exists():
        print(f"[SKIP] transform.json not found: {json_path}"); return None

    with open(json_path, encoding='utf-8') as f:
        tj = json.load(f)

    tf = tj.get('transform', {})
    init = {
        'rotation': tf.get('rotation', 0),
        'flipX':    tf.get('flipX',    False),
        'flipY':    tf.get('flipY',    False),
        'scale':    tf.get('scale',    1.0),
        'dx_px':    tf.get('translateX_pixels', 0),
        'dy_px':    tf.get('translateY_pixels', 0),
    }
    print(f"\n[Register] {slide_id}")
    print(f"  Init from {json_path.name} v{tj.get('version','?')}: "
          f"Rot={init['rotation']} FX={init['flipX']} FY={init['flipY']} "
          f"scale={init['scale']:.3f} dx={init['dx_px']} dy={init['dy_px']}")

    # H&E 파일 찾기
    he_path = None
    for ext in ['.svs', '.png', '.jpg', '.tif', '.tiff']:
        p = slides_dir / f"{slide_id}{ext}"
        if p.exists(): he_path = p; break
    if he_path is None:
        print(f"[SKIP] H&E not found"); return None

    # CosMx 파일 찾기
    cosmx_path = cosmx_dir / f"{slide_id}.png"
    if not cosmx_path.exists():
        for f in cosmx_dir.glob("*.png"):
            if f.stem.lower() == slide_id.lower():
                cosmx_path = f; break
        else:
            print(f"[SKIP] CosMx not found"); return None

    # 로드
    he_img,    _ = load_he_image(he_path, size)
    cosmx_img, _ = load_cosmx_image(cosmx_path, size)

    he_mask    = create_he_mask(he_img)
    cosmx_mask = create_cosmx_mask(cosmx_img)

    he_area  = float((he_mask > 0).sum())
    cx_area  = float((cosmx_mask > 0).sum())
    cov_ratio = cx_area / (he_area + 1e-6)

    # Registration
    result = register_slide(he_mask, cosmx_mask, init, cov_ratio,
                            he_img.shape[:2])

    # 원본 transform.json 갱신 후 저장
    he_h, he_w = he_mask.shape
    tj_out = dict(tj)
    tj_out['version']        = tj.get('version','?') + '_reg'
    tj_out['method']         = tj.get('method','') + '_registered'
    tj_out['registration']   = {
        'initial_score': tj.get('detection',{}).get('combined_score', 0),
        'final_score':   result['score'],
        'coarse_search': 'dx±15% dy±15% scale±25%',
        'fine_search':   'dx±4%  dy±4%  scale±8%',
        'micro_search':  'dx±15px dy±15px scale±2%'
    }
    tj_out['transform']['scale']             = result['scale']
    tj_out['transform']['flipX']             = result.get('flipX', init['flipX'])
    tj_out['transform']['flipY']             = result.get('flipY', init['flipY'])
    tj_out['transform']['translateX_pixels'] = result['dx']
    tj_out['transform']['translateY_pixels'] = result['dy']
    tj_out['transform']['translateX']        = result['dx'] / he_w
    tj_out['transform']['translateY']        = result['dy'] / he_h

    out_json = tiles_dir / 'transform_registered.json'
    with open(out_json, 'w', encoding='utf-8') as f:
        json.dump(tj_out, f, indent=2)
    print(f"\n  [Saved] {out_json}")

    # 오버레이 저장
    try:
        test_dir = Path(r"D:\병리\test")
        test_dir.mkdir(parents=True, exist_ok=True)

        h_he, w_he = he_img.shape[:2]
        res_fx = result.get('flipX', init['flipX'])
        res_fy = result.get('flipY', init['flipY'])
        cosmx_t    = apply_transform(cosmx_img, init['rotation'], res_fx, res_fy)
        sc = result['scale']
        nw = max(1, int(cosmx_t.shape[1]*sc))
        nh = max(1, int(cosmx_t.shape[0]*sc))
        cosmx_t = cv2.resize(cosmx_t, (nw, nh))

        dx, dy = result['dx'], result['dy']
        canvas = np.zeros((h_he, w_he, 3), dtype=np.uint8)
        ch, cw = cosmx_t.shape[:2]
        x1=max(0,dx); y1=max(0,dy)
        x2=min(w_he,dx+cw); y2=min(h_he,dy+ch)
        sx=max(0,-dx); sy=max(0,-dy)
        if x2>x1 and y2>y1:
            canvas[y1:y2, x1:x2] = cosmx_t[sy:sy+(y2-y1), sx:sx+(x2-x1)]

        he_g   = cv2.cvtColor(he_img, cv2.COLOR_BGR2GRAY)
        cx_g   = cv2.cvtColor(canvas, cv2.COLOR_BGR2GRAY)
        he_inv = 255 - he_g
        cd     = cx_g.copy(); cd[cx_g>240]=0; cd[cx_g<5]=0

        overlay = np.zeros((h_he, w_he, 3), dtype=np.uint8)
        overlay[...,2] = he_inv; overlay[...,1] = cd

        font = cv2.FONT_HERSHEY_SIMPLEX
        cv2.putText(overlay,
                    f"Rot={init['rotation']} FX={init['flipX']} FY={init['flipY']} "
                    f"scale={sc:.3f} dx={dx} dy={dy}",
                    (20,50), font, 0.8, (255,255,255), 2, cv2.LINE_AA)
        cv2.putText(overlay,
                    f"Score={result['score']:.4f}  cov={cov_ratio:.2f}  [Reg]",
                    (20,85), font, 0.8, (255,255,255), 2, cv2.LINE_AA)

        out_ov = test_dir / f"{slide_id}_registered_overlay.png"
        Image.fromarray(cv2.cvtColor(overlay, cv2.COLOR_BGR2RGB)).save(str(out_ov))
        print(f"  [Overlay] → {out_ov}")
    except Exception as e:
        print(f"  [Overlay] Failed: {e}")

    return {
        'slide_id': slide_id,
        'init_score':  tj.get('detection',{}).get('combined_score', 0),
        'final_score': result['score'],
        'scale': result['scale'],
        'dx': result['dx'], 'dy': result['dy'],
        'rotation': init['rotation'],
        'flipX': init['flipX'], 'flipY': init['flipY'],
    }


# ============================================================================
# MAIN
# ============================================================================

def main():
    parser = argparse.ArgumentParser(description='CosMx-H&E Fine Registration')
    parser.add_argument('--slide-id')
    parser.add_argument('--all',      action='store_true')
    parser.add_argument('--data-dir', default=r'D:\병리\data')
    parser.add_argument('--size',     type=int, default=1024)
    args = parser.parse_args()

    print("=" * 65)
    print("CosMx-H&E Fine Registration (Grid Search, 3-stage)")
    print("=" * 65)

    data_dir = Path(args.data_dir)

    if args.all:
        tiles_dir = data_dir / 'cosmx_tiles'
        if not tiles_dir.exists():
            print(f"[ERROR] {tiles_dir}"); return False
        slide_ids = [d.name for d in tiles_dir.iterdir()
                     if d.is_dir() and (d/'transform.json').exists()]
        print(f"[Batch] {len(slide_ids)} slides with transform.json")
        results = []
        for i, sid in enumerate(slide_ids, 1):
            print(f"\n[{i}/{len(slide_ids)}] {sid}")
            try:
                r = process_single_slide(sid, data_dir, args.size)
                if r: results.append(r)
            except Exception as e:
                import traceback; print(f"  [ERROR] {e}"); traceback.print_exc()
        if results:
            improved = [r for r in results if r['final_score'] > r['init_score']]
            print(f"\n{'='*65}")
            print(f"Done: {len(results)}/{len(slide_ids)}  "
                  f"Improved: {len(improved)}/{len(results)}")
            for r in results:
                arrow = "↑" if r['final_score'] > r['init_score'] else "→"
                print(f"  {r['slide_id']}: {r['init_score']:.4f} {arrow} {r['final_score']:.4f}  "
                      f"scale={r['scale']:.3f} dx={r['dx']} dy={r['dy']}")
        return True

    if not args.slide_id:
        print("[ERROR] --slide-id or --all required"); return False

    r = process_single_slide(args.slide_id, data_dir, args.size)
    if r:
        print(f"\n{'='*65}")
        print(f"  Rot={r['rotation']}  FX={r['flipX']}  FY={r['flipY']}")
        print(f"  Scale:  {r['scale']:.4f}")
        print(f"  dx={r['dx']}  dy={r['dy']}")
        print(f"  Score:  {r['init_score']:.4f} → {r['final_score']:.4f}")
        print(f"{'='*65}")
    return r is not None


if __name__ == '__main__':
    try:
        sys.exit(0 if main() else 1)
    except Exception as e:
        import traceback
        print(f"\n[ERROR] {e}"); traceback.print_exc(); sys.exit(1)