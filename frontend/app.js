// ================= MBANI WebGIS - app.js (refined) =================
const $ = (id) => document.getElementById(id);

// ---------- 1. Projections ----------
proj4.defs("EPSG:32632", "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs");
const toUTM = (lng, lat) => proj4("EPSG:4326", "EPSG:32632", [lng, lat]);
const toWGS = (x, y) => proj4("EPSG:32632", "EPSG:4326", [x, y]);
const isUTM = (x, y) => Math.abs(x) > 180 || Math.abs(y) > 90;

// ---------- 2. Zoning rules ----------
const ZONING_RULES = {
  1: { maxCES: 0.60, maxCOS: 2.0, maxFloors: 4, maxHeightM: 12.0 },
  2: { maxCES: 0.70, maxCOS: 2.5, maxFloors: 5, maxHeightM: 15.0 },
  3: { maxCES: 0.50, maxCOS: 1.5, maxFloors: 3, maxHeightM: 9.0 },
  4: { maxCES: 0.60, maxCOS: 2.0, maxFloors: 4, maxHeightM: 12.0 },
  5: { maxCES: 0.55, maxCOS: 1.8, maxFloors: 3, maxHeightM: 10.0 },
  6: { maxCES: 0.50, maxCOS: 1.5, maxFloors: 3, maxHeightM: 9.0 },
  7: { maxCES: 0.45, maxCOS: 1.2, maxFloors: 2, maxHeightM: 7.5 },
  Default: { maxCES: 0.60, maxCOS: 2.0, maxFloors: 4, maxHeightM: 12.0 }
};

function checkZoningCompliance(r) {
  const n = String(r.parcel_arrondissement || r.quartier || '').match(/[1-7]/);
  const key = n ? n[0] : 'Default';
  const zone = n ? `Yaoundé ${key}` : 'Default';
  const rules = ZONING_RULES[key];
  const area = parseFloat(r.cadastral_area || 0);
  const built = parseFloat(r.area_sq_m || 0);
  const floors = parseInt(r.floors_above_ground || r.floors_above || 1, 10);
  const height = parseFloat(r.height_m || 0);
  const ces = area > 0 && built > 0 ? built / area : parseFloat(r.ces || 0);
  const cos = area > 0 && built > 0 ? (built * floors) / area : parseFloat(r.cos || 0);

  const issues = [];
  if (height > rules.maxHeightM) issues.push(`Height ${height}m exceeds max ${rules.maxHeightM}m`);
  if (floors > rules.maxFloors) issues.push(`${floors} floors exceed max ${rules.maxFloors}`);
  if (ces > rules.maxCES) issues.push(`CES ${(ces * 100).toFixed(1)}% exceeds max ${rules.maxCES * 100}%`);
  if (cos > rules.maxCOS) issues.push(`COS ${cos.toFixed(2)} exceeds max ${rules.maxCOS}`);

  const ok = !issues.length;
  return {
    isCompliant: ok, zoneUsed: zone, issuesList: issues,
    badgeHTML: `<span style="background:${ok ? '#2ecc71' : '#e74c3c'};color:#fff;padding:3px 8px;border-radius:4px;font-weight:bold;font-size:11px;white-space:nowrap;">${ok ? 'Compliant' : 'Non-Compliant'} (${zone})</span>`
  };
}

function displayZoneInfo(zone) {
  const r = ZONING_RULES[String(zone).replace(/\D/g, '')] || ZONING_RULES.Default;
  const el = $('zone-info-display');
  if (el) el.innerHTML = `Max Height: <strong>${r.maxHeightM}m</strong> | Max Floors: <strong>${r.maxFloors}</strong> | Max CES: <strong>${r.maxCES * 100}%</strong> | Max COS: <strong>${r.maxCOS}</strong>`;
}

// ---------- 3. Geometry helpers ----------
function parseGeom(g) {
  if (typeof g === 'string') { try { return JSON.parse(g); } catch (e) { return null; } }
  return g || null;
}

function reproject(c) {
  if (typeof c[0] === 'number') return isUTM(c[0], c[1]) ? toWGS(c[0], c[1]) : c;
  return c.map(reproject);
}

function toWGS84Geom(raw) {
  const g = parseGeom(raw);
  if (!g) return null;
  try {
    const copy = JSON.parse(JSON.stringify(g));
    if (copy.geometries) copy.geometries.forEach(x => { if (x.coordinates) x.coordinates = reproject(x.coordinates); });
    else if (copy.geometry) copy.geometry.coordinates = reproject(copy.geometry.coordinates);
    else if (copy.coordinates) copy.coordinates = reproject(copy.coordinates);
    return copy;
  } catch (e) { return g; }
}

