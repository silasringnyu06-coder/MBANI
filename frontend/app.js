// ================= MBANI WebGIS - app.js =================
//  1. Helpers            2. Projections          3. Zoning rules
//  4. Geometry           5. Map, basemaps & overlays
//  6. Permit layers      7. Data loading         8. Table & map rendering
//  9. Details modal     10. Search & tabs       11. Live GPS navigation
// 12. Start

// ---------- 1. Helpers ----------
const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
const setHTML = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
const na = (x) => (x === undefined || x === null || x === '' ? 'N/A' : x);

// Local / LAN / production backend, decided once from the page address
const API_BASE = (() => {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || location.protocol === 'file:') return 'http://localhost:5000';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return `http://${h}:5000`;
  return 'https://mbani.onrender.com';
})();

// Status banner (also used to show any script error on screen)
function setDataStatus(msg, type = '') {
  const el = $('data-status');
  if (el) { el.className = msg ? 'data-status show ' + type : 'data-status'; el.textContent = msg || ''; }
}
window.addEventListener('error', (e) => setDataStatus('⚠️ ' + e.message, 'error'));

// ---------- 2. Projections (WGS84 <-> UTM 32N) ----------
proj4.defs('EPSG:32632', '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs');
const toUTM = (lng, lat) => proj4('EPSG:4326', 'EPSG:32632', [lng, lat]);
const toWGS = (x, y) => proj4('EPSG:32632', 'EPSG:4326', [x, y]);
const isUTM = (x, y) => Math.abs(x) > 180 || Math.abs(y) > 90;
const fmtUTM = (lng, lat) => { const [x, y] = toUTM(lng, lat); return `${x.toFixed(1)} E, ${y.toFixed(1)} N`; };

// ---------- 3. Zoning rules & compliance ----------
// Per arrondissement: [max CES, max COS, max floors, max height m]
const ZONING = {
  1: [.6, 2, 4, 12], 2: [.7, 2.5, 5, 15], 3: [.5, 1.5, 3, 9], 4: [.6, 2, 4, 12],
  5: [.55, 1.8, 3, 10], 6: [.5, 1.5, 3, 9], 7: [.45, 1.2, 2, 7.5], D: [.6, 2, 4, 12]
};
const zoneRules = (k) => {
  const [maxCES, maxCOS, maxFloors, maxHeightM] = ZONING[k] || ZONING.D;
  return { maxCES, maxCOS, maxFloors, maxHeightM };
};

// FIX 1: Finds the arrondissement number strictly from location fields, ignoring permit numbers
const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };

function detectArrondissement(r) {
  for (const f of [r.arrondissement, r.parcel_arrondissement, r.quartier, r.nom_zone, r.code_zone]) {
    if (f === undefined || f === null || f === '') continue;
    const s = String(f);
    
    // 1. Matches "YDE 1", "YDE1", "YDE-1", "Yaoundé 1", or "Yaounde-1"
    const prefixMatch = s.match(/(?:yaound[eé]|yde)[\s-]*([1-7])/i);
    if (prefixMatch) return prefixMatch[1];
    
    // 2. Matches standalone digits 1 to 7
    const digitMatch = s.match(/\b[1-7]\b/);
    if (digitMatch) return digitMatch[0];
    
    // 3. Matches Roman Numerals (e.g., III, II, I)
    const romanMatch = s.match(/\b(vii|vi|iv|v|iii|ii|i)\b/i);
    if (romanMatch) return String(ROMAN[romanMatch[1].toLowerCase()]);
  }
  return null; // Clean fallback to "Default" if no valid district text is present
}

function checkZoningCompliance(r) {
  const n = detectArrondissement(r);
  const zone = n ? `Yaoundé ${n}` : 'Default', rules = zoneRules(n);
  const area = parseFloat(r.cadastral_area || r.parcel_calculated_area || 0);
  const built = parseFloat(r.building_calculated_area || 0);

  const flRaw = String(r.etages_hors_sol || r.nombre_planchers || '1');
  const floors = parseInt((flRaw.match(/\d+/) || ['1'])[0], 10) + (/^\s*(g|r|rdc)\s*\+/i.test(flRaw) ? 1 : 0);
  const height = parseFloat(r.hauteur_construction || 0);
  
  // Use database CES if explicitly provided, otherwise compute from geometry
  const dbCES = parseFloat(r.ces || 0);
  const computedCES = area > 0 && built > 0 ? built / area : 0;
  const ces = dbCES > 0 ? dbCES : computedCES;

  const cos = area > 0 && built > 0 ? (built * floors) / area : parseFloat(r.cos || 0);

  const issues = [];
  if (height > rules.maxHeightM) issues.push(`Height ${height}m exceeds max ${rules.maxHeightM}m`);
  if (floors > rules.maxFloors) issues.push(`${floors} floors exceed max ${rules.maxFloors}`);
  
  // Use a small tolerance (0.001) to prevent floating-point precision bugs (e.g. 0.7000000000000001 > 0.70)
  if (ces - rules.maxCES > 0.001) issues.push(`CES ${(ces * 100).toFixed(1)}% exceeds max ${rules.maxCES * 100}%`);
  if (cos - rules.maxCOS > 0.001) issues.push(`COS ${cos.toFixed(2)} exceeds max ${rules.maxCOS}`);
  if (r.setback_ok === false) issues.push(`Front setback (${r.recul_voies_publiques || 0}m) violates urban certificate minimum (${r.retrait_minimal_m}m)`);
  const ok = !issues.length;
  return {
    isCompliant: ok, zoneUsed: zone, issuesList: issues,
    badgeHTML: `<span style="background:${ok ? '#2ecc71' : '#e74c3c'};color:#fff;padding:3px 8px;border-radius:4px;font-weight:bold;font-size:11px;white-space:nowrap;">${ok ? 'Compliant' : 'Non-Compliant'} (${zone})</span>`
  };
}
function displayZoneInfo(zone) {
  const r = zoneRules(String(zone).replace(/\D/g, ''));
  setHTML('zone-info-display', `Max Height: <strong>${r.maxHeightM}m</strong> | Max Floors: <strong>${r.maxFloors}</strong> | Max CES: <strong>${r.maxCES * 100}%</strong> | Max COS: <strong>${r.maxCOS}</strong>`);
}

