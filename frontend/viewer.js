/**
 * Phase 1: Qualitative Benchmarking Viewer
 * Left: H&E + Imported AI GeoJSON (Read-Only)
 * Right: CosMx Data
 * * - 스페이스바 화면 이동 로직 유지
 * - Delta 기반 Sync 및 수동 정렬 로직 유지
 */

const API_BASE = 'http://localhost:5000/api';

// Dual viewers
let viewerLeft = null;
let viewerRight = null;
let annotorious = null;

// State
let currentSlideId = null;
let currentLabel = 'tumor';
let slideDziMap = {};
let cosmxVisible = true;
let cosmxData = null;

// Sync & Movement State
let isSyncing = false;
let syncEnabled = true;
let lastLeftCenter = null;
let lastLeftZoom = null;

let cosmxTransformState = { rotation: 0, flipX: false, flipY: false, scale: 1.0 };

const LABEL_COLORS = {
  tumor: { stroke: '#e056fd', fill: 'rgba(224, 86, 253, 0.2)' },       // Vibrant Magenta 
  stroma: { stroke: '#2e86de', fill: 'rgba(46, 134, 222, 0.2)' },      // Deep Blue 
  lymphocyte: { stroke: '#00cec9', fill: 'rgba(0, 206, 201, 0.2)' },   // Bright Teal 
  'in-situ': { stroke: '#6c5ce7', fill: 'rgba(108, 92, 231, 0.2)' },   // Soft Purple 
  other: { stroke: '#f0932b', fill: 'rgba(240, 147, 43, 0.2)' }        // Muted Orange 
};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('🚀 Starting Phase 1 dual viewer (Movement logic restored)...');
  initDualViewers();
  initAnnotorious();
  setupSync();
  setupUI();
  await loadSlides();
});

function initDualViewers() {
  viewerLeft = OpenSeadragon({
    id: 'viewerLeft',
    prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
    showNavigator: true,
    navigatorPosition: 'TOP_RIGHT',
    gestureSettingsMouse: { scrollToZoom: true, clickToZoom: false, dragToPan: false, pinchToZoom: true }
  });

  viewerRight = OpenSeadragon({
    id: 'viewerRight',
    prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
    showNavigator: true,
    navigatorPosition: 'TOP_RIGHT',
    gestureSettingsMouse: { scrollToZoom: true, clickToZoom: false, dragToPan: false, pinchToZoom: true }
  });
}

function initAnnotorious() {
  const customFormatter = (anno) => {
    const label = anno.body?.find(b => b.purpose === 'tagging')?.value || 'other';
    const style = LABEL_COLORS[label] || LABEL_COLORS.other;
    return { style: `stroke:${style.stroke}; stroke-width:2; fill:${style.fill};` };
  };

  annotorious = OpenSeadragon.Annotorious(viewerLeft, {
    readOnly: true, 
    allowEmpty: true,
    drawOnSingleClick: false,
    disableEditor: true,
    formatter: customFormatter
  });
}

// ============================================================================
// SYNCHRONIZATION 
// ============================================================================

function setupSync() {
  viewerLeft.addHandler('open', () => {
    lastLeftCenter = viewerLeft.viewport.getCenter();
    lastLeftZoom = viewerLeft.viewport.getZoom();
  });

  viewerLeft.addHandler('pan', (event) => {
    if (!syncEnabled || isSyncing || !viewerRight.viewport) return;
    isSyncing = true;
    try {
      const currentCenter = viewerLeft.viewport.getCenter();
      if (lastLeftCenter) {
        const dx = currentCenter.x - lastLeftCenter.x;
        const dy = currentCenter.y - lastLeftCenter.y;
        const rightCenter = viewerRight.viewport.getCenter();
        if (rightCenter) {
          viewerRight.viewport.panTo(new OpenSeadragon.Point(rightCenter.x + dx, rightCenter.y + dy), true);
        }
      }
      lastLeftCenter = currentCenter.clone();
    } finally { isSyncing = false; }
  });

  viewerLeft.addHandler('zoom', (event) => {
    if (!syncEnabled || isSyncing || !viewerRight.viewport) return;
    isSyncing = true;
    try {
      const currentZoom = viewerLeft.viewport.getZoom();
      if (lastLeftZoom && lastLeftZoom > 0) {
        const zoomRatio = currentZoom / lastLeftZoom;
        const rightZoom = viewerRight.viewport.getZoom();
        if (rightZoom) {
          viewerRight.viewport.zoomTo(rightZoom * zoomRatio, null, true);
        }
      }
      lastLeftZoom = currentZoom;
    } finally { isSyncing = false; }
  });
}