function firstRing(g) {
  if (!g) return [];
  let c = g.geometries ? g.geometries[0]?.coordinates : g.geometry ? g.geometry.coordinates : g.coordinates;
  if (!c) return [];
  while (Array.isArray(c[0]) && Array.isArray(c[0][0])) c = c[0];
  return c;
}

// Ring points as WGS84 [lng, lat]
function ringWGS(raw) {
  return firstRing(parseGeom(raw))
    .filter(p => typeof p[0] === 'number' && typeof p[1] === 'number')
    .map(p => isUTM(p[0], p[1]) ? toWGS(p[0], p[1]) : p);
}

function centroidUTM(raw) {
  const pts = ringWGS(raw);
  if (!pts.length) return { x: 'N/A', y: 'N/A' };
  const [lng, lat] = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  const u = toUTM(lng, lat);
  return { x: u[0].toFixed(2), y: u[1].toFixed(2) };
}

function vertices(record) {
  const pts = (raw) => ringWGS(raw).map((p, i) => {
    const u = toUTM(p[0], p[1]);
    return { index: i + 1, x: u[0].toFixed(2), y: u[1].toFixed(2) };
  });
  const out = { parcel: record.parcel_geom ? pts(record.parcel_geom) : [], building: record.building_geom ? pts(record.building_geom) : [] };
  if (!out.parcel.length && !out.building.length && record.view_combined_geom) out.parcel = pts(record.view_combined_geom);
  return out;
}

// ---------- 4. Map ----------
const map = L.map('map', { zoomControl: true, fadeAnimation: true }).setView([3.848, 11.502], 12);
const gTile = (lyr) => L.tileLayer(`https://mt1.google.com/vt/lyrs=${lyr}&x={x}&y={y}&z={z}`, { maxZoom: 20, attribution: 'Map data © Google' });
const googleSatellite = gTile('s').addTo(map);
// OpenStreetMap: OSM's own servers send a "403 Access blocked" picture to pages opened from a file (file://),
// so in that case use OpenStreetMap France (same OSM data). On the website / localhost the official tiles are used.
const osmLayer = location.protocol === 'file:'
  ? L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', {
      maxZoom: 19, subdomains: 'abc', attribution: '&copy; OpenStreetMap contributors, tiles by OSM France' })
  : L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });

// Street map that works from anywhere, no key needed
const esriStreets = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19, attribution: 'Tiles &copy; Esri' });

L.control.layers({
  "Google Satellite": googleSatellite,
  "Google Satellite Hybrid": gTile('y'),
  "OpenStreetMap": osmLayer,
  "Streets (Esri)": esriStreets
}).addTo(map);

const geojsonGroup = L.featureGroup().addTo(map);
const trackingLayerGroup = L.layerGroup().addTo(map);
const layersMap = {};
let globalPermitData = [];
let activePermitKey = null;
let showingAll = false;
let sortCol = null, asc = true;

function updateCoordBanner(latlng) {
  const u = toUTM(latlng.lng, latlng.lat);
  const el = $('coord-display');
  if (el) el.innerText = `UTM Zone 32N (EPSG:32632) | X: ${u[0].toFixed(2)} m E | Y: ${u[1].toFixed(2)} m N`;
}
map.on('mousemove click', (e) => updateCoordBanner(e.latlng));
// ---------- 5. Data loading ----------
function setDataStatus(msg, type = '') {
  const el = $('data-status');
  if (!el) return;
  el.className = msg ? 'data-status show ' + type : 'data-status';
  el.textContent = msg || '';
}

function backendUrl(source) {
  const h = window.location.hostname;
  const local = h === 'localhost' || h === '127.0.0.1' || window.location.protocol === 'file:';
  const lan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  const base = local ? 'http://localhost:5000' : lan ? `http://${h}:5000` : 'https://mbani.onrender.com';
  return `${base}/api/${source === 'cloud' ? 'cloud-building-permit' : 'building-permit'}`;
}