// ---------- 4. Geometry helpers ----------
function parseGeom(g) {
  if (typeof g !== 'string') return g || null;
  try { return JSON.parse(g); } catch (e) { return null; }
}
// Recursively converts any UTM coordinates to WGS84
const reproj = (c) => typeof c[0] === 'number' ? (isUTM(c[0], c[1]) ? toWGS(c[0], c[1]) : c) : c.map(reproj);

// Full geometry (Geometry, Feature or GeometryCollection) in WGS84 for Leaflet
function toWGS84Geom(raw) {
  const g = parseGeom(raw);
  if (!g) return null;
  try {
    const c = JSON.parse(JSON.stringify(g));
    (c.geometries || [c.geometry || c]).forEach(x => { if (x && x.coordinates) x.coordinates = reproj(x.coordinates); });
    return c;
  } catch (e) { return g; }
}

// First ring of the first polygon, as [lng, lat] points
function ringWGS(raw) {
  const g = parseGeom(raw);
  if (!g) return [];
  const gg = g.geometries ? g.geometries[0] : g.geometry || g;
  let c = gg && gg.coordinates;
  if (!c) return [];
  while (Array.isArray(c[0]) && Array.isArray(c[0][0])) c = c[0];
  return c.filter(p => typeof p[0] === 'number' && typeof p[1] === 'number').map(p => isUTM(p[0], p[1]) ? toWGS(p[0], p[1]) : p);
}

function centroidUTM(raw) {
  const pts = ringWGS(raw);
  if (!pts.length) return { x: 'N/A', y: 'N/A' };
  const avg = (i) => pts.reduce((s, p) => s + p[i], 0) / pts.length;
  const [x, y] = toUTM(avg(0), avg(1));
  return { x: x.toFixed(4), y: y.toFixed(4) };
}

const combinedGeom = (r) => r.parcel_and_building_geom || r.view_combined_geom;

// Vertex lists in UTM for the details modal
function vertices(r) {
  const pts = (raw) => raw ? ringWGS(raw).map((p, i) => { const [x, y] = toUTM(p[0], p[1]); return { index: i + 1, x: x.toFixed(4), y: y.toFixed(4) }; }) : [];
  const out = { parcel: pts(r.parcel_geom), building: pts(r.building_geom) };
  if (!out.parcel.length && !out.building.length) out.parcel = pts(combinedGeom(r));
  return out;
}

// ---------- 5. Map, basemaps & overlays ----------
const map = L.map('map').setView([3.848, 11.502], 12);

const tiles = (url, attribution, opts = {}) => L.tileLayer(url, { maxZoom: 19, attribution, ...opts });
const google = (lyr) => tiles(`https://mt1.google.com/vt/lyrs=${lyr}&x={x}&y={y}&z={z}`, 'Map data © Google', { maxZoom: 20 });
const baseLayers = {
  'Google Satellite': google('s'),
  'Google Satellite Hybrid': google('y'),
  'OpenStreetMap': location.protocol === 'file:'
    ? tiles('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', '&copy; OpenStreetMap contributors, OSM France', { subdomains: 'abc' })
    : tiles('https://tile.openstreetmap.org/{z}/{x}/{y}.png', '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'),
  'Streets (Esri)': tiles('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', 'Tiles &copy; Esri')
};
baseLayers['Google Satellite'].addTo(map);

// Small popup builder shared by the overlay layers
const infoPopup = (header, rows) => `<div style="font-family:sans-serif;font-size:12px;">${header}${rows.map(([k, v]) => `<strong>${k}:</strong>${v}`).join('<br>')}</div>`;

// POS zoning: colour by vocation
const ZONE_COLORS = [['habitat', '#2ecc71'], ['commercial', '#e74c3c'], ['industriel', '#9b59b6'], ['vert', '#27ae60']];
const zoningLayer = L.geoJSON(null, {
  style: (f) => {
    const t = f.properties.zone_type || '', hit = ZONE_COLORS.find(([k]) => t.includes(k));
    return { fillColor: hit ? hit[1] : '#3388ff', weight: 1, color: 'white', dashArray: '3', fillOpacity: 0.4 };
  },
  onEachFeature: (f, l) => {
    const p = f.properties || {};
    l.bindPopup(infoPopup('', [['Zone Code', na(p.zone_name)], ['Vocation', na(p.zone_type)], ['CES Max', na(p.ces)], ['COS Max', na(p.cos)], ['Hauteur Max', na(p.hauteur_max) + 'm']]));
  }
});