function toggleSync() {
  syncEnabled = !syncEnabled;
  if (syncEnabled && viewerLeft.viewport) {
    lastLeftCenter = viewerLeft.viewport.getCenter();
    lastLeftZoom = viewerLeft.viewport.getZoom();
  }
  const btn = document.getElementById('syncToggle');
  if (btn) {
    btn.textContent = syncEnabled ? 'Sync: ON' : 'Sync: OFF';
    btn.style.background = syncEnabled ? '#00d4ff' : '#0f3460';
    btn.style.color = syncEnabled ? '#1a1a2e' : '#eee';
  }
  const status = document.getElementById('syncStatus');
  if (status) status.textContent = syncEnabled ? '🔄 Moving Together' : '🔓 Right Panel Independent';
}

function resyncPanels() {
  if (viewerLeft.viewport) {
    lastLeftCenter = viewerLeft.viewport.getCenter();
    lastLeftZoom = viewerLeft.viewport.getZoom();
  }
}

// ============================================================================
// UI & EVENTS 
// ============================================================================

function setupUI() {
  document.getElementById('slideSelect').onchange = (e) => {
    if (e.target.value) loadSlide(e.target.value);
  };

  // Phase 1 QC
  document.getElementById('btnApprove').onclick = () => setQCStatus('approved');
  document.getElementById('btnReject').onclick = () => setQCStatus('rejected');

  // Import GeoJSON
  document.getElementById('importBtn').onclick = () => document.getElementById('importInput').click();
  document.getElementById('importInput').onchange = (e) => {
    if (e.target.files[0]) importGeoJSON(e.target.files[0]);
    e.target.value = '';
  };
  document.getElementById('clearAll').onclick = () => {
    if (confirm('Clear all overlays?')) { annotorious.clearAnnotations(); updateCount(); }
  };

  // Sync / CosMx Toggles
  document.getElementById('syncToggle').onclick = toggleSync;
  document.getElementById('resyncBtn').onclick = resyncPanels;
  document.getElementById('cosmxToggle').onclick = (e) => {
    cosmxVisible = !cosmxVisible;
    e.target.textContent = cosmxVisible ? 'CosMx: ON' : 'CosMx: OFF';
    e.target.classList.toggle('active', cosmxVisible);
    if (cosmxVisible) { if (cosmxData?.dziUrl) renderCosMxOverlay(); } else removeCosMxLayerOnly();
  };

  // CosMx Transform Controls 연동
  setupTransformUI();

  // [복구 완료] 스페이스바(Space)를 통한 화면 이동(Pan) 로직
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      viewerLeft.gestureSettingsMouse.dragToPan = true;
      if(viewerRight) viewerRight.gestureSettingsMouse.dragToPan = true;
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      const deleteBtn = document.getElementById('deleteMode');
      const isDeleteMode = deleteBtn && deleteBtn.textContent === 'Exit Delete';
      if (!isDeleteMode) {
        viewerLeft.gestureSettingsMouse.dragToPan = false;
        if(viewerRight) viewerRight.gestureSettingsMouse.dragToPan = false;
      }
      e.preventDefault();
    }
  });
}

// ============================================================================
// QC & DATA LOADING
// ============================================================================

async function loadQCStatus() {
  const badge = document.getElementById('qcStatusBadge');
  badge.className = 'qc-status-badge'; badge.textContent = 'Status: Loading...';
  try {
    const res = await fetch(`${API_BASE}/qc/${currentSlideId}`);
    const data = await res.json();
    updateQCBadge(data.status);
  } catch (err) { updateQCBadge('unreviewed'); }
}

