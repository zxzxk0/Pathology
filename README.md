# Pathology SVS–CosMx Dual Viewer

A lightweight research tool for visualization and approximate alignment of
H&E whole-slide pathology images (SVS) with CosMx spatial transcriptomics
images.

This project was developed to support pathology–spatial transcriptomics
analysis workflows in which researchers need to visually compare morphology
(H&E) and molecular spatial information (CosMx) within the same tissue.

The system provides:
- Deep zoom viewing of whole-slide H&E images
- CosMx image overlay
- Automatic orientation estimation (rotation + flip + translation)
- Manual alignment refinement
- Annotation of tumor/stroma/other regions
- Saving and reloading alignment transforms

---

## Repository Structure

Pathology/
│
├── backend/ # Flask API (serves slides, tiles, transforms, annotations)
├── frontend/ # Web viewer UI (OpenSeadragon based)
├── codes/ # preprocessing and alignment pipeline
└── data/ # (NOT INCLUDED IN REPO)


⚠️ The `data/` directory is intentionally excluded from the repository due to
file size and potential patient data.

You must prepare the data locally.

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

conda config --add channels conda-forge
conda config --set channel_priority strict

conda create -n pathology python=3.10 openslide openslide-python
conda activate pathology


Install Python dependencies:

pip install -r backend/requirements.txt
pip install opencv-python


Verify OpenSlide:

python -c "import openslide; print('OpenSlide OK')"


---

## Data Preparation

Create the following folder:

Pathology/data/
slides/ # H&E whole-slide images (.svs)
cosmx/ # CosMx composite images (.png)


File names MUST match:

Example:

data/slides/A01.svs
data/cosmx/A01.png


The alignment pipeline pairs files by identical filename.

---

## Preprocessing Pipeline

All preprocessing scripts are inside:

codes/


### Step 1 — Convert H&E SVS to DeepZoom tiles

cd codes
python make_dzi.py --all --slides-dir ../data/slides --output-dir ../data/tiles


This converts each SVS into OpenSeadragon-compatible pyramidal tiles.

---

### Step 2 — Convert CosMx image to tiles

python make_cosmx_dzi.py --all --cosmx-dir ../data/cosmx --output-dir ../data/cosmx_tiles


This generates deep zoom tiles for the CosMx image.

---

### Step 3 — Automatic Alignment (CORE STEP)

python auto_orientation_v4.py --all --data-dir ../data --refine --debug


This step automatically estimates:
- rotation
- flip (X/Y)
- translation

Output:

data/cosmx_tiles/<slide_id>/transform.json


The viewer reads this file to overlay CosMx onto H&E.

Debug images will also be produced to visually verify alignment.

---

## Running the Viewer

### Start Backend API

Open terminal 1:

cd backend
python app.py


Backend runs at:

http://localhost:5000


Test:

http://localhost:5000/health


---

### Start Frontend Viewer

Open terminal 2:

cd frontend
python -m http.server 8000


Open browser:

http://localhost:8000


---

## Alignment Method Overview

The alignment algorithm performs approximate global registration:

1. Extracts tissue masks from H&E and CosMx
2. Measures tissue coverage similarity
3. Tests all 16 orientation combinations:
   - rotations: 0°, 90°, 180°, 270°
   - flip X
   - flip Y
4. Estimates translation using phase correlation
5. Performs local refinement

This produces a global alignment suitable for visualization and ROI
selection, but not cell-level registration.

Manual adjustments can still be applied within the viewer.

---

## Notes

- This tool is designed for visualization and region selection.
- It is not a precise histological registration method.
- CosMx and H&E originate from different section depths; perfect alignment
  is not expected.
- Users may refine alignment interactively and save the transform.