// Quartiers: light blue fill so the basemap stays visible
const quartiersLayer = L.geoJSON(null, {
  style: { color: '#2c3e50', weight: 1.5, fillColor: '#3498db', fillOpacity: 0.15 },
  onEachFeature: (f, l) => {
    const p = f.properties || {};
    l.bindPopup(infoPopup(`<h4 style="margin:0 0 5px;color:#2c3e50;">${p.name || 'Unknown Quartier'}</h4>`, [['Commune', na(p.commune)]]));
  }
});

L.control.layers(baseLayers, { 'POS Zoning (Yaoundé)': zoningLayer, 'Quartiers (Yaoundé)': quartiersLayer }).addTo(map);
zoningLayer.addTo(map);
quartiersLayer.addTo(map);

// Both overlays are loaded only for the visible area (bbox), above a minimum zoom
const OVERLAYS = [
  { layer: zoningLayer, path: 'zones', minZoom: 12 },
  { layer: quartiersLayer, path: 'quartiers', minZoom: 10 }
];
async function loadOverlay({ layer, path, minZoom }) {
  if (map.getZoom() < minZoom) return layer.clearLayers();
  const b = map.getBounds();
  try {
    const res = await fetch(`${API_BASE}/api/${path}/bbox?minLng=${b.getWest()}&minLat=${b.getSouth()}&maxLng=${b.getEast()}&maxLat=${b.getNorth()}`);
    const data = await res.json();
    layer.clearLayers();
    layer.addData(data);
  } catch (err) { console.error(`Error loading ${path} layer:`, err); }
}
const refreshOverlays = () => OVERLAYS.forEach(loadOverlay);
map.on('moveend', refreshOverlays);

// Live UTM coordinates under the mouse
map.on('mousemove click', (e) => {
  const [x, y] = toUTM(e.latlng.lng, e.latlng.lat);
  setHTML('coord-display', `UTM Zone 32N (EPSG:32632) | X: ${x.toFixed(5)} m E | Y: ${y.toFixed(5)} m N`);
});

// ---------- 6. Permit layers & state ----------
map.createPane('parcelPane').style.zIndex = 410;   // parcels under buildings
map.createPane('buildingPane').style.zIndex = 420;
const PANE = { parcel: 'parcelPane', building: 'buildingPane' };
const STYLE = {
  parcel: { color: '#00d2ff', weight: 3, fillColor: '#00d2ff', fillOpacity: .25 },
  building: { color: '#ffea00', weight: 2, fillColor: '#ffab00', fillOpacity: .65 }
};
const geojsonGroup = L.featureGroup().addTo(map);       // permits on the map
const trackingLayerGroup = L.layerGroup().addTo(map);   // GPS marker, halo, step dot
const layersMap = {};  // permit key -> feature group (with .kinds, .bnds, .kb, .land)
const landMap = {};    // land id -> [permit keys] (permits on the same land)
let globalPermitData = [], activeKey = null, showingAll = false, layerMode = 'all', sortCol = null, asc = true;

// ---------- 7. Data loading ----------
const tableMessage = (msg, color = '') =>
  setHTML('permit-table-body', `<tr><td colspan="7" style="text-align:center;${color && 'color:' + color}">${msg}</td></tr>`);

async function loadBuildingPermit() {
  tableMessage('Loading building permit data...');
  setDataStatus('⏳ Loading records… (the Render server may take up to a minute to wake up)');
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 70000);
  try {
    const res = await fetch(`${API_BASE}/api/building-permit`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    globalPermitData = await res.json();
    renderTableAndMap(globalPermitData);
    setDataStatus(`✅ ${globalPermitData.length} record(s) loaded.`, 'ok');
    setTimeout(() => setDataStatus(''), 4000);
    refreshOverlays();
  } catch (err) {
    console.error('Error fetching data:', err);
    tableMessage('Failed to load data from the server.', 'red');
    setDataStatus('❌ Could not reach the server (' + err.message + '). If it is the Render server, wait a minute and refresh.', 'error');
  } finally { clearTimeout(timer); }
}

// ---------- 8. Table & map rendering ----------
function sortTableBy(col) {
  asc = sortCol === col ? !asc : true;
  sortCol = col;
  document.querySelectorAll('th[data-k]').forEach(th => {
    const isSorted = th.dataset.k === col, si = th.querySelector('.si');
    th.classList.toggle('sorted', isSorted);
    if (si) si.textContent = isSorted ? (asc ? '▲' : '▼') : '↕';
  });
  globalPermitData.sort((a, b) => {
    let x = (a[col] || '').toString().toLowerCase(), y = (b[col] || '').toString().toLowerCase();
    if (x !== '' && y !== '' && !isNaN(x) && !isNaN(y)) { x = +x; y = +y; }
    return x < y ? (asc ? -1 : 1) : x > y ? (asc ? 1 : -1) : 0;
  });
  renderTableAndMap(globalPermitData);
}