async function setQCStatus(status) {
  if (!currentSlideId) return alert('Please select a slide first.');
  try {
    const res = await fetch(`${API_BASE}/qc/${currentSlideId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
    });
    const data = await res.json();
    updateQCBadge(data.qc_status);
  } catch (err) { alert('Failed to save QC status.'); }
}

function updateQCBadge(status) {
  const badge = document.getElementById('qcStatusBadge');
  badge.className = 'qc-status-badge'; 
  if (status === 'approved') { badge.classList.add('approved'); badge.textContent = '✅ Approved for Registration'; } 
  else if (status === 'rejected') { badge.classList.add('rejected'); badge.textContent = '❌ Rejected Sample'; } 
  else { badge.textContent = 'Status: Unreviewed'; }
}

async function loadSlides() {
  try {
    const res = await fetch(`${API_BASE}/slides`);
    const slides = await res.json();
    const select = document.getElementById('slideSelect');
    select.innerHTML = '<option value="">Select slide...</option>';
    slides.forEach(s => {
      const opt = document.createElement('option'); opt.value = s.id; opt.textContent = s.name;
      select.appendChild(opt); slideDziMap[s.id] = `http://localhost:5000${s.dzi_url}`;
    });
  } catch (err) { console.error(err); }
}

async function loadSlide(slideId) {
  currentSlideId = slideId;
  annotorious.clearAnnotations();
  clearCosMxOverlay(true);
  cosmxTransformState = { rotation: 0, flipX: false, flipY: false, scale: 1.0 };
  updateTransformUI();
  
  const dziUrl = slideDziMap[slideId];
  if (!dziUrl) return;

  viewerLeft.open(dziUrl);
  viewerRight.close();
  loadQCStatus();

  await new Promise(resolve => viewerLeft.addOnceHandler('open', resolve));
  await loadCosMxData();
  updateCount();
}

function importGeoJSON(file) {
  if (!currentSlideId) return alert('Please select a slide first');
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const geojson = JSON.parse(e.target.result);
      if (!geojson.features) return alert('Invalid GeoJSON');
      
      const annotations = geojson.features.map(f => {
        const coords = f.geometry.coordinates[0];
        
        // 🌟 수정된 부분: QuPath 포맷 인식 및 소문자 변환
        let rawLabel = 'other';
        if (f.properties?.classification?.name) {
          rawLabel = f.properties.classification.name;
        } else if (f.properties?.name) {
          rawLabel = f.properties.name;
        } else if (f.properties?.label) {
          rawLabel = f.properties.label;
        }
        
        const label = String(rawLabel).toLowerCase().trim();

        return {
          '@context': 'http://www.w3.org/ns/anno.jsonld', type: 'Annotation',
          body: [{ type: 'TextualBody', purpose: 'tagging', value: label }],
          target: { selector: { type: 'SvgSelector', value: coordsToSvg(coords) } }
        };
      });
      
      annotorious.clearAnnotations();
      annotations.forEach(anno => annotorious.addAnnotation(anno));
      setTimeout(() => annotorious.setAnnotations(annotorious.getAnnotations()), 100);
      updateCount();
      console.log(`✅ Imported ${annotations.length} annotations`);
    } catch (err) { alert(`Failed to import GeoJSON: ${err.message}`); }
  };
  reader.readAsText(file);
}

// ============================================================================
// COSMX LOGIC & TRANSFORMS 
// ============================================================================

async function loadCosMxData() {
  try {
    clearCosMxOverlay(true);
    const dziRes = await fetch(`${API_BASE}/cosmx/${encodeURIComponent(currentSlideId)}/dzi`);
    if (!dziRes.ok) return;
    const dziData = await dziRes.json();
    
    const transformRes = await fetch(`${API_BASE}/cosmx/${encodeURIComponent(currentSlideId)}/transform`);
    const transformData = transformRes.ok ? await transformRes.json() : { transform: 'identity' };
    
    cosmxData = { dziUrl: `http://localhost:5000${dziData.dzi_url}`, tiledImage: null, transform: transformData };
    if (cosmxVisible) await renderCosMxOverlay();
  } catch (err) { clearCosMxOverlay(true); }
}

