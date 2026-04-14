/**
 * Phase 1: Qualitative Benchmarking Viewer
 * Left: H&E + Imported AI GeoJSON (Read-Only)
 * Right: CosMx Data
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
// 🌟 수정 3-3: Sync 초기값을 false(OFF)로 변경하여 초기 위치 조작을 용이하게 함
let syncEnabled = false; 
let lastLeftCenter = null;
let lastLeftZoom = null;

let cosmxTransformState = { rotation: 0, flipX: false, flipY: false, scale: 1.0 };

// 🌟 수정 2-4: 교수님 요청 컬러코드 반영 (Tumor=Red, Stroma=Green, Other=Purple)
const LABEL_COLORS = {
  tumor: { stroke: '#e74c3c', fill: 'rgba(231, 76, 60, 0.2)' },       // Red
  stroma: { stroke: '#2ecc71', fill: 'rgba(46, 204, 113, 0.2)' },     // Green
  lymphocyte: { stroke: '#9b59b6', fill: 'rgba(155, 89, 182, 0.2)' }, // Purple (Other)
  'in-situ': { stroke: '#9b59b6', fill: 'rgba(155, 89, 182, 0.2)' },  // Purple (Other)
  other: { stroke: '#9b59b6', fill: 'rgba(155, 89, 182, 0.2)' }       // Purple
};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
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
    readOnly: true, // Phase 1
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
        if (rightCenter) viewerRight.viewport.panTo(new OpenSeadragon.Point(rightCenter.x + dx, rightCenter.y + dy), true);
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
        if (rightZoom) viewerRight.viewport.zoomTo(rightZoom * zoomRatio, null, true);
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

  document.getElementById('btnApprove').onclick = () => setQCStatus('approved');
  document.getElementById('btnReject').onclick = () => setQCStatus('rejected');

  document.getElementById('importBtn').onclick = () => document.getElementById('importInput').click();
  document.getElementById('importInput').onchange = (e) => {
    if (e.target.files[0]) importGeoJSON(e.target.files[0]);
    e.target.value = '';
  };
  document.getElementById('clearAll').onclick = () => {
    if (confirm('Clear all overlays?')) { annotorious.clearAnnotations(); updateCount(); }
  };

  document.getElementById('syncToggle').onclick = toggleSync;
  document.getElementById('resyncBtn').onclick = resyncPanels;
  document.getElementById('cosmxToggle').onclick = (e) => {
    cosmxVisible = !cosmxVisible;
    e.target.textContent = cosmxVisible ? 'CosMx: ON' : 'CosMx: OFF';
    e.target.classList.toggle('active', cosmxVisible);
    if (cosmxVisible) { if (cosmxData?.dziUrl) renderCosMxOverlay(); } else removeCosMxLayerOnly();
  };

  setupTransformUI();

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      viewerLeft.gestureSettingsMouse.dragToPan = true;
      if(viewerRight) viewerRight.gestureSettingsMouse.dragToPan = true;
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      viewerLeft.gestureSettingsMouse.dragToPan = false;
      if(viewerRight) viewerRight.gestureSettingsMouse.dragToPan = false;
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

    const isRegistered = !!(dziData.registered);
    const dziUrl = `http://localhost:5000${dziData.dzi_url}`;
    console.log('[CosMx] isRegistered:', isRegistered);
    console.log('[CosMx] dziUrl:', dziData.dzi_url);

    cosmxData = {
      dziUrl, tiledImage: null,
      transform: isRegistered ? { transform: 'identity' } : transformData,
      isRegistered
    };
    if (cosmxVisible) await renderCosMxOverlay();
  } catch (err) { console.error('[CosMx] loadCosMxData error:', err); clearCosMxOverlay(true); }
}

async function renderCosMxOverlay() {
  if (!cosmxVisible || !cosmxData?.dziUrl || !viewerRight || cosmxData.tiledImage) return;

  viewerRight.addTiledImage({
    tileSource: cosmxData.dziUrl,
    opacity: 1.0, index: 0,
    success: (event) => {
      cosmxData.tiledImage = event.item;

      if (!cosmxData.isRegistered) {
        applyCosMxTransform(event.item, cosmxData.transform);
        syncToLeftPanel();
        return;
      }

      // ── Registered DZI 디버깅 ──────────────────────────────────────────
      const item = event.item;

      // 1. tiled image bounds (right viewer world 좌표)
      const ib = item.getBounds();
      console.log('[DEBUG] CosMx tiled image bounds:', JSON.stringify({
        x: ib.x, y: ib.y, w: ib.width, h: ib.height
      }));

      // 2. H&E tiled image bounds (left viewer world 좌표)
      const heItem = viewerLeft.world.getItemAt(0);
      if (heItem) {
        const hb = heItem.getBounds();
        console.log('[DEBUG] H&E tiled image bounds:', JSON.stringify({
          x: hb.x, y: hb.y, w: hb.width, h: hb.height
        }));
      }

      // 3. left viewport 상태
      const lVP = viewerLeft.viewport;
      console.log('[DEBUG] LEFT viewport zoom:', lVP.getZoom(true));
      console.log('[DEBUG] LEFT viewport center:', JSON.stringify(lVP.getCenter(true)));
      const lBounds = lVP.getBounds(true);
      console.log('[DEBUG] LEFT viewport bounds:', JSON.stringify({
        x: lBounds.x, y: lBounds.y, w: lBounds.width, h: lBounds.height
      }));

      // 4. right viewport 상태 (CosMx 추가 직후)
      const rVP = viewerRight.viewport;
      console.log('[DEBUG] RIGHT viewport zoom (before sync):', rVP.getZoom(true));
      console.log('[DEBUG] RIGHT viewport center (before sync):', JSON.stringify(rVP.getCenter(true)));
      const rBounds = rVP.getBounds(true);
      console.log('[DEBUG] RIGHT viewport bounds (before sync):', JSON.stringify({
        x: rBounds.x, y: rBounds.y, w: rBounds.width, h: rBounds.height
      }));

      // 5. 패널 스크린 크기
      const leftEl  = document.getElementById('viewerLeft');
      const rightEl = document.getElementById('viewerRight');
      console.log('[DEBUG] LEFT panel screen size:', leftEl?.clientWidth, 'x', leftEl?.clientHeight);
      console.log('[DEBUG] RIGHT panel screen size:', rightEl?.clientWidth, 'x', rightEl?.clientHeight);

      // 6. goHome + sync
      rVP.goHome(true);
      setTimeout(() => {
        console.log('[DEBUG] RIGHT viewport zoom (after goHome):', rVP.getZoom(true));
        console.log('[DEBUG] RIGHT viewport center (after goHome):', JSON.stringify(rVP.getCenter(true)));

        lVP.goHome(true);
        setTimeout(() => {
          console.log('[DEBUG] LEFT viewport zoom (after goHome):', lVP.getZoom(true));
          console.log('[DEBUG] LEFT viewport center (after goHome):', JSON.stringify(lVP.getCenter(true)));
          syncToLeftPanel();
          setTimeout(() => {
            console.log('[DEBUG] RIGHT viewport zoom (after sync):', rVP.getZoom(true));
            console.log('[DEBUG] RIGHT viewport center (after sync):', JSON.stringify(rVP.getCenter(true)));
            const rb2 = rVP.getBounds(true);
            console.log('[DEBUG] RIGHT viewport bounds (after sync):', JSON.stringify({
              x: rb2.x, y: rb2.y, w: rb2.width, h: rb2.height
            }));
          }, 100);
        }, 200);
      }, 300);
    }
  });
}

function syncToLeftPanel() {
  if (!viewerLeft?.viewport || !viewerRight?.viewport) return;
  const zoom   = viewerLeft.viewport.getZoom(true);
  const center = viewerLeft.viewport.getCenter(true);
  console.log('[SYNC] copying zoom:', zoom, 'center:', JSON.stringify(center));
  viewerRight.viewport.zoomTo(zoom, null, true);
  viewerRight.viewport.panTo(center, true);
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

function coordsToSvg(coords) { return `<svg><polygon points="${coords.map(([x, y]) => `${x},${y}`).join(' ')}"/></svg>`; }
function updateCount() { document.getElementById('annotationCount').textContent = annotorious.getAnnotations().length; }