function updateShowAllButton() {
  const b = $('toggleAllGeomBtn');
  if (b) { b.classList.toggle('active', showingAll); b.innerHTML = showingAll ? '❌ Clear All Features' : '🌐 Show All Parcels & Footprints'; }
}

// Bounds of what is visible for the current mode (all / parcel / building)
const visBounds = (g) => layerMode === 'all' ? g.bnds : g.kb[layerMode];
const boundsOf = (keys) => keys.reduce((b, k) => { const v = layersMap[k] && visBounds(layersMap[k]); return v && v.isValid() ? b.extend(v) : b; }, L.latLngBounds([]));
const fit = (b, o) => b && b.isValid() && map.fitBounds(b, o);
const siblings = (key) => { const g = layersMap[key]; return (g && g.land && landMap[g.land]) || [key]; };

function openPopup(g) {
  const kind = layerMode !== 'parcel' && g.kinds.building.length ? 'building' : 'parcel';
  const l = g.kinds[kind][0] || g.kinds.parcel[0];
  if (l) l.openPopup(l.getBounds().getCenter());
}

// Show/hide parcel & building layers according to layerMode
function applyMode() {
  Object.values(layersMap).forEach(g => ['parcel', 'building'].forEach(k =>
    g.kinds[k].forEach(l => (layerMode === 'all' || layerMode === k) ? g.addLayer(l) : g.removeLayer(l))));
}

function display(keys = Object.keys(layersMap)) {
  geojsonGroup.clearLayers();
  keys.forEach(k => layersMap[k] && geojsonGroup.addLayer(layersMap[k]));
  applyMode();
}

function setView(key, all) {
  activeKey = key;
  showingAll = all && geojsonGroup.getLayers().length > 0;
  updateShowAllButton();
}

function showAll() {
  display();
  setView(null, true);
  fit(boundsOf(Object.keys(layersMap)), { padding: [30, 30], animate: true });
  return showingAll;
}

function clearMap() { geojsonGroup.clearLayers(); setView(null, false); }

// Show one permit together with the other permits on the same land
function showPermitOnMap(key) {
  const g = layersMap[key];
  if (!g) return false;
  display(siblings(key));
  setView(key, false);
  fit(boundsOf(siblings(key)), { padding: [30, 30], maxZoom: 19, animate: true });
  openPopup(g);
  return true;
}

// Zoom on a permit without hiding the others (table row click)
function focusOnPermit(key) {
  const g = layersMap[key];
  if (!g) return;
  if (!geojsonGroup.hasLayer(g)) { geojsonGroup.addLayer(g); applyMode(); }
  fit(visBounds(g), { padding: [50, 50], maxZoom: 19 });
  openPopup(g);
}

function togglePermitOnMap(key) { if (layersMap[key]) activeKey === key ? clearMap() : showPermitOnMap(key); }
function toggleAllPermitsOnMap() {
  if (showingAll) return clearMap();
  if (!showAll()) alert('No spatial geometries found.');
}