async function renderCosMxOverlay() {
  if (!cosmxVisible || !cosmxData?.dziUrl || !viewerRight || cosmxData.tiledImage) return;
  viewerRight.addTiledImage({
    tileSource: cosmxData.dziUrl,
    opacity: 1.0, index: 0,
    success: (event) => {
      cosmxData.tiledImage = event.item;
      applyCosMxTransform(event.item, cosmxData.transform);
      syncToLeftPanel();
    }
  });
}

function syncToLeftPanel() {
  if (!viewerLeft?.viewport || !viewerRight?.viewport) return;
  viewerRight.viewport.zoomTo(viewerLeft.viewport.getZoom(), null, true);
  viewerRight.viewport.panTo(viewerLeft.viewport.getCenter(), true);
}

function applyCosMxTransform(tiledImage, transformData) {
  if (transformData.transform === 'identity' || !transformData.transform) return;
  const t = transformData.transform;
  const heLayer = viewerLeft.world.getItemAt(0);
  if (!heLayer) return;
  const heBounds = heLayer.getBounds();
  
  let effectiveRotation = t.rotation || 0;
  let effectiveFlipX = t.flipX || t.flip_h || false;
  if (t.flipY) { effectiveRotation = (effectiveRotation + 180) % 360; effectiveFlipX = !effectiveFlipX; }
  
  if (effectiveRotation) tiledImage.setRotation(effectiveRotation, true);
  if (effectiveFlipX) tiledImage.setFlip(true);
  
  const transformScale = t.scale || 1.0;
  tiledImage.setWidth(heBounds.width * transformScale, true);
  
  let dx = 0, dy = 0;
  if (t.translateX !== undefined) { dx = t.translateX * heBounds.width; dy = t.translateY * heBounds.height; }
  else if (t.x !== undefined) { dx = t.x; dy = t.y; }
  
  if (dx !== 0 || dy !== 0) tiledImage.setPosition(new OpenSeadragon.Point(tiledImage.getBounds().x + dx, tiledImage.getBounds().y + dy), true);
  
  cosmxTransformState.rotation = t.rotation || 0;
  cosmxTransformState.flipX = t.flipX || t.flip_h || false;
  cosmxTransformState.flipY = t.flipY || false;
  cosmxTransformState.scale = t.scale || 1.0;
  updateTransformUI();
}

function removeCosMxLayerOnly() {
  if (viewerRight && cosmxData?.tiledImage) { viewerRight.world.removeItem(cosmxData.tiledImage); cosmxData.tiledImage = null; }
}
function clearCosMxOverlay(reset = false) {
  if (viewerRight && cosmxData?.tiledImage) viewerRight.world.removeItem(cosmxData.tiledImage);
  if (reset) cosmxData = null; else if (cosmxData) cosmxData.tiledImage = null;
}

function setupTransformUI() {
  const rs = document.getElementById('rotationSlider');
  if(rs) rs.oninput = (e) => { document.getElementById('rotationValue').textContent = e.target.value; setCosMxRotation(parseInt(e.target.value)); };
  document.querySelectorAll('.preset-btn[data-rotation]').forEach(btn => btn.onclick = () => {
    const rot = parseInt(btn.dataset.rotation);
    if(rs) rs.value = rot; document.getElementById('rotationValue').textContent = rot;
    setCosMxRotation(rot);
    document.querySelectorAll('.preset-btn[data-rotation]').forEach(b => b.classList.remove('active')); btn.classList.add('active');
  });
  const fx = document.getElementById('flipXBtn'); if(fx) fx.onclick = () => { toggleCosMxFlipX(); fx.classList.toggle('active'); };
  const fy = document.getElementById('flipYBtn'); if(fy) fy.onclick = () => { toggleCosMxFlipY(); fy.classList.toggle('active'); };
  const ss = document.getElementById('scaleSlider'); if(ss) ss.oninput = (e) => { document.getElementById('scaleValue').textContent = parseFloat(e.target.value).toFixed(2); setCosMxScale(parseFloat(e.target.value)); };
  const savePos = document.getElementById('savePositionBtn'); if(savePos) savePos.onclick = () => saveCosMxPosition();
}