async function loadBuildingPermit(source = 'local', allowFallback = true) {
  const body = $('permit-table-body');
  const label = source === 'cloud' ? 'Supabase cloud' : 'local';
  if (body) body.innerHTML = `<tr><td colspan="7" style="text-align:center;">Loading records from ${label} database...</td></tr>`;
  setDataStatus(`⏳ Loading from ${label} database…`);
  if ($('data-source-select')) $('data-source-select').value = source;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 70000); // Render free tier can be slow to wake
  try {
    const res = await fetch(backendUrl(source), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    globalPermitData = await res.json();
    try { localStorage.setItem('mbani_source', source); } catch (e) {}
    renderTableAndMap(globalPermitData);
    setDataStatus(`✅ ${globalPermitData.length} record(s) loaded from ${label}.`, 'ok');
    setTimeout(() => setDataStatus(''), 4000);
  } catch (err) {
    console.error(`Error fetching ${label} data:`, err);
    if (allowFallback) {
      setDataStatus(`⚠️ ${label} unreachable. Trying ${source === 'cloud' ? 'local' : 'cloud'}…`, 'error');
      return loadBuildingPermit(source === 'cloud' ? 'local' : 'cloud', false);
    }
    if (body) body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:red;">Failed to load data from server.</td></tr>`;
    setDataStatus('❌ Could not load data from servers.', 'error');
  } finally {
    clearTimeout(timer);
  }
}

$('data-source-select')?.addEventListener('change', (e) => loadBuildingPermit(e.target.value, false));

// ---------- 6. Table & map rendering ----------
function sortTableBy(col) {
  asc = sortCol === col ? !asc : true;
  sortCol = col;
  globalPermitData.sort((a, b) => {
    let x = (a[col] || '').toString().toLowerCase(), y = (b[col] || '').toString().toLowerCase();
    if (x !== '' && y !== '' && !isNaN(x) && !isNaN(y)) { x = parseFloat(x); y = parseFloat(y); }
    return x < y ? (asc ? -1 : 1) : x > y ? (asc ? 1 : -1) : 0;
  });
  renderTableAndMap(globalPermitData);
}

function updateShowAllButton() {
  const btn = $('toggleAllGeomBtn');
  if (!btn) return;
  btn.classList.toggle('active', showingAll);
  btn.innerHTML = showingAll ? '❌ Clear All Features' : '🌐 Show All Parcels & Footprints';
}

function popupHTML(title, color, r, comp, rawGeom, idx) {
  const c = centroidUTM(rawGeom);
  return `<div style="font-size:13px;">
    <strong style="color:${color};font-size:14px;">${title}</strong><br>
    <strong>Permit:</strong> ${r.permit_number || 'N/A'}<br>
    <strong>Applicant:</strong> ${r.applicant_full_name || 'N/A'}<br>
    <strong>Zoning:</strong> ${comp.badgeHTML}<br>
    <strong>Center UTM X:</strong> ${c.x} m E<br><strong>Center UTM Y:</strong> ${c.y} m N<br><br>
    <a href="#" onclick="showDetails(${idx}); return false;">View Details</a></div>`;
}

