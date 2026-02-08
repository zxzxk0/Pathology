/**
 * SVS Dual Viewer - H&E + CosMx Panels
 * Left: H&E with annotations
 * Right: CosMx only (no H&E background)
 * 
 * v4.3: Viewport-based transform saving
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

// cosmxData: { dziUrl, tiledImage, transform }
let cosmxData = null;

// Prevent sync loops
let isSyncing = false;

const LABEL_COLORS = {
  tumor: { stroke: '#e74c3c', fill: 'rgba(231, 76, 60, 0.2)' },
  stroma: { stroke: '#3498db', fill: 'rgba(52, 152, 219, 0.2)' },
  lymphocyte: { stroke: '#27ae60', fill: 'rgba(39, 174, 96, 0.2)' },
  other: { stroke: '#f39c12', fill: 'rgba(243, 156, 18, 0.2)' }
};

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener('DOMContentLoaded', async () => {
  console.log('🚀 Starting dual viewer...');

  initDualViewers();
  initAnnotorious();
  setupSync();
  setupUI();

  await loadSlides();

  console.log('✅ Ready - Left: H&E, Right: CosMx only');
});

function initDualViewers() {
  viewerLeft = OpenSeadragon({
    id: 'viewerLeft',
    prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
    showNavigator: true,
    navigatorPosition: 'TOP_RIGHT',
    gestureSettingsMouse: {
      scrollToZoom: true,
      clickToZoom: false,
      dragToPan: false,
      pinchToZoom: true
    }
  });

  viewerRight = OpenSeadragon({
    id: 'viewerRight',
    prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
    showNavigator: true,
    navigatorPosition: 'TOP_RIGHT',
    gestureSettingsMouse: {
      scrollToZoom: true,
      clickToZoom: false,
      dragToPan: false,
      pinchToZoom: true
    }
  });

  console.log('✅ Dual viewers initialized');
}

function initAnnotorious() {
  const customFormatter = (anno) => {
    const label = anno.body?.find(b => b.purpose === 'tagging')?.value || 'other';
    const style = LABEL_COLORS[label] || LABEL_COLORS.other;
    return { style: `stroke:${style.stroke}; stroke-width:2; fill:${style.fill};` };
  };

  annotorious = OpenSeadragon.Annotorious(viewerLeft, {
    allowEmpty: true,
    drawOnSingleClick: false,
    disableEditor: true,
    formatter: customFormatter
  });

  annotorious.setDrawingTool('polygon');
  annotorious.setDrawingEnabled(false);
  console.log('💡 Click Polygon/Rectangle to draw (LEFT panel only)');

  annotorious.on('createAnnotation', (anno) => {
    const labeled = {
      ...anno,
      body: [{ type: 'TextualBody', purpose: 'tagging', value: currentLabel }]
    };

    annotorious.removeAnnotation(anno.id);
    
    setTimeout(() => {
      annotorious.addAnnotation(labeled);
      updateCount();
      console.log('✅ Created:', currentLabel);
      
      setTimeout(() => {
        const allAnnos = annotorious.getAnnotations();
        annotorious.setAnnotations(allAnnos);
      }, 50);
    }, 10);

    annotorious.setDrawingEnabled(false);
    console.log('💡 Click Polygon/Rectangle to draw again');
  });
}

// ============================================================================
// SYNCHRONIZATION (Delta-based: move together, not snap to position)
// ============================================================================

let syncEnabled = true;
let lastLeftCenter = null;
let lastLeftZoom = null;

function setupSync() {
  viewerLeft.addHandler('open', () => {
    lastLeftCenter = viewerLeft.viewport.getCenter();
    lastLeftZoom = viewerLeft.viewport.getZoom();
  });

  // Left pan -> Right moves by same delta
  viewerLeft.addHandler('pan', (event) => {
    if (!syncEnabled || isSyncing) return;
    if (!viewerRight.viewport) return;
    
    isSyncing = true;
    try {
      const currentCenter = viewerLeft.viewport.getCenter();
      
      if (lastLeftCenter) {
        const dx = currentCenter.x - lastLeftCenter.x;
        const dy = currentCenter.y - lastLeftCenter.y;
        
        const rightCenter = viewerRight.viewport.getCenter();
        if (rightCenter) {
          viewerRight.viewport.panTo(
            new OpenSeadragon.Point(rightCenter.x + dx, rightCenter.y + dy),
            true
          );
        }
      }
      
      lastLeftCenter = currentCenter.clone();
    } finally {
      isSyncing = false;
    }
  });

  // Left zoom -> Right zooms by same ratio
  viewerLeft.addHandler('zoom', (event) => {
    if (!syncEnabled || isSyncing) return;
    if (!viewerRight.viewport) return;
    
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
    } finally {
      isSyncing = false;
    }
  });

  console.log('✅ Delta-based sync enabled');
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
    btn.classList.toggle('active', syncEnabled);
  }
  
  console.log('🔄 Sync:', syncEnabled ? 'ON' : 'OFF');
}

function resyncPanels() {
  if (viewerLeft.viewport) {
    lastLeftCenter = viewerLeft.viewport.getCenter();
    lastLeftZoom = viewerLeft.viewport.getZoom();
  }
  console.log('📍 Sync position reset');
}

// ============================================================================
// SAVE COSMX POSITION (Viewport-based)
// ============================================================================

async function saveCosMxPosition() {
  if (!cosmxData?.tiledImage) {
    console.error('No CosMx layer loaded');
    alert('No CosMx layer loaded');
    return null;
  }
  
  if (!currentSlideId) {
    console.error('No slide selected');
    alert('No slide selected');
    return null;
  }
  
  // Get current viewport state (this is what changes when user pans!)
  const rightViewport = viewerRight.viewport;
  const center = rightViewport.getCenter();
  const zoom = rightViewport.getZoom();
  
  // Save viewport position along with transform settings
  const position = {
    rotation: cosmxTransformState.rotation,
    flipX: cosmxTransformState.flipX,
    flipY: cosmxTransformState.flipY,
    scale: cosmxTransformState.scale,
    // Viewport state - this captures the pan position!
    viewportCenterX: center.x,
    viewportCenterY: center.y,
    viewportZoom: zoom
  };
  
  const output = {
    version: "4.3",
    slide_id: currentSlideId,
    method: "manual_adjustment",
    timestamp: new Date().toISOString(),
    transform: position
  };
  
  console.log('📍 Saving transform (viewport-based):', position);
  
  try {
    const response = await fetch(`${API_BASE}/save-transform`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slide_id: currentSlideId,
        transform_data: output
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      console.log('✅ Transform saved to:', result.path);
      alert(`Transform saved!\n${result.path}`);
    } else {
      console.error('Save failed:', result.error);
      alert(`Save failed: ${result.error}`);
    }
  } catch (err) {
    console.error('Save error:', err);
    alert(`Save error: ${err.message}`);
  }
  
  return output;
}

// Reset CosMx to default position
function resetCosMxPosition() {
  if (!cosmxData?.tiledImage) {
    console.warn('No CosMx layer loaded');
    return;
  }
  
  // Reset tiledImage position
  cosmxData.tiledImage.setPosition(new OpenSeadragon.Point(0, 0), true);
  cosmxData.tiledImage.setRotation(0, true);
  cosmxData.tiledImage.setFlip(false);
  
  // Reset scale to match H&E
  const heLayer = viewerLeft.world.getItemAt(0);
  if (heLayer) {
    const heBounds = heLayer.getBounds();
    cosmxData.tiledImage.setWidth(heBounds.width, true);
  }
  
  // Reset transform state
  cosmxTransformState = {
    rotation: 0,
    flipX: false,
    flipY: false,
    scale: 1.0
  };
  
  updateTransformUI();
  
  // Sync viewport to left panel
  syncToLeftPanel();
  
  console.log('🔄 CosMx reset to default position');
}

// ============================================================================
// UI SETUP
// ============================================================================

function setupUI() {
  document.getElementById('slideSelect').onchange = (e) => {
    if (e.target.value) loadSlide(e.target.value);
  };

  document.querySelectorAll('.label-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.label-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      currentLabel = btn.dataset.label;
      console.log('Label:', currentLabel);
    };
  });

  document.getElementById('drawPolygon').onclick = () => {
    annotorious.setDrawingEnabled(false);
    setTimeout(() => {
      annotorious.setDrawingTool('polygon');
      annotorious.setDrawingEnabled(true);
      document.getElementById('drawPolygon').classList.add('selected');
      document.getElementById('drawRectangle').classList.remove('selected');
      console.log('🖊️ Polygon ready (LEFT panel)');
    }, 50);
  };

  document.getElementById('drawRectangle').onclick = () => {
    annotorious.setDrawingEnabled(false);
    setTimeout(() => {
      annotorious.setDrawingTool('rect');
      annotorious.setDrawingEnabled(true);
      document.getElementById('drawRectangle').classList.add('selected');
      document.getElementById('drawPolygon').classList.remove('selected');
      console.log('📐 Rectangle ready (LEFT panel)');
    }, 50);
  };

  let deleteMode = false;

  document.getElementById('deleteMode').onclick = (e) => {
    deleteMode = !deleteMode;
    e.target.style.background = deleteMode ? '#e74c3c' : '';
    e.target.style.color = deleteMode ? 'white' : '';
    e.target.textContent = deleteMode ? 'Exit Delete' : 'Delete Mode';

    if (deleteMode) {
      annotorious.setDrawingEnabled(false);
      viewerLeft.gestureSettingsMouse.dragToPan = true;
      console.log('🗑️ Delete mode');
    } else {
      annotorious.setDrawingEnabled(true);
      viewerLeft.gestureSettingsMouse.dragToPan = false;
      console.log('✏️ Drawing mode');
    }
  };

  annotorious.on('selectAnnotation', (anno) => {
    if (deleteMode && anno?.id) {
      annotorious.removeAnnotation(anno.id);
      updateCount();
      console.log('🗑️ Deleted');
    }
  });

  document.getElementById('deleteSelected').onclick = () => {
    const sel = annotorious.getSelected();
    if (!sel) return alert('Select annotation first');
    if (confirm('Delete?')) {
      annotorious.removeAnnotation(sel.id);
      updateCount();
    }
  };

  document.getElementById('clearAll').onclick = () => {
    const count = annotorious.getAnnotations().length;
    if (count === 0) return alert('No annotations');
    if (confirm(`Delete all ${count}?`)) {
      annotorious.clearAnnotations();
      updateCount();
    }
  };

  document.getElementById('saveBtn').onclick = saveAnnotations;
  document.getElementById('loadBtn').onclick = () => loadAnnotations();
  document.getElementById('exportBtn').onclick = exportGeoJSON;
  
  document.getElementById('importBtn').onclick = () => {
    document.getElementById('importInput').click();
  };
  
  document.getElementById('importInput').onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
      importGeoJSON(file);
      e.target.value = '';
    }
  };

  // CosMx toggle
  document.getElementById('cosmxToggle').onclick = (e) => {
    cosmxVisible = !cosmxVisible;
    e.target.textContent = cosmxVisible ? 'CosMx: ON' : 'CosMx: OFF';
    e.target.classList.toggle('active', cosmxVisible);

    if (cosmxVisible) {
      if (cosmxData?.dziUrl) renderCosMxOverlay();
    } else {
      removeCosMxLayerOnly();
    }

    console.log('CosMx overlay:', cosmxVisible ? 'ON' : 'OFF');
  };

  // Sync toggle button
  const syncBtn = document.getElementById('syncToggle');
  if (syncBtn) {
    syncBtn.onclick = toggleSync;
  }

  // Re-sync button
  const resyncBtn = document.getElementById('resyncBtn');
  if (resyncBtn) {
    resyncBtn.onclick = resyncPanels;
  }

  // ====== CosMx Transform Controls ======
  
  // Rotation slider
  const rotationSlider = document.getElementById('rotationSlider');
  const rotationValue = document.getElementById('rotationValue');
  if (rotationSlider) {
    rotationSlider.oninput = (e) => {
      const rotation = parseInt(e.target.value);
      rotationValue.textContent = rotation;
      setCosMxRotation(rotation);
    };
  }

  // Rotation preset buttons
  document.querySelectorAll('.preset-btn[data-rotation]').forEach(btn => {
    btn.onclick = () => {
      const rotation = parseInt(btn.dataset.rotation);
      if (rotationSlider) rotationSlider.value = rotation;
      if (rotationValue) rotationValue.textContent = rotation;
      setCosMxRotation(rotation);
      
      document.querySelectorAll('.preset-btn[data-rotation]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    };
  });

  // Flip X button
  const flipXBtn = document.getElementById('flipXBtn');
  if (flipXBtn) {
    flipXBtn.onclick = () => {
      toggleCosMxFlipX();
      flipXBtn.classList.toggle('active');
    };
  }

  // Flip Y button
  const flipYBtn = document.getElementById('flipYBtn');
  if (flipYBtn) {
    flipYBtn.onclick = () => {
      toggleCosMxFlipY();
      flipYBtn.classList.toggle('active');
    };
  }

  // Scale slider
  const scaleSlider = document.getElementById('scaleSlider');
  const scaleValue = document.getElementById('scaleValue');
  if (scaleSlider) {
    scaleSlider.oninput = (e) => {
      const scale = parseFloat(e.target.value);
      scaleValue.textContent = scale.toFixed(2);
      setCosMxScale(scale);
    };
  }

  // Save position button
  const savePositionBtn = document.getElementById('savePositionBtn');
  if (savePositionBtn) {
    savePositionBtn.onclick = saveCosMxPosition;
  }

  // Space key for pan
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      viewerLeft.gestureSettingsMouse.dragToPan = true;
      viewerRight.gestureSettingsMouse.dragToPan = true;
      e.preventDefault();
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') {
      const deleteBtn = document.getElementById('deleteMode');
      const isDeleteMode = deleteBtn.textContent === 'Exit Delete';
      if (!isDeleteMode) {
        viewerLeft.gestureSettingsMouse.dragToPan = false;
        viewerRight.gestureSettingsMouse.dragToPan = false;
      }
      e.preventDefault();
    }
  });
}

// ============================================================================
// SLIDES
// ============================================================================

async function loadSlides() {
  try {
    const res = await fetch(`${API_BASE}/slides`);
    const slides = await res.json();

    const select = document.getElementById('slideSelect');
    select.innerHTML = '<option value="">Select slide...</option>';

    slides.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name;
      select.appendChild(opt);
      slideDziMap[s.id] = `http://localhost:5000${s.dzi_url}`;
    });

    console.log(`Loaded ${slides.length} slides`);
  } catch (err) {
    console.error('Failed to load slides:', err);
  }
}

async function loadSlide(slideId) {
  currentSlideId = slideId;

  annotorious.clearAnnotations();
  clearCosMxOverlay(true);
  
  // Reset transform state
  cosmxTransformState = {
    rotation: 0,
    flipX: false,
    flipY: false,
    scale: 1.0
  };
  updateTransformUI();

  const dziUrl = slideDziMap[slideId];
  if (!dziUrl) return;

  console.log(`Loading: ${slideId}`);

  // Left panel: Load H&E
  viewerLeft.open(dziUrl);
  
  // Right panel: Close any existing image
  viewerRight.close();

  // Wait for left panel to load
  await new Promise(resolve => viewerLeft.addOnceHandler('open', resolve));

  await onSlidesReady();
}

async function onSlidesReady() {
  await loadAnnotations();
  await loadCosMxData();
  updateCount();
  console.log('✅ Left: H&E loaded, Right: CosMx only');
}

// ============================================================================
// ANNOTATIONS
// ============================================================================

async function saveAnnotations() {
  if (!currentSlideId) return alert('Select slide first');

  try {
    const annos = annotorious.getAnnotations();
    const geojson = {
      type: 'FeatureCollection',
      features: annos.map(a => ({
        type: 'Feature',
        properties: {
          id: a.id,
          label: a.body?.find(b => b.purpose === 'tagging')?.value || 'other'
        },
        geometry: {
          type: 'Polygon',
          coordinates: [extractCoords(a)]
        }
      }))
    };

    const res = await fetch(`${API_BASE}/annotations/${encodeURIComponent(currentSlideId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geojson)
    });

    if (res.ok) {
      console.log('✅ Saved');
      alert('Saved!');
    }
  } catch (err) {
    console.error('Save failed:', err);
    alert('Save failed');
  }
}

async function loadAnnotations() {
  if (!currentSlideId) return;

  try {
    const res = await fetch(`${API_BASE}/annotations/${encodeURIComponent(currentSlideId)}`);
    if (!res.ok) throw new Error('Not found');

    const geojson = await res.json();
    const annos = geojson.features.map(f => ({
      '@context': 'http://www.w3.org/ns/anno.jsonld',
      type: 'Annotation',
      id: f.properties.id || `anno_${Date.now()}`,
      body: [{
        type: 'TextualBody',
        purpose: 'tagging',
        value: f.properties.label || 'other'
      }],
      target: {
        selector: {
          type: 'SvgSelector',
          value: coordsToSvg(f.geometry.coordinates[0])
        }
      }
    }));

    annotorious.clearAnnotations();
    annotorious.setAnnotations(annos);
    
    setTimeout(() => {
      annotorious.setAnnotations(annotorious.getAnnotations());
      updateCount();
    }, 100);
    
    console.log(`Loaded ${annos.length} annotations`);
  } catch (err) {
    console.log('No annotations');
  }
}

function exportGeoJSON() {
  if (!currentSlideId) return alert('Select slide first');

  const annos = annotorious.getAnnotations();
  const geojson = {
    type: 'FeatureCollection',
    features: annos.map(a => ({
      type: 'Feature',
      properties: {
        id: a.id,
        label: a.body?.find(b => b.purpose === 'tagging')?.value || 'other'
      },
      geometry: {
        type: 'Polygon',
        coordinates: [extractCoords(a)]
      }
    }))
  };

  const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentSlideId}_annotations.geojson`;
  a.click();
  URL.revokeObjectURL(url);
  console.log('Exported');
}

function importGeoJSON(file) {
  if (!currentSlideId) {
    alert('Please select a slide first');
    return;
  }

  const reader = new FileReader();
  
  reader.onload = (e) => {
    try {
      const geojson = JSON.parse(e.target.result);
      
      if (!geojson.type || geojson.type !== 'FeatureCollection') {
        alert('Invalid GeoJSON: Must be a FeatureCollection');
        return;
      }
      
      if (!geojson.features || !Array.isArray(geojson.features)) {
        alert('Invalid GeoJSON: Missing features array');
        return;
      }
      
      const annotations = geojson.features.map(feature => {
        const coords = feature.geometry.coordinates[0];
        const label = feature.properties?.label || 'other';
        
        if (!Array.isArray(coords)) {
          console.error('Invalid coordinates:', coords);
          return null;
        }
        
        return {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          body: [{
            type: 'TextualBody',
            purpose: 'tagging',
            value: label
          }],
          target: {
            selector: {
              type: 'SvgSelector',
              value: coordsToSvg(coords)
            }
          }
        };
      }).filter(a => a !== null);
      
      annotorious.clearAnnotations();
      annotations.forEach(anno => annotorious.addAnnotation(anno));
      
      setTimeout(() => {
        annotorious.setAnnotations(annotorious.getAnnotations());
      }, 100);
      
      updateCount();
      
      console.log(`✅ Imported ${annotations.length} annotations from ${file.name}`);
      alert(`Successfully imported ${annotations.length} annotations`);
      
    } catch (err) {
      console.error('Import failed:', err);
      alert(`Failed to import GeoJSON: ${err.message}`);
    }
  };
  
  reader.onerror = () => alert('Failed to read file');
  reader.readAsText(file);
}

// ============================================================================
// COSMX OVERLAY
// ============================================================================

async function loadCosMxData() {
  console.log('🔍 loadCosMxData() called');

  try {
    clearCosMxOverlay(true);

    const dziRes = await fetch(`${API_BASE}/cosmx/${encodeURIComponent(currentSlideId)}/dzi`);

    if (!dziRes.ok) {
      console.log('ℹ️ No CosMx data for this slide');
      return;
    }

    const dziData = await dziRes.json();
    console.log('✅ CosMx DZI found:', dziData.dzi_url);

    const transformRes = await fetch(`${API_BASE}/cosmx/${encodeURIComponent(currentSlideId)}/transform`);
    const transformData = transformRes.ok 
      ? await transformRes.json() 
      : { transform: 'identity' };
    
    console.log('📐 Transform:', transformData);

    cosmxData = { 
      dziUrl: `http://localhost:5000${dziData.dzi_url}`,
      tiledImage: null,
      transform: transformData
    };

    if (cosmxVisible) {
      await renderCosMxOverlay();
    }
  } catch (err) {
    console.log('❌ No CosMx data for this slide:', err.message);
    clearCosMxOverlay(true);
  }
}

async function renderCosMxOverlay() {
  console.log('🎨 renderCosMxOverlay() called');

  if (!cosmxVisible) return;
  if (!cosmxData?.dziUrl || !viewerRight) {
    console.log('   ❌ Missing cosmxData or viewerRight');
    return;
  }

  if (cosmxData.tiledImage) return;

  const dziUrl = cosmxData.dziUrl;

  try {
    viewerRight.addTiledImage({
      tileSource: dziUrl,
      opacity: 1.0,
      index: 0,
      success: (event) => {
        cosmxData.tiledImage = event.item;
        
        // Apply transform
        applyCosMxTransform(event.item, cosmxData.transform);
        
        console.log('✅ CosMx DZI layer added');
      },
      error: (event) => {
        console.error('❌ Failed to load CosMx DZI:', event);
      }
    });
  } catch (err) {
    console.error('❌ Error rendering CosMx:', err);
  }
}

function syncToLeftPanel() {
  if (!viewerLeft?.viewport || !viewerRight?.viewport) return;
  
  try {
    const zoom = viewerLeft.viewport.getZoom();
    const center = viewerLeft.viewport.getCenter();
    
    viewerRight.viewport.zoomTo(zoom, null, true);
    viewerRight.viewport.panTo(center, true);
    
    console.log('📍 Synced right panel to left panel');
  } catch (err) {
    console.log('   Could not sync viewports:', err.message);
  }
}

// ============================================================================
// APPLY COSMX TRANSFORM (with viewport restore)
// ============================================================================

function applyCosMxTransform(tiledImage, transformData) {
  console.log('🔧 Applying CosMx transform...');
  
  // Identity transform - just sync to left panel
  if (transformData.transform === 'identity') {
    console.log('   ✅ Identity transform');
    syncToLeftPanel();
    return;
  }
  
  const t = transformData.transform;
  
  if (!t) {
    console.warn('   ⚠️ No transform data');
    syncToLeftPanel();
    return;
  }
  
  // Get H&E reference for scale calculation
  const heLayer = viewerLeft.world.getItemAt(0);
  if (!heLayer) {
    console.warn('   ⚠️ No H&E reference');
    return;
  }
  
  const heBounds = heLayer.getBounds();
  console.log(`   📐 H&E size: ${heBounds.width.toFixed(4)} x ${heBounds.height.toFixed(4)}`);
  
  // Handle FlipY (convert to rotation + flipX)
  let effectiveRotation = t.rotation || 0;
  let effectiveFlipX = t.flipX || t.flip_h || false;
  
  if (t.flipY) {
    effectiveRotation = (effectiveRotation + 180) % 360;
    effectiveFlipX = !effectiveFlipX;
    console.log('   🔄 FlipY -> rotation+flipX');
  }
  
  // 1. Rotation
  if (effectiveRotation) {
    tiledImage.setRotation(effectiveRotation, true);
    console.log(`   🔄 Rotation: ${effectiveRotation}°`);
  }
  
  // 2. Flip
  if (effectiveFlipX) {
    tiledImage.setFlip(true);
    console.log('   🔃 FlipX: true');
  }
  
  // 3. Scale
  const transformScale = t.scale || 1.0;
  const finalWidth = heBounds.width * transformScale;
  tiledImage.setWidth(finalWidth, true);
  console.log(`   📏 Scale: ${transformScale}`);
  
  // 4. Restore viewport position (v4.3 - this is the key!)
  if (t.viewportCenterX !== undefined && t.viewportCenterY !== undefined) {
    setTimeout(() => {
      const center = new OpenSeadragon.Point(t.viewportCenterX, t.viewportCenterY);
      viewerRight.viewport.panTo(center, true);
      
      if (t.viewportZoom !== undefined) {
        viewerRight.viewport.zoomTo(t.viewportZoom, null, true);
      }
      
      console.log(`   📍 Viewport restored: (${t.viewportCenterX.toFixed(4)}, ${t.viewportCenterY.toFixed(4)})`);
    }, 100);
  } else {
    // Fallback: sync to left panel
    syncToLeftPanel();
  }
  
  console.log('   ✅ Transform applied');
  
  // Update UI state
  cosmxTransformState.rotation = t.rotation || 0;
  cosmxTransformState.flipX = t.flipX || t.flip_h || false;
  cosmxTransformState.flipY = t.flipY || false;
  cosmxTransformState.scale = t.scale || 1.0;
  
  updateTransformUI();
}

function removeCosMxLayerOnly() {
  if (!viewerRight) return;

  if (cosmxData?.tiledImage) {
    viewerRight.world.removeItem(cosmxData.tiledImage);
    cosmxData.tiledImage = null;
    console.log('   Removed CosMx layer');
  }
}

function clearCosMxOverlay(reset = false) {
  if (!viewerRight) return;

  if (cosmxData?.tiledImage) {
    viewerRight.world.removeItem(cosmxData.tiledImage);
  }

  if (reset) {
    cosmxData = null;
  } else {
    if (cosmxData) cosmxData.tiledImage = null;
  }
}

// ============================================================================
// COSMX TRANSFORM CONTROLS
// ============================================================================

let cosmxTransformState = {
  rotation: 0,
  flipX: false,
  flipY: false,
  scale: 1.0
};

function setCosMxRotation(degrees) {
  if (!cosmxData?.tiledImage) {
    console.warn('No CosMx layer loaded');
    return;
  }
  
  cosmxTransformState.rotation = degrees;
  
  let effectiveRotation = degrees;
  let effectiveFlipX = cosmxTransformState.flipX;
  
  if (cosmxTransformState.flipY) {
    effectiveRotation = (degrees + 180) % 360;
    effectiveFlipX = !cosmxTransformState.flipX;
  }
  
  cosmxData.tiledImage.setRotation(effectiveRotation, true);
  cosmxData.tiledImage.setFlip(effectiveFlipX);
  
  console.log(`🔄 Rotation: ${degrees}°`);
}

function toggleCosMxFlipX() {
  if (!cosmxData?.tiledImage) {
    console.warn('No CosMx layer loaded');
    return;
  }
  
  cosmxTransformState.flipX = !cosmxTransformState.flipX;
  
  let effectiveRotation = cosmxTransformState.rotation;
  let effectiveFlipX = cosmxTransformState.flipX;
  
  if (cosmxTransformState.flipY) {
    effectiveRotation = (cosmxTransformState.rotation + 180) % 360;
    effectiveFlipX = !cosmxTransformState.flipX;
  }
  
  cosmxData.tiledImage.setRotation(effectiveRotation, true);
  cosmxData.tiledImage.setFlip(effectiveFlipX);
  
  console.log(`🔃 FlipX: ${cosmxTransformState.flipX}`);
}

function toggleCosMxFlipY() {
  if (!cosmxData?.tiledImage) {
    console.warn('No CosMx layer loaded');
    return;
  }
  
  cosmxTransformState.flipY = !cosmxTransformState.flipY;
  
  let effectiveRotation = cosmxTransformState.rotation;
  let effectiveFlipX = cosmxTransformState.flipX;
  
  if (cosmxTransformState.flipY) {
    effectiveRotation = (cosmxTransformState.rotation + 180) % 360;
    effectiveFlipX = !cosmxTransformState.flipX;
  }
  
  cosmxData.tiledImage.setRotation(effectiveRotation, true);
  cosmxData.tiledImage.setFlip(effectiveFlipX);
  
  console.log(`🔃 FlipY: ${cosmxTransformState.flipY}`);
}

function setCosMxScale(scale) {
  if (!cosmxData?.tiledImage) {
    console.warn('No CosMx layer loaded');
    return;
  }
  
  cosmxTransformState.scale = scale;
  
  const heLayer = viewerLeft.world.getItemAt(0);
  if (!heLayer) {
    console.warn('No H&E reference');
    return;
  }
  
  const heBounds = heLayer.getBounds();
  const finalWidth = heBounds.width * scale;
  
  cosmxData.tiledImage.setWidth(finalWidth, true);
  
  console.log(`📏 Scale: ${scale.toFixed(3)}`);
}

function updateTransformUI() {
  const rotationSlider = document.getElementById('rotationSlider');
  const rotationValue = document.getElementById('rotationValue');
  const scaleSlider = document.getElementById('scaleSlider');
  const scaleValue = document.getElementById('scaleValue');
  const flipXBtn = document.getElementById('flipXBtn');
  const flipYBtn = document.getElementById('flipYBtn');
  
  if (rotationSlider) rotationSlider.value = cosmxTransformState.rotation;
  if (rotationValue) rotationValue.textContent = cosmxTransformState.rotation;
  if (scaleSlider) scaleSlider.value = cosmxTransformState.scale;
  if (scaleValue) scaleValue.textContent = cosmxTransformState.scale.toFixed(2);
  if (flipXBtn) flipXBtn.classList.toggle('active', cosmxTransformState.flipX);
  if (flipYBtn) flipYBtn.classList.toggle('active', cosmxTransformState.flipY);
  
  document.querySelectorAll('.preset-btn[data-rotation]').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.rotation) === cosmxTransformState.rotation);
  });
}

// ============================================================================
// DEBUG HELPERS (Console commands)
// ============================================================================

function getCosMxTransform() {
  if (!cosmxData?.tiledImage) {
    console.error('No CosMx layer loaded');
    return;
  }
  
  const item = cosmxData.tiledImage;
  const bounds = item.getBounds();
  const vp = viewerRight.viewport;
  
  console.log('=== Current State ===');
  console.log('TiledImage bounds:', { x: bounds.x, y: bounds.y });
  console.log('Viewport center:', vp.getCenter());
  console.log('Viewport zoom:', vp.getZoom());
  console.log('Transform state:', cosmxTransformState);
  
  return {
    tiledImage: { x: bounds.x, y: bounds.y },
    viewport: { center: vp.getCenter(), zoom: vp.getZoom() },
    state: { ...cosmxTransformState }
  };
}

// ============================================================================
// HELPERS
// ============================================================================

function extractCoords(annotation) {
  const sel = annotation.target?.selector;
  if (!sel || sel.type !== 'SvgSelector') return [];

  const m = sel.value.match(/points\s*=\s*["']([^"']+)["']/i);
  if (!m) return [];

  return m[1].trim().split(/\s+/).map(p => p.split(',').map(Number));
}

function coordsToSvg(coords) {
  if (!Array.isArray(coords)) {
    console.error('coordsToSvg: coords is not an array', coords);
    return '<svg><polygon points="0,0"/></svg>';
  }
  
  const pts = coords.map(([x, y]) => `${x},${y}`).join(' ');
  return `<svg><polygon points="${pts}"/></svg>`;
}

function updateCount() {
  const count = annotorious.getAnnotations().length;
  document.getElementById('annotationCount').textContent = count;
}

// ============================================================================
// STARTUP LOG
// ============================================================================

console.log('✅ Viewer v4.3 loaded (viewport-based saving)');
console.log('💡 Console commands:');
console.log('   saveCosMxPosition()  - Save current position');
console.log('   resetCosMxPosition() - Reset to default');
console.log('   getCosMxTransform()  - Show debug info');
console.log('   toggleSync()         - Toggle sync ON/OFF');