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
let syncEnabled = false; 
let lastLeftCenter = null;
let lastLeftZoom = null;

let cosmxTransformState = { rotation: 0, flipX: false, flipY: false, scale: 1.0 };

// 🌟 Point Overlay 전용 State
const pointOverlay = { left: null };
const POINT_RADIUS = 20;

// 🌟 라벨 색상 (Lymphocyte를 파란색/Cyan으로 변경)
const LABEL_COLORS = {
  tumor: { stroke: '#e74c3c', fill: 'rgba(231, 76, 60, 0.2)' },       // Red
  stroma: { stroke: '#2ecc71', fill: 'rgba(46, 204, 113, 0.2)' },     // Green
  lymphocyte: { stroke: '#00ffff', fill: 'rgba(0, 255, 255, 0.2)' },  // Cyan (Blue)
  'in-situ': { stroke: '#f1c40f', fill: 'rgba(241, 196, 15, 0.2)' },  // Yellow
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
    if (confirm('Clear all overlays?')) { 
      annotorious.clearAnnotations(); 
      clearPointOverlay('left');
      updateCount(0); 
    }
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
  clearPointOverlay('left'); // 포인트 오버레이 초기화
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
      
      // 🌟 Polygon과 Point 객체 분리 필터링
      const pointFeatures = geojson.features.filter(f => f.geometry.type === 'Point');
      const polygonFeatures = geojson.features.filter(f => f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon');
      
      let totalCount = 0;

      // 1. Polygon 렌더링 (Annotorious 사용)
      if (polygonFeatures.length > 0) {
        const annotations = polygonFeatures.map(f => {
          const coords = f.geometry.type === 'Polygon' 
                         ? f.geometry.coordinates[0] 
                         : f.geometry.coordinates[0][0];

          let rawLabel = 'other';
          if (f.properties?.classification?.name) rawLabel = f.properties.classification.name;
          else if (f.properties?.name) rawLabel = f.properties.name;
          else if (f.properties?.label) rawLabel = f.properties.label;
          
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
        totalCount += annotations.length;
      }

      // 2. Point 렌더링 (단일 고속 SVG 오버레이 사용)
      if (pointFeatures.length > 0) {
        renderPointOverlay(viewerLeft, 'left', pointFeatures);
        totalCount += pointFeatures.length;
      }

      updateCount(totalCount);
    } catch (err) { alert(`Failed to import GeoJSON: ${err.message}`); }
  };
  reader.readAsText(file);
}

// ============================================================================
// 🌟 FAST POINT OVERLAY LOGIC (Point 객체 고속 렌더링)
// ============================================================================

function renderPointOverlay(viewer, panel, features) {
  clearPointOverlay(panel);
  const tiledImage = viewer.world.getItemAt(0);
  if (!tiledImage) return;
  
  const imgSize = tiledImage.getContentSize();
  const topLeft = tiledImage.imageToViewportCoordinates(0, 0);
  const botRight = tiledImage.imageToViewportCoordinates(imgSize.x, imgSize.y);
  
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('xmlns', svgNS);
  svg.setAttribute('viewBox', `0 0 ${imgSize.x} ${imgSize.y}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;';
  
  const color = LABEL_COLORS['lymphocyte']; // 파란색 지정
  const r = POINT_RADIUS;
  const parts = [];
  
  // 모든 Point 좌표를 단일 Path 스트링으로 결합 (렌더링 부하 최소화)
  for (const f of features) {
    const [cx, cy] = f.geometry.coordinates;
    parts.push(`M${cx - r},${cy}A${r},${r},0,1,0,${cx + r},${cy}A${r},${r},0,1,0,${cx - r},${cy}Z`);
  }
  
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', parts.join(' '));
  path.setAttribute('fill', color.fill);
  path.setAttribute('stroke', color.stroke);
  path.setAttribute('stroke-width', String(r * 0.5));
  svg.appendChild(path);
  
  const overlayEl = document.createElement('div');
  overlayEl.style.cssText = 'pointer-events:none;position:absolute;width:100%;height:100%;';
  overlayEl.appendChild(svg);
  
  viewer.addOverlay({
    element: overlayEl,
    location: new OpenSeadragon.Rect(
      topLeft.x, topLeft.y,
      botRight.x - topLeft.x, botRight.y - topLeft.y
    )
  });
  
  pointOverlay[panel] = { overlayEl, count: features.length };
}

function clearPointOverlay(panel) {
  const state = pointOverlay[panel];
  if (!state) return;
  try { viewerLeft.removeOverlay(state.overlayEl); } catch (_) {}
  pointOverlay[panel] = null;
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

      const item = event.item;
      const lVP = viewerLeft.viewport;
      const rVP = viewerRight.viewport;

      rVP.goHome(true);
      setTimeout(() => {
        lVP.goHome(true);
        setTimeout(() => {
          syncToLeftPanel();
        }, 200);
      }, 300);
    }
  });
}

function syncToLeftPanel() {
  if (!viewerLeft?.viewport || !viewerRight?.viewport) return;
  const zoom = viewerLeft.viewport.getZoom(true);
  const center = viewerLeft.viewport.getCenter(true);
  viewerRight.viewport.zoomTo(zoom, null, true);
  viewerRight.viewport.panTo(center, true);
}

function applyCosMxTransform(tiledImage, transformData) {
  if (transformData.transform === 'identity' || !transformData.transform) return;
  const t = transformData.transform;
  const heLayer = viewerLeft.world.getItemAt(0);
  if (!heLayer) return;
  const heBounds = heLayer.getBounds();
  
  let py_rot = t.rotation || 0;
  let py_fx = t.flipX || t.flip_h || false;
  let py_fy = t.flipY || false;
  
  let vX = {x:1, y:0}, vY = {x:0, y:1};
  let k = Math.floor(py_rot / 90) % 4;
  for(let i=0; i<k; i++) { vX = {x: vX.y, y: -vX.x}; vY = {x: vY.y, y: -vY.x}; }
  if (py_fx) { vX.x = -vX.x; vY.x = -vY.x; }
  if (py_fy) { vX.y = -vX.y; vY.y = -vY.y; }
  
  let osdFlipX = false, osdRotCW = 0;
  for (let flip of [false, true]) {
      for (let rot of [0, 90, 180, 270]) {
          let oX = {x:1, y:0}, oY = {x:0, y:1};
          if (flip) { oX.x = -oX.x; oY.x = -oY.x; }
          let rk = Math.floor(rot / 90) % 4;
          for(let i=0; i<rk; i++) { oX = {x: -oX.y, y: oX.x}; oY = {x: -oY.y, y: oY.x}; }
          if (vX.x === oX.x && vX.y === oX.y && vY.x === oY.x && vY.y === oY.y) {
              osdFlipX = flip; osdRotCW = rot; break;
          }
      }
  }
  
  tiledImage.setRotation(osdRotCW, true);
  tiledImage.setFlip(osdFlipX);
  
  let cxOrigW = tiledImage.source.width;
  let cxOrigH = tiledImage.source.height;
  let osdScale = t.scale || 1.0;
  
  if (transformData.original_sizes) {
      const heOrig = transformData.original_sizes.he;
      const cxOrig = transformData.original_sizes.cosmx;
      cxOrigW = cxOrig[0]; 
      cxOrigH = cxOrig[1];
      
      const heThumbW = Math.floor(heOrig[0] * Math.min(1024 / heOrig[0], 1024 / heOrig[1]));
      const cxThumbW = Math.floor(cxOrig[0] * Math.min(1024 / cxOrig[0], 1024 / cxOrig[1]));
      osdScale = (t.scale * cxThumbW) / heThumbW;
  }
  
  const W_unrot = heBounds.width * osdScale;
  const H_unrot = W_unrot * (cxOrigH / cxOrigW);
  tiledImage.setWidth(W_unrot, true);
  
  let dx = 0, dy = 0;
  if (t.translateX !== undefined) { 
      dx = t.translateX * heBounds.width + heBounds.x; 
      dy = t.translateY * heBounds.height + heBounds.y; 
  } else if (t.x !== undefined) { 
      dx = t.x; dy = t.y; 
  }
  
  const target_W = (osdRotCW % 180 !== 0) ? H_unrot : W_unrot;
  const target_H = (osdRotCW % 180 !== 0) ? W_unrot : H_unrot;
  
  const cX = dx + target_W / 2;
  const cY = dy + target_H / 2;
  
  const Pos_X = cX - W_unrot / 2;
  const Pos_Y = cY - H_unrot / 2;
  
  tiledImage.setPosition(new OpenSeadragon.Point(Pos_X, Pos_Y), true);
  
  cosmxTransformState.rotation = py_rot;
  cosmxTransformState.flipX = py_fx;
  cosmxTransformState.flipY = py_fy;
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

function updateCount(value) {
  const el = document.getElementById('annotationCount');
  if (el) {
    const annotoriousCount = annotorious ? annotorious.getAnnotations().length : 0;
    const pointCount = pointOverlay.left ? pointOverlay.left.count : 0;
    el.textContent = (typeof value === 'number') ? value : (annotoriousCount + pointCount);
  }
}