function renderTableAndMap(data) {
  const body = $('permit-table-body');
  if (!body) return;
  body.innerHTML = '';
  geojsonGroup.clearLayers();
  Object.keys(layersMap).forEach(k => delete layersMap[k]);
  activePermitKey = null;
  showingAll = false;

  if (!data || !data.length) {
    body.innerHTML = '<tr><td colspan="7" style="text-align:center;">No records found.</td></tr>';
    return updateShowAllButton();
  }

  data.forEach((r, idx) => {
    const key = (r.permit_id || r.permit_number || idx).toString();
    const comp = checkZoningCompliance(r);
    const group = L.featureGroup();

    const layers = [
      [r.parcel_geom, 'Parcel', '#0284c7', { color: '#00d2ff', weight: 3, fillColor: '#00d2ff', fillOpacity: 0.25 }],
      [r.building_geom, 'Building Permit', 'red', { color: '#ffea00', weight: 2, fillColor: '#ffab00', fillOpacity: 0.65 }],
      [!r.parcel_geom && !r.building_geom && r.view_combined_geom, 'Parcel / Building', '#0284c7', { color: '#00d2ff', weight: 2, fillColor: '#00d2ff', fillOpacity: 0.3 }]
    ];
    layers.forEach(([raw, title, color, style]) => {
      const g = raw && toWGS84Geom(raw);
      if (g) L.geoJSON(g, { style }).bindPopup(popupHTML(title, color, r, comp, raw, idx)).addTo(group);
    });

    if (group.getLayers().length) {
      geojsonGroup.addLayer(group);
      layersMap[key] = group;
    }

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${r.permit_number || 'N/A'}</strong></td>
      <td>${r.applicant_full_name || 'N/A'}</td>
      <td>${r.applicant_email || 'N/A'}</td>
      <td>${r.applicant_phone_number || r.applicant_phone || 'N/A'}</td>
      <td>${r.parcel_arrondissement || 'N/A'}</td>
      <td><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start;"><span>${r.building_use || 'N/A'}</span>${comp.badgeHTML}</div></td>
      <td style="white-space:nowrap;">
        <button class="btn-details" onclick="event.stopPropagation(); togglePermitOnMap('${key}')">👁️ Show/Hide</button>
        <button class="btn-details" onclick="event.stopPropagation(); showDetails(${idx})">View All</button>
      </td>`;
    row.onclick = () => focusOnPermit(key);
    body.appendChild(row);
  });

  if (geojsonGroup.getLayers().length) {
    map.fitBounds(geojsonGroup.getBounds());
    showingAll = true;
  }
  updateShowAllButton();
  setTimeout(() => map.invalidateSize(), 200);
}

function focusOnPermit(key) {
  const g = layersMap[key];
  if (!g) return;
  if (!geojsonGroup.hasLayer(g)) geojsonGroup.addLayer(g);
  map.fitBounds(g.getBounds(), { padding: [50, 50], maxZoom: 19 });
  g.openPopup();
}

function showPermitOnMap(key) {
  const g = layersMap[key];
  if (!g) return false;
  geojsonGroup.clearLayers();
  geojsonGroup.addLayer(g);
  activePermitKey = key;
  showingAll = false;
  updateShowAllButton();
  map.fitBounds(g.getBounds(), { padding: [30, 30], maxZoom: 19, animate: true });
  g.openPopup();
  return true;
}

function clearMapFeatures() {
  geojsonGroup.clearLayers();
  activePermitKey = null;
  showingAll = false;
  updateShowAllButton();
}

function togglePermitOnMap(key) {
  if (!layersMap[key]) return;
  activePermitKey === key ? clearMapFeatures() : showPermitOnMap(key);
}

function toggleAllPermitsOnMap() {
  if (showingAll) return clearMapFeatures();
  geojsonGroup.clearLayers();
  activePermitKey = null;
  Object.values(layersMap).forEach(g => geojsonGroup.addLayer(g));
  if (!geojsonGroup.getLayers().length) return alert("No spatial geometries found.");
  map.fitBounds(geojsonGroup.getBounds(), { padding: [30, 30], animate: true });
  showingAll = true;
  updateShowAllButton();
}

// ---------- 7. Details modal ----------
function showDetails(index) {
  const r = globalPermitData[index];
  if (!r) return;
  const comp = checkZoningCompliance(r);
  const v = vertices(r);
  const na = (x) => (x === undefined || x === null || x === '' ? 'N/A' : x);
  const item = (label, val) => `<div class="details-item"><span>${label}</span>${na(val)}</div>`;

  const vertexTable = (pts, title) => !pts.length
    ? `<div class="details-item" style="grid-column:span 2;"><span>${title}</span>N/A</div>`
    : `<div class="details-item" style="grid-column:span 2;"><span>${title} (${pts.length} Vertices)</span>
        <div style="max-height:130px;overflow-y:auto;margin-top:6px;border:1px solid #e2e8f0;border-radius:4px;">
        <table style="width:100%;border-collapse:collapse;font-size:11px;text-align:left;">
          <thead style="background:#f1f5f9;position:sticky;top:0;"><tr><th style="padding:4px 8px;">Point</th><th style="padding:4px 8px;">UTM Easting (X)</th><th style="padding:4px 8px;">UTM Northing (Y)</th></tr></thead>
          <tbody>${pts.map(p => `<tr><td style="padding:3px 8px;">P${p.index}</td><td style="padding:3px 8px;">${p.x} m E</td><td style="padding:3px 8px;">${p.y} m N</td></tr>`).join('')}</tbody>
        </table></div></div>`;

  const issues = comp.issuesList.length
    ? comp.issuesList.map(i => `<li style="color:#c0392b;margin:4px 0;">⚠️ ${i}</li>`).join('')
    : `<li style="color:#16a34a;font-weight:bold;list-style:none;">✓ Passed all zoning rules for ${comp.zoneUsed}</li>`;

  if ($('modal-title')) $('modal-title').innerText = `Building Permit Details: ${r.permit_number || 'N/A'}`;
  if ($('modal-body')) $('modal-body').innerHTML = `
    <div class="details-section">Zoning Compliance Diagnosis</div>
    <div class="details-item"><span>Status (${comp.zoneUsed})</span><div style="margin-top:4px;">${comp.badgeHTML}</div></div>
    <div class="details-item"><span>Regulatory Evaluation</span><ul style="padding-left:16px;font-size:13px;margin-top:2px;">${issues}</ul></div>

    <div class="details-section">All Spatial Vertices (EPSG:32632 / UTM Zone 32N)</div>
    ${vertexTable(v.parcel, 'Parcel Boundary Vertices')}${vertexTable(v.building, 'Building Footprint Vertices')}

    <div class="details-section">Applicant Information</div>
    ${item('Full Name', r.applicant_full_name)}${item('NUI', r.applicant_nui)}
    ${item('Phone', r.applicant_phone_number || r.applicant_phone)}${item('Email', r.applicant_email)}
    <div class="details-item" style="grid-column:span 2;"><span>Address</span>${na(r.applicant_address)}</div>

    <div class="details-section">Permit & Parcel Details</div>
    ${item('Permit No', r.permit_number)}${item('Dossier No', r.no_du_dossier || r.title_rec_no)}
    ${item('Status', r.status || r.permit_status)}${item('Deposit Date', r.date_de_depot || r.input_database_date)}
    ${item('Land Title No', r.land_title_no || r.title_rec_no)}${item('Quarter', r.parcel_quarter || r.quartier)}
    ${item('Arrondissement', r.parcel_arrondissement)}${item('Cadastral Area', r.cadastral_area && r.cadastral_area + ' m²')}

    <div class="details-section">Building Permit</div>
    ${item('Building Use', r.building_use)}${item('Floors Above Ground', r.floors_above_ground)}
    ${item('Underground Floors', r.floors_underground)}${item('Height', r.height_m && r.height_m + ' m')}
    ${item('COS', r.cos)}${item('CES', r.ces)}
    ${item('Estimated Cost', r.estimated_cost)}${item('Parking Places', r.parking_place)}
    ${item('Building Area', r.area_sq_m && r.area_sq_m + ' m²')}`;

  if ($('detail-modal')) $('detail-modal').style.display = 'flex';
}

function closeModal() { if ($('detail-modal')) $('detail-modal').style.display = 'none'; }
$('detail-modal')?.addEventListener('click', (e) => { if (e.target === $('detail-modal')) closeModal(); });

// ---------- 8. Search bars & toggle ----------
const matches = (r, q) => ['applicant_full_name', 'permit_number', 'land_title_no', 'title_rec_no', 'parcel_arrondissement', 'applicant_nui']
  .some(f => r[f] && String(r[f]).toLowerCase().includes(q));

if ($('togglePermitBtn') && $('toggleTrackerBtn')) {
  const setTab = (tracker) => {
    $('permitSearchBox').style.display = tracker ? 'none' : 'block';
    $('trackerSearchBox').style.display = tracker ? 'block' : 'none';
    $('togglePermitBtn').style.cssText += tracker ? ';background:#e2e8f0;color:#333' : ';background:#0f172a;color:white';
    $('toggleTrackerBtn').style.cssText += tracker ? ';background:#2563eb;color:white' : ';background:#e2e8f0;color:#333';
  };
  $('togglePermitBtn').addEventListener('click', () => setTab(false));
  $('toggleTrackerBtn').addEventListener('click', () => setTab(true));
}

$('search-input')?.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  const filtered = q ? globalPermitData.filter(r => matches(r, q)) : globalPermitData;
  renderTableAndMap(filtered);
  if (q && filtered.length === 1) focusOnPermit((filtered[0].permit_id || filtered[0].permit_number || 0).toString());
});

// ---------- 9. Live GPS tracker & road routing (Yango style, one tracking board) ----------
document.head.insertAdjacentHTML('beforeend', `<style>
.me-dot{width:18px;height:18px;border-radius:50%;background:#2563eb;border:3px solid #fff;animation:mePulse 1.8s infinite}
@keyframes mePulse{0%{box-shadow:0 0 0 0 rgba(37,99,235,.6)}70%,100%{box-shadow:0 0 0 18px rgba(37,99,235,0)}}
.leaflet-routing-container{display:none!important}
#nav-board{position:absolute;left:50%;transform:translateX(-50%);bottom:18px;z-index:1000;width:min(94%,440px);max-height:55%;overflow-y:auto;box-sizing:border-box;background:#fff;border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,.35);padding:12px 40px 12px 14px;font:13px system-ui,sans-serif;display:none}
#nav-board .place{font-size:14px;font-weight:700;color:#0f172a}
#nav-board .big{font-size:20px;font-weight:700;color:#0f172a;margin-top:8px;padding-top:8px;border-top:1px solid #e2e8f0}
#nav-board .sub{color:#475569;margin-top:3px;word-break:break-word}
#nav-board summary{cursor:pointer;font-weight:700;margin-top:8px;color:#2563eb}
#nav-board .st{display:flex;align-items:center;gap:10px;padding:8px 6px;border-bottom:1px solid #f1f5f9;cursor:pointer;border-radius:6px}
#nav-board .st:hover,#nav-board .st.on{background:#eff6ff}
#nav-board .st em{font-style:normal;font-weight:700;font-size:20px;width:28px;text-align:center;color:#0f172a;flex:none}
#nav-board .st span{flex:1}
.step-dot{width:22px;height:22px;border-radius:50%;background:#f59e0b;border:3px solid #fff;box-shadow:0 0 0 0 rgba(245,158,11,.7);animation:stepPulse 1.4s infinite}
@keyframes stepPulse{0%{box-shadow:0 0 0 0 rgba(245,158,11,.7)}70%,100%{box-shadow:0 0 0 16px rgba(245,158,11,0)}}
#nav-board .st b{white-space:nowrap;color:#334155}
.nav-x{position:absolute;top:8px;right:10px;border:0;background:#e2e8f0;border-radius:50%;width:24px;height:24px;font-size:13px;line-height:24px;color:#334155;cursor:pointer;padding:0}
#nav-chip{position:absolute;top:88px;left:10px;z-index:1000;display:none;flex-direction:column;gap:6px}
#nav-chip button{width:34px;height:34px;border:0;border-radius:50%;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.35);font-size:16px;cursor:pointer;padding:0}
</style>`);

const trackSearchInput = $('track-search-input');
let currentRoutingControl = null, watchId = null, meMarker = null, meCircle = null;
let following = true, lastRouted = null, lastGeo = null, nav = {};
let boardHidden = false, offTrack = false, routeCoords = null, currentRoute = null, stepMarker = null;

// One board with everything: where you are, distance/time, destination, turn-by-turn
const navBoard = document.createElement('div');
navBoard.id = 'nav-board';
navBoard.innerHTML = `<button class="nav-x" title="Hide">✕</button>
  <div id="nb-loc"></div><div id="nb-sum"></div>
  <details id="nb-dir"><summary>Directions</summary><div id="nb-steps"></div></details>`;
map.getContainer().appendChild(navBoard);
L.DomEvent.disableClickPropagation(navBoard);
L.DomEvent.disableScrollPropagation(navBoard);
if (window.innerWidth > 640) navBoard.querySelector('#nb-dir').open = true;
const nb = (id) => navBoard.querySelector(id);

function setBoard(visible) {
  boardHidden = !visible;
  navBoard.style.display = visible && nav.title ? 'block' : 'none';
}
navBoard.querySelector('.nav-x').onclick = () => setBoard(false);
map.on('dragstart', () => { following = false; renderLoc(); });

// Small buttons while tracking: 🧭 show/hide board, ⏹ stop
const navChip = document.createElement('div');
navChip.id = 'nav-chip';
navChip.innerHTML = '<button id="chip-show" title="Show / hide tracking board">🧭</button><button id="chip-stop" title="Stop tracking">⏹</button>';
map.getContainer().appendChild(navChip);
L.DomEvent.disableClickPropagation(navChip);
navChip.querySelector('#chip-show').onclick = () => setBoard(boardHidden);
navChip.querySelector('#chip-stop').onclick = () => stopTracking();

function renderLoc() {
  nb('#nb-loc').innerHTML = `<div class="place">📍 ${nav.place || (nav.lat ? 'Locating address…' : 'Locating you…')}</div>
    ${nav.lat ? `<div class="sub">${nav.lat.toFixed(6)}, ${nav.lng.toFixed(6)} | UTM ${nav.utm} (±${nav.acc} m)
      ${following ? '' : ' <a href="#" id="recenter">⌖ recenter</a>'}</div>` : ''}`;
  const rc = nb('#recenter');
  if (rc) rc.onclick = (e) => { e.preventDefault(); following = true; if (meMarker) map.panTo(meMarker.getLatLng()); renderLoc(); };
}

function renderSum() {
  const km = nav.dist >= 1000 ? (nav.dist / 1000).toFixed(1) + ' km' : Math.round(nav.dist || 0) + ' m';
  nb('#nb-sum').innerHTML = `<div class="big">${nav.dist != null ? `${km} · ${Math.max(1, Math.round(nav.time / 60))} min` : 'Calculating route…'}</div>
    <div class="sub">🎯 ${nav.title || ''}</div>
    ${nav.off ? '<div class="sub" style="color:#dc2626;font-weight:700">⚠️ Off route — recalculating…</div>' : ''}`;
}

const STEP_ICONS = { 'depart': 'A', 'arrive': '🎯', 'continue': '↑', 'bear-right': '↗', 'turn-right': '↱', 'sharp-right': '↘',
  'u-turn': '↩', 'sharp-left': '↙', 'turn-left': '↰', 'bear-left': '↖', 'enter-roundabout': '⟳' };

function renderSteps(route) {
  currentRoute = route;
  try {
    const f = new L.Routing.Formatter();
    nb('#nb-steps').innerHTML = route.instructions.map((ins, i) => {
      let icon = '↑';
      try { icon = STEP_ICONS[f.getIconName(ins, i)] || '↑'; } catch (e) {}
      return `<div class="st" data-i="${i}"><em>${icon}</em><span>${f.formatInstruction(ins, i)}</span><b>${f.formatDistance(ins.distance)}</b></div>`;
    }).join('');
  } catch (e) { nb('#nb-steps').innerHTML = ''; }
}

// Tap a direction -> orange marker on the route line at that turn; tap again to remove it
nb('#nb-steps').addEventListener('click', (e) => {
  const row = e.target.closest('.st');
  if (!row || !currentRoute) return;
  const wasOn = row.classList.contains('on');
  navBoard.querySelectorAll('.st.on').forEach(x => x.classList.remove('on'));
  if (stepMarker) { trackingLayerGroup.removeLayer(stepMarker); stepMarker = null; }
  if (wasOn) return;

  const c = currentRoute.coordinates[currentRoute.instructions[row.dataset.i].index];
  if (!c) return;
  row.classList.add('on');
  stepMarker = L.marker(c, { icon: L.divIcon({ className: '', html: '<div class="step-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 900 })
    .bindPopup(`<b>${row.querySelector('em').textContent} ${row.querySelector('span').textContent}</b><br>${row.querySelector('b').textContent}`);
  trackingLayerGroup.addLayer(stepMarker);
  following = false; renderLoc();
  map.setView(c, Math.max(map.getZoom(), 17));
  map.panBy([0, navBoard.offsetHeight / 2]); // keep the point visible above the board
  stepMarker.openPopup();
});

async function reverseGeocode(lat, lng) {
  if (lastGeo && L.latLng(lastGeo).distanceTo([lat, lng]) < 100) return;
  lastGeo = [lat, lng];
  try {
    const j = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`)).json();
    nav.place = (j.display_name || '').split(',').slice(0, 3).join(', ');
    renderLoc();
  } catch (e) {}
}

// Shortest distance (m) from a point to the route line
function distToRoute(p, coords) {
  const k = Math.cos(p.lat * Math.PI / 180), M = 111320;
  const xy = (c) => [(c.lng - p.lng) * k * M, (c.lat - p.lat) * M];
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const [ax, ay] = xy(coords[i - 1]), [bx, by] = xy(coords[i]);
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

function stopTracking() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = meMarker = meCircle = lastRouted = lastGeo = stepMarker = currentRoute = null;
  trackingLayerGroup.clearLayers();
  if (currentRoutingControl) { try { map.removeControl(currentRoutingControl); } catch (e) {} currentRoutingControl = null; }
  nav = {};
  boardHidden = offTrack = false;
  routeCoords = null;
  navBoard.style.display = navChip.style.display = 'none';
  if ($('track-stop-btn')) $('track-stop-btn').style.display = 'none';
}

function runTracker() {
  const query = (trackSearchInput?.value || '').trim().toLowerCase();
  if (!query) return;
  stopTracking();
  following = true;

  const record = globalPermitData.find(r => matches(r, query));
  if (!record) return alert("No matching permit or house found!");
  if (!navigator.geolocation) return alert("Geolocation is not supported by your browser");

  const layerGroup = layersMap[(record.permit_id || record.permit_number).toString()];
  if (!layerGroup) return alert("This record has no geometry to navigate to.");
  if (!geojsonGroup.hasLayer(layerGroup)) geojsonGroup.addLayer(layerGroup);
  const target = layerGroup.getBounds().getCenter(); // parcel/house centre

  nav = { title: `${record.permit_number || ''} ${record.applicant_full_name ? '— ' + record.applicant_full_name : ''}`.trim() || 'Destination' };
  nb('#nb-steps').innerHTML = '';
  navChip.style.display = 'flex';
  if ($('track-stop-btn')) $('track-stop-btn').style.display = 'inline-block';
  renderLoc(); renderSum(); setBoard(true);

  // Every GPS fix: move the blue dot, update address/coordinates, and re-route as you walk
  const onFix = (pos) => {
    if (!nav.title) return; // tracking was stopped
    const { latitude: lat, longitude: lng } = pos.coords;
    const acc = Math.round(pos.coords.accuracy || 0);
    const here = L.latLng(lat, lng);
    const u = toUTM(lng, lat);
    Object.assign(nav, { lat, lng, acc, utm: `${u[0].toFixed(1)} E, ${u[1].toFixed(1)} N` });

    if (!meMarker) {
      meMarker = L.marker(here, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).bindPopup('');
      meCircle = L.circle(here, { radius: acc, color: '#2563eb', weight: 1, fillOpacity: 0.1 });
      trackingLayerGroup.addLayer(meCircle).addLayer(meMarker);
    }
    meMarker.setLatLng(here).setPopupContent(`<b>📍 You are here</b><br>${lat.toFixed(6)}, ${lng.toFixed(6)}<br>UTM ${nav.utm}`);
    meCircle.setLatLng(here).setRadius(acc);

    // Off-track check: far from the route line -> board opens by itself
    if (routeCoords) {
      const off = distToRoute(here, routeCoords);
      if (off > 40 && !offTrack) { offTrack = true; nav.off = true; renderSum(); setBoard(true); }
      else if (off < 25 && offTrack) { offTrack = false; nav.off = false; renderSum(); }
    }

    if (!currentRoutingControl) {
      lastRouted = here;
      currentRoutingControl = L.Routing.control({
        waypoints: [here, L.latLng(target.lat, target.lng)],
        routeWhileDragging: false,
        addWaypoints: false,
        draggableWaypoints: false,
        lineOptions: { styles: [{ color: '#2563eb', weight: 6, opacity: 0.85 }] },
        createMarker: (i, wp) => i === 0 ? null : L.marker(wp.latLng)
      }).addTo(map);
      currentRoutingControl.on('routesfound', (e) => {
        const r = e.routes[0];
        nav.dist = r.summary.totalDistance; nav.time = r.summary.totalTime;
        routeCoords = r.coordinates;
        renderSum(); renderSteps(r);
      });
    } else if (lastRouted.distanceTo(here) > 15) {
      lastRouted = here;
      currentRoutingControl.spliceWaypoints(0, 1, here); // route restarts from your new position
      if (following) map.panTo(here);
    }
    renderLoc();
    reverseGeocode(lat, lng);
  };

  const onFail = (err) => {
    if (err.code === 1) { stopTracking(); alert("Location permission denied. Allow location for this site in your phone/browser settings."); }
    else { nav.place = '⚠️ Weak GPS signal, still trying… (turn ON phone location)'; renderLoc(); }
  };

  // Old working call for a fast first fix + continuous watch so it moves as you walk
  navigator.geolocation.getCurrentPosition(onFix, () => {}, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  watchId = navigator.geolocation.watchPosition(onFix, onFail, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
}

trackSearchInput?.addEventListener('keypress', (e) => { if (e.key === 'Enter') runTracker(); });
$('track-go-btn')?.addEventListener('click', runTracker);
$('track-stop-btn')?.addEventListener('click', stopTracking);

// ---------- 10. Initial load ----------
(function () {
  let source = 'local';
  try {
    const p = new URLSearchParams(location.search).get('source') || localStorage.getItem('mbani_source');
    if (p === 'cloud' || p === 'local') source = p;
  } catch (e) {}
  loadBuildingPermit(source);
})();
