# Pathology SVS–CosMx Dual Viewer

A lightweight research tool for visualization and approximate alignment of
H&E whole-slide pathology images (SVS) with CosMx spatial transcriptomics
images.

This project supports workflows where researchers need to visually compare
morphology (H&E) and molecular spatial information (CosMx) within the same tissue.

The system provides:
- Deep zoom dual-panel viewing (Left: H&E + AI annotations, Right: CosMx)
- CosMx overlay visualization with transform controls
- Automatic orientation estimation — **V8.2** (rotation + flip + translation + scale)
- Fine registration — **3-stage grid search** (position + scale refinement)
- Phase 1 QC workflow: sample approval/rejection for downstream registration
- GeoJSON annotation import (read-only overlay, tumor/stroma/other)

---

## Repository Structure

**Pathology/**
- **backend/** : Flask API (serves slides, tiles, transforms, annotations, QC status)
- **frontend/** : Web viewer UI (OpenSeadragon dual-panel, Phase 1 QC)
- **codes/** : Preprocessing and alignment pipeline
- **transforms/** : Alignment transform results per slide (tracked in repo)
- **data/** : **NOT INCLUDED IN REPO** (SVS/CosMx inputs + generated tiles)

⚠️ The `data/` directory is intentionally excluded from the repository due to
file size and potential patient data. You must prepare the data locally.

```text
data/
  slides/        # (USER) H&E whole-slide images (.svs)
  cosmx/         # (USER) CosMx composite images (.png)
  tiles/         # (AUTO) generated from slides/ by make_dzi.py
  cosmx_tiles/   # (AUTO) generated from cosmx/ + transform.json
  annotations/   # (AUTO) saved GeoJSON annotations
  qc_results/    # (AUTO) Phase 1 QC status per slide (.json)
```
The folder names must match exactly. Do not rename them.

---

## Requirements

Tested on:
- Windows 10 / Windows 11
- Anaconda / Miniconda

Required:
- Python 3.10
- OpenSlide (installed via conda-forge)

---

## Environment Setup

Create the environment:

```bash
conda config --add channels conda-forge
conda config --set channel_priority strict

conda create -n pathology python=3.10 openslide openslide-python
conda activate pathology
```

Install Python dependencies:

```bash
pip install -r backend/requirements.txt
pip install opencv-python
```

Verify OpenSlide:

```bash
python -c "import openslide; print('OpenSlide OK')"
```

---

## Data Preparation

Create the following folders:

```text
Pathology/data/
  slides/     # H&E whole-slide images (.svs)
  cosmx/      # CosMx composite images (.png)
```

File names must match:

```text
data/slides/A01.svs
data/cosmx/A01.png
```

---

## Preprocessing Pipeline

### Step 1 — Convert H&E SVS to DeepZoom tiles

```bash
cd codes
python make_dzi.py --all --slides-dir ../data/slides --output-dir ../data/tiles
```

### Step 2 — Convert CosMx PNG to DeepZoom tiles

```bash
python make_cosmx_dzi.py --all --cosmx-dir ../data/cosmx --output-dir ../data/cosmx_tiles
```

### Step 3 — Automatic Orientation Estimation (V8.2)

```bash
python auto_orientation.py --all --data-dir ../data --refine
```

> ⚠️ `auto_orientation_past.py` has been removed. Use `auto_orientation.py` (V8.2).

This step computes the **global alignment transform** between the H&E slide and the CosMx image.

The V8.2 algorithm estimates:
- Rotation (0°, 90°, 180°, 270°)
- Horizontal / vertical flip
- Translation (position)
- Scale

Key improvements in V8.2 over previous versions:
- **Phase correlation (0,0) fallback fix** — detects degenerate zero-shift results and automatically switches to template matching
- **Dual-mode threshold relaxed** — trigger threshold raised from 0.35 → 0.45, switch margin changed from +0.03 → −0.01 (partial mode preferred more aggressively)
- **Precision / IoU auto-switch** — uses Precision scoring for partial-coverage CosMx images, IoU for full-coverage, and linear blend in between
- **Rectangular border removal** — detects and removes glass slide borders before tissue masking
- **NCC tiebreaker** — top-4 candidates are re-evaluated using normalized cross-correlation

Output:

```text
data/cosmx_tiles/<slide_id>/transform.json
```

### Step 4 — Fine Registration (NEW)

```bash
python register_fine.py --all --data-dir ../data
```

Reads `transform.json` from Step 3 as initial values and performs **3-stage grid search** to refine position and scale:

| Stage | Search range | Step size |
|-------|-------------|-----------|
| Coarse | ±25% canvas, scale ±15~60% | ~2% canvas |
| Fine | ±5% canvas, scale ±10% | ~0.7% canvas |
| Micro | ±20px, scale ±2% | 1px / 0.5% |

Additional features:
- **Coverage-aware scoring** — F1 (Precision × Recall) for full coverage; Precision-weighted for partial CosMx scans
- **16-orientation rescue** — if initial score < 0.15, runs full 16-direction search from scratch using centroid matching + canvas sweep
- **Flip scan** — tests all 4 flip combinations before coarse search
- **Upward scale bias** — asymmetric scale range allows CosMx scale-up correction

Output:

```text
data/cosmx_tiles/<slide_id>/transform_registered.json
```

The viewer automatically loads `transform_registered.json` if available, otherwise falls back to `transform.json`.

---

## Running the Viewer

### Start Backend API

```bash
cd backend
python app.py
```

Backend runs at:
```
http://localhost:5000
```

Health check:
```
http://localhost:5000/health
```

### Start Frontend Viewer

```bash
cd frontend
python -m http.server 8000
```

Open browser:
```
http://localhost:8000
```

---

## Viewer Overview (Phase 1: Qualitative Benchmarking)

The viewer is a **dual-panel interface**:

| Panel | Content |
|-------|---------|
| Left | H&E whole-slide image + imported AI GeoJSON annotations (read-only) |
| Right | CosMx spatial transcriptomics overlay |

### Key Features

**Sync mode** — synchronized pan/zoom between left and right panels (default: OFF for independent positioning)

**QC Workflow** — approve or reject each slide for downstream registration:
- ✅ Approve: marks slide as `approved` (saved to `data/qc_results/<slide_id>.json`)
- ❌ Reject: marks slide as `rejected`
- QC status is shown as a badge and persists across sessions

**AI Annotation Import** — import GeoJSON annotation files exported from external AI models:
- Annotations are displayed read-only with color coding:
  - 🔴 **Tumor** — Red
  - 🟢 **Stroma** — Green
  - 🟣 **Other / In-situ** — Purple

**CosMx Transform Controls** — adjust rotation, flip, and scale of the CosMx overlay manually if needed

---

## Backend API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/slides` | List all available slides |
| GET | `/tiles/<path>` | Serve H&E DZI tiles |
| GET | `/api/qc/<slide_id>` | Get QC status for a slide |
| POST | `/api/qc/<slide_id>` | Save QC status (approved/rejected) |
| GET | `/api/annotations/<slide_id>` | Load GeoJSON annotations |
| POST | `/api/annotations/<slide_id>` | Save GeoJSON annotations |
| DELETE | `/api/annotations/<slide_id>` | Delete annotations |
| GET | `/api/cosmx/<slide_id>/dzi` | Get CosMx DZI URL (registered or original) |
| GET | `/api/cosmx/<slide_id>/transform` | Get alignment transform |
| GET | `/cosmx_tiles/<path>` | Serve CosMx DZI tiles |
| GET | `/health` | Health check |

---

## Alignment Method Overview (V8.2)

```
1. Load H&E and CosMx images at reduced resolution (default: 1024px)
2. Generate tissue masks
   - H&E: brightness threshold → rectangular border removal → fiducial removal → morphological cleanup
   - CosMx: brightness + saturation → fiducial removal → dilation
3. Estimate coverage ratio (partial vs full scan)
4. Test 16 orientation combinations (4 rotations × 2 flipX × 2 flipY)
   - Full coverage → phase correlation
   - Partial coverage → multiscale template matching
   - (0,0) fallback detection → auto-switch to template matching
5. Dual-mode crosscheck if score < 0.45
6. NCC tiebreaker among top-4 candidates
7. Optional: local refinement (±30px search)
8. Save transform.json

Fine Registration (register_fine.py):
9. Load transform.json as initial values
10. Flip scan (4 combinations)
11. If init score < 0.15 → 16-orientation rescue (centroid + sweep)
12. Coarse → Fine → Micro 3-stage grid search
13. Save transform_registered.json
```

This produces a global alignment suitable for visualization and ROI selection,
but not cell-level registration. Fine registration improves position and scale
accuracy beyond the initial orientation estimate.

---

## Transform Results (`transforms/`)

Alignment results for each slide are saved in `transforms/` and **tracked in the repository**.
This folder is generated by running `copy_transforms.py` after Steps 3–4.

```text
transforms/
  └── <slide_id>/
       ├── transform.json              # Output of auto_orientation.py (V8.2)
       └── transform_registered.json  # Output of register_fine.py (fine registration)
```

### Fields in each JSON file

**`transform.json`** — output of `auto_orientation.py`:

| Field | Description |
|-------|-------------|
| `transform.rotation` | Estimated rotation (0 / 90 / 180 / 270°) |
| `transform.flipX` | Horizontal flip applied |
| `transform.flipY` | Vertical flip applied |
| `transform.translateX` | Normalized translation X (relative to H&E width, 0–1) |
| `transform.translateY` | Normalized translation Y (relative to H&E height, 0–1) |
| `transform.translateX_pixels` | Translation X in pixels |
| `transform.translateY_pixels` | Translation Y in pixels |
| `transform.scale` | CosMx scale relative to H&E |
| `detection.combined_score` | Overall alignment quality score (0–1) |
| `detection.top_candidates` | Top 5 candidate orientations |
| `coverage_mode` | `full` / `partial` / `partial_v8.1` |

**`transform_registered.json`** — additional fields from `register_fine.py`:

| Field | Description |
|-------|-------------|
| `registration.initial_score` | Alignment score before fine registration |
| `registration.final_score` | Alignment score after fine registration |
| `registration.coarse_search` | Coarse grid search range |
| `registration.fine_search` | Fine grid search range |
| `registration.micro_search` | Micro grid search range |
| `transform.*` | Position and scale updated from auto_orientation baseline |

> The viewer prioritizes `transform_registered.json` and falls back to `transform.json` if not found.



---

## Notes

- Designed for visualization and region selection (Phase 1 QC)
- Not intended for cell-level registration
- Slight spatial mismatch is biologically expected (different section depths)
- QC results are stored per-slide and used to select samples for further analysis
- Manual CosMx transform adjustment is available in the viewer UI

---