function setMode(m) {
  layerMode = m;
  document.querySelectorAll('#layer-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  if (!geojsonGroup.getLayers().length) return showAll();
  applyMode();
  fit(boundsOf(activeKey ? siblings(activeKey) : Object.keys(layersMap)), { padding: [30, 30], maxZoom: 19, animate: true });
}
document.querySelectorAll('#layer-mode button').forEach(b => b.onclick = () => setMode(b.dataset.mode));

// Building popup: permit summary
function popupHTML(title, color, r, comp, raw, idx) {
  const c = centroidUTM(raw);
  return `<div style="font-size:13px;"><strong style="color:${color};font-size:14px;">${title}</strong><br>
    <strong>Permit:</strong> ${na(r.numero_permis)}<br><strong>Applicant:</strong> ${na(r.name)}<br>
    <strong>Zoning:</strong> ${comp.badgeHTML}<br><strong>Center UTM X:</strong> ${c.x} m E<br><strong>Center UTM Y:</strong> ${c.y} m N<br><br>
    <a href="#" onclick="showDetails(${idx}); return false;">View Details</a></div>`;
}

// Parcel popup: land & urban-planning diagnostic from the server
async function fetchAndShowParcelDiagnostic(parcelId, layer, idx) {
  try {
    const res = await fetch(`${API_BASE}/api/parcelle/spatial-info/${parcelId}`);
    if (!res.ok) throw new Error('Failed to fetch spatial info');
    const d = await res.json();
    layer.bindPopup(`
      <div style="font-family:sans-serif;font-size:12px;width:240px;">
        <strong style="color:#0284c7;font-size:14px;">📍 Diagnostic Foncier & Urbanisme</strong><br><br>
        <div style="background:${d.status_color};color:#fff;padding:5px 8px;border-radius:4px;font-weight:bold;margin-bottom:8px;text-align:center;">${d.constructibility_status}</div>
        <strong>🏡 Quartier:</strong> ${d.quartier} (${d.commune})<br>
        <strong>🏛️ Zone POS:</strong> ${d.zone_code} - ${d.zone_vocation}<br>
        <strong>📏 Limit Rules:</strong> CES: ${d.ces_max} | COS: ${d.cos_max} | H: ${d.hauteur_max}m<br><br>
        <a href="#" onclick="showDetails(${idx}); return false;">View Full Details</a>
      </div>`).openPopup();
  } catch (err) { console.error('Failed to load parcel spatial diagnostic:', err); }
}

// Builds one map feature group + one table row per permit
function renderTableAndMap(data) {
  const body = $('permit-table-body');
  body.innerHTML = '';
  geojsonGroup.clearLayers();
  [layersMap, landMap].forEach(obj => Object.keys(obj).forEach(k => delete obj[k]));
  activeKey = null; showingAll = false;

  if (!data || !data.length) { tableMessage('No records found.'); return updateShowAllButton(); }

  data.forEach((r, idx) => {
    let key = String(r.permis_id || r.numero_permis || idx);
    if (layersMap[key]) key += '#' + idx;
    r.__key = key;
    const comp = checkZoningCompliance(r);

    // --- map layers ---
    const g = L.featureGroup();
    g.kinds = { parcel: [], building: [] };
    [[r.parcel_geom, 'parcel', 'Parcel', '#0284c7'],
     [r.building_geom, 'building', 'Building Permit', 'red'],
     [!r.parcel_geom && !r.building_geom && combinedGeom(r), 'parcel', 'Parcel / Building', '#0284c7']
    ].forEach(([raw, kind, title, color]) => {
      const geo = raw && toWGS84Geom(raw);
      if (!geo) return;
      const l = L.geoJSON(geo, { style: STYLE[kind], pane: PANE[kind] });
      if (kind === 'parcel' && r.parcelle_id) l.on('click', () => fetchAndShowParcelDiagnostic(r.parcelle_id, l, idx));
      else l.bindPopup(popupHTML(title, color, r, comp, raw, idx));
      g.kinds[kind].push(l);
      g.addLayer(l);
    });
    if (g.getLayers().length) {
      g.bnds = g.getBounds();
      g.kb = {};
      ['parcel', 'building'].forEach(k => { const b = L.latLngBounds([]); g.kinds[k].forEach(l => b.extend(l.getBounds())); g.kb[k] = b; });
      layersMap[key] = g;
      const pg = r.parcel_geom;
      g.land = r.parcelle_id || r.titre_foncier || r.title_rec_no || (pg ? (typeof pg === 'string' ? pg : JSON.stringify(pg)) : '');
      if (g.land) (landMap[g.land] = landMap[g.land] || []).push(key);
    }

    // --- table row ---
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${na(r.numero_permis)}</strong></td>
      <td>${na(r.name)}</td>
      <td>${na(r.proprietaire_nom)}</td>
      <td>${na(r.arrondissement)}</td>
      <td>${comp.badgeHTML}</td>
      <td style="white-space:nowrap;">
        <button class="btn-details" onclick="event.stopPropagation(); togglePermitOnMap('${key}')">👁️ Show/Hide</button>
        <button class="btn-details" onclick="event.stopPropagation(); showDetails(${idx})">View All</button>
      </td>`;
    row.onclick = () => focusOnPermit(key);
    body.appendChild(row);
  });

  showAll();
  setTimeout(() => map.invalidateSize(), 200);
}

// ---------- 9. Details modal ----------
// Each section: [title, open by default?, [[label, field, unit?], ...]]
const SECTIONS = [
  ['🏠 1. Land Owner Information (Propriétaire)', true, [
    ['Owner Name', 'proprietaire_nom'], ['Owner NUI', 'proprietaire_nui'], ['Owner Phone', 'proprietaire_telephone'],
    ['Owner Email', 'proprietaire_email'], ['Owner Address', 'proprietaire_adresse'], ['Owner Sex', 'proprietaire_sexe'],
    ['Owner CNI', 'proprietaire_cni'], ['Owner Nationality', 'proprietaire_nationalite']]],
  ['👤 2. Applicant Information (Personne)', false, [
    ['Full Name', 'name'], ['NUI', 'nui'], ['Phone', 'telephone'], ['Email', 'email'],
    ['Address', 'adresse'], ['Sex', 'sexe'], ['CNI', 'cni']]],
  ['🗺️ 3. Parcel & Cadastre Details (Parcelle)', false, [
    ['Plot No', 'plot_no'], ['Arrondissement', 'arrondissement'], ['Quarter', 'quartier'], ['Lieu-dit', 'lieu_dit'],
    ['Cadastral Area', 'cadastral_area'], ['Calculated Area', 'parcel_calculated_area', 'm²'],
    ['Land Title No', 'titre_foncier'], ['Parent Title No', 'num_tit_foncier_mere'], ['Lot No', 'num_lot'],
    ['Subdivision (Lotissement)', 'lotissement'], ['Easements (Servitudes)', 'servitudes'], ['Co-Owners', 'co_owners'],
    ['Property Cert No', 'prop_cert_no'], ['Property Cert Date', 'prop_cert_date']]],
  ["📜 4. Urban Certificate Details (Certificat d'Urbanisme)", false, [
    ['CU Number', 'cu_number'], ['CU Dossier No', 'cu_num_dossier'], ['Date Demande', 'date_demande'],
    ['Qualité Demandeur', 'qualite_demandeur'], ['Opération Demandée', 'operation_demandee'], ['Usage du Bâti (CU)', 'cu_usage_bati'],
    ['Code Zone', 'code_zone'], ['Nom Zone', 'nom_zone'], ['Min Road Width', 'largeur_voie_minimale_m', 'm'],
    ['Min Setback', 'retrait_minimal_m', 'm'], ['Min Facade', 'facade_minimale_m', 'm'],
    ['Min Parcel Area', 'superficie_parcelle_minimale_m2', 'm²'], ['Prohibited Activities', 'activites_interdites'],
    ['CU Status', 'statut_cu'], ['CU Issue Date', 'date_delivrance'], ['CU Expiry Date', 'date_expiration']]],
  ['🏢 5. Building Permit Details (Permis de Construire)', false, [
    ['Permit No', 'numero_permis'], ['Arrete No', 'arrete_number'], ['Technical File No', 'technical_file_no'],
    ['Commission Date', 'commission_date'], ['Nature Travaux', 'nature_travaux'], ['Nombre Planchers', 'nombre_planchers'],
    ['Etages Hors-Sol', 'etages_hors_sol'], ['Etages Sous-Sol', 'etages_sous_sol'], ['Building Use', 'usage_bati'],
    ['Parking Places', 'nombre_places_parkings'], ['Height', 'hauteur_construction', 'm'], ['Terrain Area', 'superficie_terrain', 'm²'],
    ['Calculated Area', 'building_calculated_area', 'm²'], ['Building Cost', 'building_cost'], ['Total Project Cost', 'cout_total_projet'],
    ['COS', 'cos'], ['CES', 'ces'], ['Front Setback', 'recul_voies_publiques', 'm'], ['Side Setback', 'recul_limites_separatives', 'm'],
    ['Title Rec No', 'title_rec_no'], ['Lead Architect', 'architecte_responsable'], ['Architect ONAC No', 'architect_onac_no'],
    ['Permit Status', 'statut_permis'], ['Input Database Date', 'input_database_date'], ['Issue Date', 'issue_date'], ['Expiry Date', 'expiry_date']]]
];

const detailItem = (label, val, unit) => { const v = na(val); return `<div class="details-item"><span>${label}</span>${v !== 'N/A' && unit ? `${v}${unit}` : v}</div>`; };

const section = (title, content, open) => `
  <details ${open ? 'open' : ''} style="grid-column:span 2;margin-top:10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;padding:8px 12px;">
    <summary style="font-weight:bold;font-size:15px;color:#0f172a;cursor:pointer;padding:4px 0;user-select:none;">${title}</summary>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0;">${content}</div>
  </details>`;

function vertexTable(pts, title) {
  const wide = 'class="details-item" style="grid-column:span 2;"', th = 'style="padding:4px 8px;background:#f1f5f9;color:#0f172a;"', td = 'style="padding:3px 8px;"';
  if (!pts.length) return `<div ${wide}><span>${title}</span>N/A</div>`;
  return `<div ${wide}><span>${title} (${pts.length} Vertices)</span>
    <div style="max-height:130px;overflow-y:auto;margin-top:6px;border:1px solid #e2e8f0;border-radius:4px;">
      <table style="width:100%;font-size:11px;"><thead style="position:sticky;top:0;"><tr><th ${th}>Point</th><th ${th}>UTM Easting (X)</th><th ${th}>UTM Northing (Y)</th></tr></thead>
      <tbody>${pts.map(p => `<tr><td ${td}>P${p.index}</td><td ${td}>${p.x} m E</td><td ${td}>${p.y} m N</td></tr>`).join('')}</tbody></table>
    </div></div>`;
}

function showDetails(index) {
  const r = globalPermitData[index];
  if (!r) return;
  const comp = checkZoningCompliance(r), v = vertices(r);
  const issues = comp.issuesList.length
    ? comp.issuesList.map(i => `<li style="color:#c0392b;margin:4px 0;">⚠️ ${i}</li>`).join('')
    : `<li style="color:#16a34a;font-weight:bold;list-style:none;">✓ Passed all zoning rules for ${comp.zoneUsed}</li>`;

  $('modal-title').innerText = `Building Permit Details: ${na(r.numero_permis)}`;
  $('modal-body').innerHTML =
    section('📊 Zoning Compliance Diagnosis', `
      <div class="details-item"><span>Status (${comp.zoneUsed})</span><div style="margin-top:4px;">${comp.badgeHTML}</div></div>
      <div class="details-item"><span>Regulatory Evaluation</span><ul style="padding-left:16px;font-size:13px;">${issues}</ul></div>`, true) +
    section('📐 All Spatial Vertices (EPSG:32632 / UTM Zone 32N)',
      vertexTable(v.parcel, 'Parcel Boundary Vertices') + vertexTable(v.building, 'Building Footprint Vertices'), true) +
    SECTIONS.map(([title, open, fields]) => section(title, fields.map(([l, k, u]) => detailItem(l, r[k], u)).join(''), open)).join('');
  $('detail-modal').style.display = 'flex';
}
function closeModal() { $('detail-modal').style.display = 'none'; }
on('detail-modal', 'click', (e) => { if (e.target === $('detail-modal')) closeModal(); });

// ---------- 10. Search & tabs ----------
const SEARCH_FIELDS = ['name', 'proprietaire_nom', 'numero_permis', 'titre_foncier', 'num_tit_foncier_mere', 'title_rec_no', 'arrondissement', 'nui', 'plot_no', 'cu_number'];
const matches = (r, q) => SEARCH_FIELDS.some(f => r[f] && String(r[f]).toLowerCase().includes(q));

function setTab(tracker) {
  $('permitSearchBox').style.display = tracker ? 'none' : 'block';
  $('trackerSearchBox').style.display = tracker ? 'block' : 'none';
  const paint = (el, active, bg) => { el.style.background = active ? bg : '#e2e8f0'; el.style.color = active ? '#fff' : '#333'; };
  paint($('togglePermitBtn'), !tracker, '#0f172a');
  paint($('toggleTrackerBtn'), tracker, '#2563eb');
}
on('togglePermitBtn', 'click', () => setTab(false));
on('toggleTrackerBtn', 'click', () => setTab(true));

on('search-input', 'input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  const filtered = q ? globalPermitData.filter(r => matches(r, q)) : globalPermitData;
  renderTableAndMap(filtered);
  if (q && filtered.length === 1) focusOnPermit(filtered[0].__key);
});

// ---------- 11. Live GPS navigation ----------
const navBoard = $('nav-board'), navChip =$('nav-chip'), nbq = (s) => navBoard.querySelector(s);
let routing = null, watchId = null, me = null, halo = null, stepMarker = null, route = null, routeCoords = null;
let following = true, offTrack = false, boardHidden = false, lastRouted = null, lastGeo = null, nav = {};

[navBoard, navChip].forEach(el => { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); });
if (innerWidth > 640) nbq('#nb-dir').open = true;

function setBoard(visible) { boardHidden = !visible; navBoard.style.display = visible && nav.title ? 'block' : 'none'; }
nbq('.nav-x').onclick = () => setBoard(false);
$('chip-show').onclick = () => setBoard(boardHidden);$('chip-stop').onclick = () => stopTracking();
map.on('dragstart', () => { following = false; renderLoc(); });   // user moved the map: stop auto-follow

// Board: current location line
function renderLoc() {
  nbq('#nb-loc').innerHTML = `<div class="place">📍 ${nav.place || (nav.lat ? 'Locating address…' : 'Locating your live position…')}</div>
    ${nav.lat ? `<div class="sub">${nav.lat.toFixed(6)}, ${nav.lng.toFixed(6)} \vert{} UTM${nav.utm} (±${nav.acc} m)${following ? '' : ' <a href="#" id="recenter">⌖ recenter</a>'}</div>` : ''}`;
  const rc = nbq('#recenter');
  if (rc) rc.onclick = (e) => { e.preventDefault(); following = true; me && map.panTo(me.getLatLng()); renderLoc(); };
}

// Board: distance / time summary
function renderSum() {
  const km = nav.dist >= 1000 ? (nav.dist / 1000).toFixed(1) + ' km' : Math.round(nav.dist || 0) + ' m';
  nbq('#nb-sum').innerHTML = `<div class="big">${nav.dist != null ? `${km} ·${Math.max(1, Math.round(nav.time / 60))} min` : 'Calculating route from your position…'}</div>
    <div class="sub">🎯 ${nav.title || ''}</div>
    ${nav.off ? '<div class="sub" style="color:#dc2626;font-weight:700">⚠️ Off route — recalculating…</div>' : ''}`;
}

// Board: turn-by-turn steps
const ICONS = { depart: 'A', arrive: '🎯', continue: '↑', 'bear-right': '↗️', 'turn-right': '↱', 'sharp-right': '↘️',
  'u-turn': '↩️', 'sharp-left': '↙️', 'turn-left': '↰', 'bear-left': '↖️', 'enter-roundabout': '⟳' };
function renderSteps(rt) {
  route = rt;
  try {
    const f = new L.Routing.Formatter();
    nbq('#nb-steps').innerHTML = rt.instructions.map((ins, i) => {
      let icon = '↑';
      try { icon = ICONS[f.getIconName(ins, i)] || '↑'; } catch (e) {}
      return `<div class="st" data-i="${i}"><em>${icon}</em><span>${f.formatInstruction(ins, i)}</span><b>${f.formatDistance(ins.distance)}</b></div>`;
    }).join('');
  } catch (e) { nbq('#nb-steps').innerHTML = ''; }
}

// Clicking a step shows where it happens on the map (click again to hide)
nbq('#nb-steps').addEventListener('click', (e) => {
  const row = e.target.closest('.st');
  if (!row || !route) return;
  const wasOn = row.classList.contains('on');
  navBoard.querySelectorAll('.st.on').forEach(x => x.classList.remove('on'));
  if (stepMarker) { trackingLayerGroup.removeLayer(stepMarker); stepMarker = null; }
  const c = !wasOn && route.coordinates[route.instructions[row.dataset.i].index];
  if (!c) return;
  row.classList.add('on');
  stepMarker = L.marker(c, { icon: L.divIcon({ className: '', html: '<div class="step-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 900 })
    .bindPopup(`<b>${row.querySelector('em').textContent} ${row.querySelector('span').textContent}</b><br>${row.querySelector('b').textContent}`);
  trackingLayerGroup.addLayer(stepMarker);
  following = false; renderLoc();
  map.setView(c, Math.max(map.getZoom(), 17));
  map.panBy([0, navBoard.offsetHeight / 2]);
  stepMarker.openPopup();
});

// Street address of the user (only re-asked after moving 100 m)
async function reverseGeocode(lat, lng) {
  if (lastGeo && L.latLng(lastGeo).distanceTo([lat, lng]) < 100) return;
  lastGeo = [lat, lng];
  try { (await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`)).json();
    nav.place = (j.display_name || '').split(',').slice(0, 3).join(', ');
    renderLoc();
  } catch (e) {}
}

