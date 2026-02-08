# Pathology SVS–CosMx Dual Viewer

A lightweight research tool for visualization and approximate alignment of
H&E whole-slide pathology images (SVS) with CosMx spatial transcriptomics
images.

This project supports workflows where researchers need to visually compare
morphology (H&E) and molecular spatial information (CosMx) within the same tissue.

The system provides:
- Deep zoom viewing of whole-slide H&E images
- CosMx overlay visualization
- Automatic orientation estimation (rotation + flip + translation)
- Manual alignment refinement and transform saving
- Region annotation (e.g., tumor/stroma)

---

## Repository Structure

**Pathology/**
- **backend/** : Flask API (serves slides, tiles, transforms, annotations)
- **frontend/** : Web viewer UI (OpenSeadragon based)
- **codes/** : preprocessing and alignment pipeline
- **data/** : **NOT INCLUDED IN REPO** (SVS/CosMx inputs + generated tiles)

⚠️ The `data/` directory is intentionally excluded from the repository due to
file size and potential patient data. You must prepare the data locally.

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

### Step 3 — Automatic Alignment (CORE STEP)

```bash
python auto_orientation_v4.py --all --data-dir ../data --refine --debug
```

Output:

```text
data/cosmx_tiles/<slide_id>/transform.json
```

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

## Alignment Method Overview

The alignment algorithm performs approximate global registration:

1. Extract tissue masks from H&E and CosMx
2. Compare tissue coverage ratio
3. Test 16 orientation combinations:
   - rotations: 0°, 90°, 180°, 270°
   - flip X
   - flip Y
4. Estimate translation using phase correlation
5. Local refinement

This produces a global alignment suitable for visualization and ROI selection,
but not cell-level registration.

---

## Notes

- Designed for visualization and region selection
- Perfect alignment is not expected (different section depths)
- Manual refinement is available in the UI

---

