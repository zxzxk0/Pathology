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
python auto_orientation_past.py --all --data-dir ../data --refine --debug
```

This step computes the **global alignment transform** between the H&E
slide and the CosMx image.

The algorithm estimates:
- rotation (0°, 90°, 180°, 270°)
- horizontal/vertical flip
- approximate translation (position)
- approximate scale

Output:

```text
data/cosmx_tiles/<slide_id>/transform.json
```

The viewer reads this file to overlay CosMx onto the H&E image.

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

The alignment algorithm performs an approximate global registration:

1. Extract tissue masks from H&E and CosMx
2. Compare tissue coverage ratio
3. Test 16 orientation combinations:
   - rotations: 0°, 90°, 180°, 270°
   - flip X
   - flip Y
4. Estimate translation using phase correlation
5. Perform local refinement around the best translation

This produces a global alignment suitable for visualization and ROI selection,
but not cell-level registration.

---

## Alignment Status and Ongoing Development

The current alignment pipeline focuses on estimating a **whole-tissue global transform**.
It is designed for visual correspondence rather than precise histological registration.

The following samples have been verified to have reliable orientation
(rotation and flip) alignment, although fine-scale position and scale
refinement is still ongoing:

```
3_2
3_4
3_6
3_7
3_8
3_16
3_18
3_19
```

For these slides, CosMx and H&E are correctly oriented but may still
require small manual adjustments within the viewer.

Because H&E and CosMx originate from different section depths and
preparation protocols, perfect pixel-level matching is not expected.

---

## Notes

- Designed for visualization and region selection
- Not intended for cell-level registration
- Slight spatial mismatch is biologically expected
- Manual refinement is available in the UI and can be saved

---

## Citation

Bang, Ji Hoon (2026)  
SVS–CosMx Dual Viewer for Pathology–Spatial Transcriptomics Visualization  
University of Georgia