// Shortest distance (m) from point p to the route polyline
function distToRoute(p, coords) {
  const k = Math.cos(p.lat * Math.PI / 180), M = 111320, xy = (c) => [(c.lng - p.lng) * k * M, (c.lat - p.lat) * M];
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const [ax, ay] = xy(coords[i - 1]), [bx, by] = xy(coords[i]), dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

function stopTracking() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = me = halo = lastRouted = lastGeo = stepMarker = route = routeCoords = null;
  trackingLayerGroup.clearLayers();
  if (routing) { try { map.removeControl(routing); } catch (e) {} routing = null; }
  nav = {}; boardHidden = offTrack = false;
  navBoard.style.display = navChip.style.display = 'none';
  $('track-stop-btn').style.display = 'none';
}

// First GPS fix: create the "you are here" marker and the route to the target
function startRoute(here, acc) {
  me = L.marker(here, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).bindPopup('');
  halo = L.circle(here, { radius: acc, color: '#2563eb', weight: 1, fillOpacity: .1 });
  trackingLayerGroup.addLayer(halo).addLayer(me);
  if (following) map.setView(here, 17);

  lastRouted = here;
  routing = L.Routing.control({
    waypoints: [here, nav.target],
    routeWhileDragging: false, addWaypoints: false, draggableWaypoints: false,
    lineOptions: { styles: [{ color: '#2563eb', weight: 6, opacity: .85 }] },
    createMarker: (i, wp) => i === 0 ? null : L.marker(wp.latLng)
  }).addTo(map);
  routing.on('routesfound', (e) => {
    const r = e.routes[0];
    Object.assign(nav, { dist: r.summary.totalDistance, time: r.summary.totalTime });
    routeCoords = r.coordinates;
    renderSum(); renderSteps(r);
  });
}