function setCosMxRotation(degrees) {
  if (!cosmxData?.tiledImage) return;
  cosmxTransformState.rotation = degrees;
  let r = degrees, f = cosmxTransformState.flipX;
  if (cosmxTransformState.flipY) { r = (degrees + 180) % 360; f = !f; }
  cosmxData.tiledImage.setRotation(r, true); cosmxData.tiledImage.setFlip(f);
}
function toggleCosMxFlipX() {
  if (!cosmxData?.tiledImage) return;
  cosmxTransformState.flipX = !cosmxTransformState.flipX;
  let r = cosmxTransformState.rotation, f = cosmxTransformState.flipX;
  if (cosmxTransformState.flipY) { r = (r + 180) % 360; f = !f; }
  cosmxData.tiledImage.setRotation(r, true); cosmxData.tiledImage.setFlip(f);
}
function toggleCosMxFlipY() {
  if (!cosmxData?.tiledImage) return;
  cosmxTransformState.flipY = !cosmxTransformState.flipY;
  let r = cosmxTransformState.rotation, f = cosmxTransformState.flipX;
  if (cosmxTransformState.flipY) { r = (r + 180) % 360; f = !f; }
  cosmxData.tiledImage.setRotation(r, true); cosmxData.tiledImage.setFlip(f);
}
function setCosMxScale(scale) {
  if (!cosmxData?.tiledImage || !viewerLeft.world.getItemAt(0)) return;
  cosmxTransformState.scale = scale;
  cosmxData.tiledImage.setWidth(viewerLeft.world.getItemAt(0).getBounds().width * scale, true);
}
function updateTransformUI() {
  const rs = document.getElementById('rotationSlider'); if(rs) rs.value = cosmxTransformState.rotation;
  const rv = document.getElementById('rotationValue'); if(rv) rv.textContent = cosmxTransformState.rotation;
  const ss = document.getElementById('scaleSlider'); if(ss) ss.value = cosmxTransformState.scale;
  const sv = document.getElementById('scaleValue'); if(sv) sv.textContent = cosmxTransformState.scale.toFixed(2);
  const fx = document.getElementById('flipXBtn'); if(fx) fx.classList.toggle('active', cosmxTransformState.flipX);
  const fy = document.getElementById('flipYBtn'); if(fy) fy.classList.toggle('active', cosmxTransformState.flipY);
  document.querySelectorAll('.preset-btn[data-rotation]').forEach(btn => btn.classList.toggle('active', parseInt(btn.dataset.rotation) === cosmxTransformState.rotation));
}

function saveCosMxPosition() {
  if (!cosmxData?.tiledImage) return null;
  const bounds = cosmxData.tiledImage.getBounds();
  const heBounds = viewerLeft.world.getItemAt(0)?.getBounds() || {width:1, height:1};
  const pos = { rotation: cosmxTransformState.rotation, flipX: cosmxTransformState.flipX, flipY: cosmxTransformState.flipY, translateX: bounds.x / heBounds.width, translateY: bounds.y / heBounds.height, scale: cosmxTransformState.scale };
  const output = { version: "4.0", slide_id: currentSlideId, method: "manual_adjustment", transform: pos };
  console.log('SAVE TO transform.json:\n', JSON.stringify(output, null, 2));
  alert('Position saved to console!');
  return pos;
}

function extractCoords(annotation) { const m = annotation.target?.selector?.value.match(/points\s*=\s*["']([^"']+)["']/i); return m ? m[1].trim().split(/\s+/).map(p => p.split(',').map(Number)) : []; }
function coordsToSvg(coords) { return `<svg><polygon points="${coords.map(([x, y]) => `${x},${y}`).join(' ')}"/></svg>`; }
function updateCount() { document.getElementById('annotationCount').textContent = annotorious.getAnnotations().length; }