// Every later GPS fix: move marker, detect off-route, re-route after 15 m
function updatePosition(here, acc) {
  me.setLatLng(here);
  halo.setLatLng(here).setRadius(acc);
  if (following) map.panTo(here);
  if (routeCoords) {
    const off = distToRoute(here, routeCoords);
    if (off > 40 && !offTrack) { offTrack = nav.off = true; renderSum(); setBoard(true); }
    else if (off < 25 && offTrack) { offTrack = nav.off = false; renderSum(); }
  }
  if (lastRouted.distanceTo(here) > 15) { lastRouted = here; routing.spliceWaypoints(0, 1, here); }
}

function onPosition(pos) {
  try {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const here = L.latLng(lat, lng), acc = Math.round(accuracy || 0);
    Object.assign(nav, { lat, lng, acc, utm: fmtUTM(lng, lat) });
    me ? updatePosition(here, acc) : startRoute(here, acc);
    me.setPopupContent(`<b>📍 You are here</b><br>${lat.toFixed(6)}, ${lng.toFixed(6)}<br>UTM ${nav.utm}`);
    renderLoc();
    reverseGeocode(lat, lng);
  } catch (err) { console.error('Tracking watch error:', err); }
}

function onGpsError(err) {
  if (me) return console.warn('Watch position warning:', err.message);   // already tracking: just warn
  stopTracking();
  alert(err.code === 1
    ? 'Location permission denied. Please allow location access for this site in your browser settings.'
    : 'Could not get your GPS position. Make sure your device location / GPS is turned ON.');
}

function runTracker() {
  const query = $('track-search-input').value.trim().toLowerCase();
  if (!query) return alert('Please enter a permit or property number to navigate to!');
  stopTracking();
  following = true;

  const record = globalPermitData.find(r => matches(r, query));
  if (!record) return alert('No matching permit or house found!');
  if (!navigator.geolocation) return alert('Geolocation is not supported by your browser');
  if (!window.isSecureContext) return alert('Live GPS only works on an HTTPS page. Open the https:// link of this site on your phone.');

  const g = layersMap[record.__key || String(record.permis_id || record.numero_permis)];
  if (!g) return alert('This record has no geometry to navigate to.');
  if (!geojsonGroup.hasLayer(g)) { geojsonGroup.addLayer(g); applyMode(); }

  nav = {
    title: `${record.numero_permis || ''} ${record.name ? '— ' + record.name : ''}`.trim() || 'Destination',
    target: g.bnds.getCenter()
  };
  nbq('#nb-steps').innerHTML = '';
  navChip.style.display = 'flex';
  $('track-stop-btn').style.display = 'inline-block';
  renderLoc(); renderSum(); setBoard(true);

  // One continuous GPS watch: the first fix starts the route, later fixes update it
  watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

on('track-search-input', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); runTracker(); } });
on('track-go-btn', 'click', runTracker);
on('track-stop-btn', 'click', stopTracking);

// ---------- 12. Start ----------
loadBuildingPermit();
  
