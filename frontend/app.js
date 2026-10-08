// ================= MBANI WebGIS - app.js (compact) =================
const $ = (id) => document.getElementById(id);
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };

// Show any script error on screen (phones have no console)
window.addEventListener('error', (e) => { const el = document.getElementById('data-status'); if (el) { el.className = 'data-status show error'; el.textContent = '⚠️ ' + e.message; } });

// ---------- 1. Projections ----------
proj4.defs("EPSG:32632", "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs");
const toUTM = (lng, lat) => proj4("EPSG:4326", "EPSG:32632", [lng, lat]);
const toWGS = (x, y) => proj4("EPSG:32632", "EPSG:4326", [x, y]);
const isUTM = (x, y) => Math.abs(x) > 180 || Math.abs(y) > 90;

// ---------- 2. Zoning (CES, COS, floors, height) ----------
const ZONING = { 1: [.6, 2, 4, 12], 2: [.7, 2.5, 5, 15], 3: [.5, 1.5, 3, 9], 4: [.6, 2, 4, 12],
                 5: [.55, 1.8, 3, 10], 6: [.5, 1.5, 3, 9], 7: [.45, 1.2, 2, 7.5], D: [.6, 2, 4, 12] };
const zoneRules = (k) => { const [maxCES, maxCOS, maxFloors, maxHeightM] = ZONING[k] || ZONING.D; return { maxCES, maxCOS, maxFloors, maxHeightM }; };

function checkZoningCompliance(r) {
  const n = String(r.parcel_arrondissement || r.quartier || '').match(/[1-7]/);
  const zone = n ? `Yaoundé ${n[0]}` : 'Default', rules = zoneRules(n && n[0]);
  const area = parseFloat(r.cadastral_area || r.parcel_area_sq_m || 0), built = parseFloat(r.building_area_sq_m || r.area_sq_m || 0);
  // floors_above_ground is text in the DB (e.g. "2", "G+2", "R+1"): read the number, and count the ground floor for G+n / R+n
  const flRaw = String(r.floors_above_ground || r.floors_above || '1');
  const floors = parseInt((flRaw.match(/\d+/) || ['1'])[0], 10) + (/^\s*(g|r|rdc)\s*\+/i.test(flRaw) ? 1 : 0), height = parseFloat(r.height_m || 0);
  const ces = area > 0 && built > 0 ? built / area : parseFloat(r.ces || 0);
  const cos = area > 0 && built > 0 ? built * floors / area : parseFloat(r.cos || 0);
  const issues = [];
  if (height > rules.maxHeightM) issues.push(`Height ${height}m exceeds max ${rules.maxHeightM}m`);
  if (floors > rules.maxFloors) issues.push(`${floors} floors exceed max ${rules.maxFloors}`);
  if (ces > rules.maxCES) issues.push(`CES ${(ces * 100).toFixed(1)}% exceeds max ${rules.maxCES * 100}%`);
  if (cos > rules.maxCOS) issues.push(`COS ${cos.toFixed(2)} exceeds max ${rules.maxCOS}`);
  const ok = !issues.length;
  return { isCompliant: ok, zoneUsed: zone, issuesList: issues,
    badgeHTML: `<span style="background:${ok ? '#2ecc71' : '#e74c3c'};color:#fff;padding:3px 8px;border-radius:4px;font-weight:bold;font-size:11px;white-space:nowrap;">${ok ? 'Compliant' : 'Non-Compliant'} (${zone})</span>` };
}

function displayZoneInfo(zone) {
  const r = zoneRules(String(zone).replace(/\D/g, ''));
  if ($('zone-info-display')) $('zone-info-display').innerHTML =
    `Max Height: <strong>${r.maxHeightM}m</strong> | Max Floors: <strong>${r.maxFloors}</strong> | Max CES: <strong>${r.maxCES * 100}%</strong> | Max COS: <strong>${r.maxCOS}</strong>`;
}

// ---------- 3. Geometry helpers (auto-detect UTM vs WGS84) ----------
function parseGeom(g) {
  if (typeof g === 'string') { try { return JSON.parse(g); } catch (e) { return null; } }
  return g || null;
}
const reproj = (c) => typeof c[0] === 'number' ? (isUTM(c[0], c[1]) ? toWGS(c[0], c[1]) : c) : c.map(reproj);

function toWGS84Geom(raw) {
  const g = parseGeom(raw);
  if (!g) return null;
  try {
    const c = JSON.parse(JSON.stringify(g));
    (c.geometries || [c.geometry || c]).forEach(x => { if (x && x.coordinates) x.coordinates = reproj(x.coordinates); });
    return c;
  } catch (e) { return g; }
}

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
  const u = toUTM(pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length);
  return { x: u[0].toFixed(4), y: u[1].toFixed(4) };
}

const combinedGeom = (r) => r.parcel_and_building_geom || r.view_combined_geom;   // server column name

function vertices(r) {
  const pts = (raw) => raw ? ringWGS(raw).map((p, i) => { const u = toUTM(p[0], p[1]); return { index: i + 1, x: u[0].toFixed(4), y: u[1].toFixed(4) }; }) : [];
  const out = { parcel: pts(r.parcel_geom), building: pts(r.building_geom) };
  if (!out.parcel.length && !out.building.length) out.parcel = pts(combinedGeom(r));
  return out;
}

// ---------- 4. Map ----------
const map = L.map('map', { zoomControl: true, fadeAnimation: true }).setView([3.848, 11.502], 12);
const gTile = (lyr) => L.tileLayer(`https://mt1.google.com/vt/lyrs=${lyr}&x={x}&y={y}&z={z}`, { maxZoom: 20, attribution: 'Map data © Google' });
const googleSatellite = gTile('s').addTo(map);
// OSM blocks pages opened from file://, so use OSM France there; official tiles on the website / localhost
const osmLayer = location.protocol === 'file:'
  ? L.tileLayer('https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc', attribution: '&copy; OpenStreetMap contributors, OSM France' })
  : L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
L.control.layers({
  "Google Satellite": googleSatellite,
  "Google Satellite Hybrid": gTile('y'),
  "OpenStreetMap": osmLayer,
  "Streets (Esri)": L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Tiles &copy; Esri' })
}).addTo(map);

const geojsonGroup = L.featureGroup().addTo(map);
const trackingLayerGroup = L.layerGroup().addTo(map);
// Panes: all parcels below, all buildings on top -> every building stays clickable even when many permits share one land
map.createPane('parcelPane').style.zIndex = 410;
map.createPane('buildingPane').style.zIndex = 420;
const PANE = { parcel: 'parcelPane', building: 'buildingPane' };
const layersMap = {};
const landMap = {};              // land (parcel) id -> keys of ALL permits on that land            // key -> featureGroup (has .kinds {parcel[], building[]} and .bnds)
let globalPermitData = [], activeKey = null, showingAll = false, layerMode = 'all', sortCol = null, asc = true;
const STYLE = { parcel: { color: '#00d2ff', weight: 3, fillColor: '#00d2ff', fillOpacity: .25 },
                building: { color: '#ffea00', weight: 2, fillColor: '#ffab00', fillOpacity: .65 } };

map.on('mousemove click', (e) => {
  const u = toUTM(e.latlng.lng, e.latlng.lat);
  if ($('coord-display')) $('coord-display').innerText = `UTM Zone 32N (EPSG:32632) | X: ${u[0].toFixed(5)} m E | Y: ${u[1].toFixed(5)} m N`;
});

// ---------- 5. Data loading (server syncs local DB + Supabase cloud) ----------
function setDataStatus(msg, type = '') {
  const el = $('data-status');
  if (el) { el.className = msg ? 'data-status show ' + type : 'data-status'; el.textContent = msg || ''; }
}

function backendUrl() {
  const h = location.hostname;
  const local = h === 'localhost' || h === '127.0.0.1' || location.protocol === 'file:';
  const lan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  const base = local ? 'http://localhost:5000' : lan ? `http://${h}:5000` : 'https://mbani.onrender.com';
  return `${base}/api/building-permit`;
}

/** The server (/api/building-permit) reads the local database and automatically falls back to the Supabase cloud,
 *  so one call is enough: on the deployed site (Render) you always get the cloud data, on your PC the local data. */
async function loadBuildingPermit() {
  $('permit-table-body').innerHTML = `<tr><td colspan="7" style="text-align:center;">Loading building permit data...</td></tr>`;
  setDataStatus('⏳ Loading records… (the Render server may take up to a minute to wake up)');
  const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 70000);
  try {
    const res = await fetch(backendUrl(), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    globalPermitData = await res.json();
    renderTableAndMap(globalPermitData);
    setDataStatus(`✅ ${globalPermitData.length} record(s) loaded.`, 'ok');
    setTimeout(() => setDataStatus(''), 4000);
  } catch (err) {
    console.error('Error fetching data:', err);
    $('permit-table-body').innerHTML = `<tr><td colspan="7" style="text-align:center;color:red;">Failed to load data from the server.</td></tr>`;
    setDataStatus('❌ Could not reach the server (' + err.message + '). If it is the Render server, wait a minute and refresh.', 'error');
  } finally { clearTimeout(timer); }
}

// ---------- 6. Table & map rendering ----------
function sortTableBy(col) {
  asc = sortCol === col ? !asc : true;
  sortCol = col;
  document.querySelectorAll('th[data-k]').forEach(th => {      // ▲ ascending / ▼ descending beside the active title, ↕ on the others
    const on = th.dataset.k === col, si = th.querySelector('.si');
    th.classList.toggle('sorted', on);
    if (si) si.textContent = on ? (asc ? '▲' : '▼') : '↕';
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

// bounds of what is currently visible for a permit (only buildings / only parcels / both)
const visBounds = (g) => layerMode === 'all' ? g.bnds : g.kb[layerMode];
const boundsOf = (keys) => keys.reduce((b, k) => { const v = layersMap[k] && visBounds(layersMap[k]); return v && v.isValid() ? b.extend(v) : b; }, L.latLngBounds([]));
const fit = (b, o) => b && b.isValid() && map.fitBounds(b, o);
// open the BUILDING popup first (red "Building Permit" header); fall back to the parcel popup
const openPopup = (g) => {
  const kind = layerMode !== 'parcel' && g.kinds.building.length ? 'building' : 'parcel';
  const l = g.kinds[kind][0] || g.kinds.parcel[0];
  if (l) l.openPopup(l.getBounds().getCenter());
};

/** Apply the Parcels / Buildings / All display filter to every permit */
function applyMode() {
  Object.values(layersMap).forEach(g => ['parcel', 'building'].forEach(k =>
    g.kinds[k].forEach(l => (layerMode === 'all' || layerMode === k) ? g.addLayer(l) : g.removeLayer(l))));
}

function display(keys) {            // put the given permits (or all) on the map
  geojsonGroup.clearLayers();
  (keys || Object.keys(layersMap)).forEach(k => layersMap[k] && geojsonGroup.addLayer(layersMap[k]));
  applyMode();
}

function showAll() {
  display();
  activeKey = null;
  showingAll = geojsonGroup.getLayers().length > 0;
  updateShowAllButton();
  fit(boundsOf(Object.keys(layersMap)), { padding: [30, 30], animate: true });
  return showingAll;
}

function clearMap() { geojsonGroup.clearLayers(); activeKey = null; showingAll = false; updateShowAllButton(); }

const siblings = (key) => { const g = layersMap[key]; return (g && g.land && landMap[g.land]) || [key]; };

function showPermitOnMap(key) {
  const g = layersMap[key];
  if (!g) return false;
  display(siblings(key));                          // the land + every building permit on it
  activeKey = key; showingAll = false; updateShowAllButton();
  fit(boundsOf(siblings(key)), { padding: [30, 30], maxZoom: 19, animate: true });
  openPopup(g);
  return true;
}

function focusOnPermit(key) {
  const g = layersMap[key];
  if (!g) return;
  if (!geojsonGroup.hasLayer(g)) { geojsonGroup.addLayer(g); applyMode(); }
  fit(visBounds(g), { padding: [50, 50], maxZoom: 19 });
  openPopup(g);
}

const togglePermitOnMap = (key) => layersMap[key] && (activeKey === key ? clearMap() : showPermitOnMap(key));
function toggleAllPermitsOnMap() {
  if (showingAll) return clearMap();
  if (!showAll()) alert("No spatial geometries found.");
}

// Small box: All / Parcels only / Buildings only
function setMode(m) {
  layerMode = m;
  document.querySelectorAll('#layer-mode button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  if (!geojsonGroup.getLayers().length) return showAll();
  applyMode();
  fit(boundsOf(activeKey ? siblings(activeKey) : Object.keys(layersMap)), { padding: [30, 30], maxZoom: 19, animate: true });  // zoom to what is now visible
}
document.querySelectorAll('#layer-mode button').forEach(b => b.onclick = () => setMode(b.dataset.mode));

function popupHTML(title, color, r, comp, raw, idx) {
  const c = centroidUTM(raw);
  return `<div style="font-size:13px;"><strong style="color:${color};font-size:14px;">${title}</strong><br>
    <strong>Permit:</strong> ${r.permit_number || 'N/A'}<br><strong>Applicant:</strong> ${r.applicant_full_name || 'N/A'}<br>
    <strong>Zoning:</strong> ${comp.badgeHTML}<br><strong>Center UTM X:</strong> ${c.x} m E<br><strong>Center UTM Y:</strong> ${c.y} m N<br><br>
    <a href="#" onclick="showDetails(${idx}); return false;">View Details</a></div>`;
}

function renderTableAndMap(data) {
  const body = $('permit-table-body');
  body.innerHTML = '';
  geojsonGroup.clearLayers();
  Object.keys(layersMap).forEach(k => delete layersMap[k]);
  Object.keys(landMap).forEach(k => delete landMap[k]);
  activeKey = null; showingAll = false;

  if (!data || !data.length) {
    body.innerHTML = '<tr><td colspan="7" style="text-align:center;">No records found.</td></tr>';
    return updateShowAllButton();
  }

  data.forEach((r, idx) => {
    let key = (r.permit_id || r.permit_number || idx).toString();
    if (layersMap[key]) key += '#' + idx;            // two permits with the same id must not overwrite each other
    r.__key = key;
    const comp = checkZoningCompliance(r);
    const g = L.featureGroup();
    g.kinds = { parcel: [], building: [] };
    [[r.parcel_geom, 'parcel', 'Parcel', '#0284c7'],
     [r.building_geom, 'building', 'Building Permit', 'red'],
     [!r.parcel_geom && !r.building_geom && combinedGeom(r), 'parcel', 'Parcel / Building', '#0284c7']
    ].forEach(([raw, kind, title, color]) => {
      const geo = raw && toWGS84Geom(raw);
      if (!geo) return;
      const l = L.geoJSON(geo, { style: STYLE[kind], pane: PANE[kind] }).bindPopup(popupHTML(title, color, r, comp, raw, idx));
      g.kinds[kind].push(l);
      g.addLayer(l);
    });
    if (g.getLayers().length) {
      g.bnds = g.getBounds();
      g.kb = {};
      ['parcel', 'building'].forEach(k => { const b = L.latLngBounds([]); g.kinds[k].forEach(l => b.extend(l.getBounds())); g.kb[k] = b; });
      layersMap[key] = g;
      g.land = r.parcel_id || r.land_title_no || r.title_rec_no || (r.parcel_geom ? String(typeof r.parcel_geom === 'string' ? r.parcel_geom : JSON.stringify(r.parcel_geom)) : '');
      if (g.land) (landMap[g.land] = landMap[g.land] || []).push(key);
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

  showAll();
  setTimeout(() => map.invalidateSize(), 200);
}

// ---------- 7. Details modal ----------
function showDetails(index) {
  const r = globalPermitData[index];
  if (!r) return;
  const comp = checkZoningCompliance(r), v = vertices(r);
  const na = (x) => (x === undefined || x === null || x === '' ? 'N/A' : x);
  const item = (label, val) => `<div class="details-item"><span>${label}</span>${na(val)}</div>`;
  const vtable = (pts, title) => !pts.length
    ? `<div class="details-item" style="grid-column:span 2;"><span>${title}</span>N/A</div>`
    : `<div class="details-item" style="grid-column:span 2;"><span>${title} (${pts.length} Vertices)</span>
        <div style="max-height:130px;overflow-y:auto;margin-top:6px;border:1px solid #e2e8f0;border-radius:4px;">
        <table style="width:100%;font-size:11px;"><thead style="background:#f1f5f9;position:sticky;top:0;"><tr>
          <th style="padding:4px 8px;background:#f1f5f9;color:#0f172a;">Point</th><th style="padding:4px 8px;background:#f1f5f9;color:#0f172a;">UTM Easting (X)</th><th style="padding:4px 8px;background:#f1f5f9;color:#0f172a;">UTM Northing (Y)</th></tr></thead>
          <tbody>${pts.map(p => `<tr><td style="padding:3px 8px;">P${p.index}</td><td style="padding:3px 8px;">${p.x} m E</td><td style="padding:3px 8px;">${p.y} m N</td></tr>`).join('')}</tbody>
        </table></div></div>`;
  const issues = comp.issuesList.length
    ? comp.issuesList.map(i => `<li style="color:#c0392b;margin:4px 0;">⚠️ ${i}</li>`).join('')
    : `<li style="color:#16a34a;font-weight:bold;list-style:none;">✓ Passed all zoning rules for ${comp.zoneUsed}</li>`;

  $('modal-title').innerText = `Building Permit Details: ${r.permit_number || 'N/A'}`;
  $('modal-body').innerHTML = `
    <div class="details-section">Zoning Compliance Diagnosis</div>
    <div class="details-item"><span>Status (${comp.zoneUsed})</span><div style="margin-top:4px;">${comp.badgeHTML}</div></div>
    <div class="details-item"><span>Regulatory Evaluation</span><ul style="padding-left:16px;font-size:13px;">${issues}</ul></div>
    <div class="details-section">All Spatial Vertices (EPSG:32632 / UTM Zone 32N)</div>
    ${vtable(v.parcel, 'Parcel Boundary Vertices')}${vtable(v.building, 'Building Footprint Vertices')}
    <div class="details-section">Applicant Information</div>
    ${item('Full Name', r.applicant_full_name)}${item('NUI', r.applicant_nui)}
    ${item('Phone', r.applicant_phone_number || r.applicant_phone)}${item('Email', r.applicant_email)}
    <div class="details-item" style="grid-column:span 2;"><span>Address</span>${na(r.applicant_address)}</div>
    <div class="details-section">Permit & Parcel Details</div>
    ${item('Dossier No', r.no_du_dossier || r.title_rec_no)}${item('Status', r.status || r.permit_status)}
    ${item('Deposit Date', r.date_de_depot || r.input_database_date)}${item('Land Title No', r.land_title_no || r.title_rec_no)}
    ${item('Quarter', r.parcel_quarter || r.quartier)}${item('Arrondissement', r.parcel_arrondissement)}
    ${item('Cadastral Area', r.cadastral_area && r.cadastral_area + ' m²')}
    <div class="details-section">Building Permit</div>
    ${item('Permit No', r.permit_number)}${item('Building Use', r.building_use)}
    ${item('Floors Above Ground', r.floors_above_ground)}${item('Underground Floors', r.floors_underground)}
    ${item('Height', r.height_m && r.height_m + ' m')}${item('COS', r.cos)}${item('CES', r.ces)}
    ${item('Estimated Cost', r.estimated_cost)}${item('Parking Places', r.parking_place)}${item('Building Area', (r.building_area_sq_m || r.area_sq_m) && (r.building_area_sq_m || r.area_sq_m) + ' m²')}`;
  $('detail-modal').style.display = 'flex';
}
function closeModal() { $('detail-modal').style.display = 'none'; }
on('detail-modal', 'click', (e) => { if (e.target === $('detail-modal')) closeModal(); });

// ---------- 8. Search bars ----------
const matches = (r, q) => ['applicant_full_name', 'permit_number', 'land_title_no', 'title_rec_no', 'parcel_arrondissement', 'applicant_nui']
  .some(f => r[f] && String(r[f]).toLowerCase().includes(q));

function setTab(tracker) {
  $('permitSearchBox').style.display = tracker ? 'none' : 'block';
  $('trackerSearchBox').style.display = tracker ? 'block' : 'none';
  const style = (el, active, bg) => { el.style.background = active ? bg : '#e2e8f0'; el.style.color = active ? '#fff' : '#333'; };
  style($('togglePermitBtn'), !tracker, '#0f172a');
  style($('toggleTrackerBtn'), tracker, '#2563eb');
}
on('togglePermitBtn', 'click', () => setTab(false));
on('toggleTrackerBtn', 'click', () => setTab(true));

on('search-input', 'input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  const filtered = q ? globalPermitData.filter(r => matches(r, q)) : globalPermitData;
  renderTableAndMap(filtered);
  if (q && filtered.length === 1) focusOnPermit(filtered[0].__key);
});

// ---------- 9. Live GPS tracker & road routing (one tracking board) ----------
const navBoard = $('nav-board'), navChip = $('nav-chip'), nbq = (s) => navBoard.querySelector(s);
let routing = null, watchId = null, me = null, halo = null, stepMarker = null, route = null, routeCoords = null;
let following = true, offTrack = false, boardHidden = false, lastRouted = null, lastGeo = null, nav = {};
[navBoard, navChip].forEach(el => { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); });
if (innerWidth > 640) nbq('#nb-dir').open = true;

function setBoard(visible) { boardHidden = !visible; navBoard.style.display = visible && nav.title ? 'block' : 'none'; }
nbq('.nav-x').onclick = () => setBoard(false);
$('chip-show').onclick = () => setBoard(boardHidden);
$('chip-stop').onclick = () => stopTracking();
map.on('dragstart', () => { following = false; renderLoc(); });

function renderLoc() {
  nbq('#nb-loc').innerHTML = `<div class="place">📍 ${nav.place || (nav.lat ? 'Locating address…' : 'Locating you…')}</div>
    ${nav.lat ? `<div class="sub">${nav.lat.toFixed(6)}, ${nav.lng.toFixed(6)} | UTM ${nav.utm} (±${nav.acc} m)${following ? '' : ' <a href="#" id="recenter">⌖ recenter</a>'}</div>` : ''}`;
  const rc = nbq('#recenter');
  if (rc) rc.onclick = (e) => { e.preventDefault(); following = true; me && map.panTo(me.getLatLng()); renderLoc(); };
}

function renderSum() {
  const km = nav.dist >= 1000 ? (nav.dist / 1000).toFixed(1) + ' km' : Math.round(nav.dist || 0) + ' m';
  nbq('#nb-sum').innerHTML = `<div class="big">${nav.dist != null ? `${km} · ${Math.max(1, Math.round(nav.time / 60))} min` : 'Calculating route…'}</div>
    <div class="sub">🎯 ${nav.title || ''}</div>
    ${nav.off ? '<div class="sub" style="color:#dc2626;font-weight:700">⚠️ Off route — recalculating…</div>' : ''}`;
}

const ICONS = { depart: 'A', arrive: '🎯', continue: '↑', 'bear-right': '↗', 'turn-right': '↱', 'sharp-right': '↘',
  'u-turn': '↩', 'sharp-left': '↙', 'turn-left': '↰', 'bear-left': '↖', 'enter-roundabout': '⟳' };

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

// Tap a direction -> orange marker at that turn on the route; tap again to remove
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

async function reverseGeocode(lat, lng) {
  if (lastGeo && L.latLng(lastGeo).distanceTo([lat, lng]) < 100) return;
  lastGeo = [lat, lng];
  try {
    const j = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`)).json();
    nav.place = (j.display_name || '').split(',').slice(0, 3).join(', ');
    renderLoc();
  } catch (e) {}
}

function distToRoute(p, coords) {         // metres from a point to the route line
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

function runTracker() {
  const query = $('track-search-input').value.trim().toLowerCase();
  if (!query) return;
  stopTracking();
  following = true;

  const record = globalPermitData.find(r => matches(r, query));
  if (!record) return alert("No matching permit or house found!");
  if (!navigator.geolocation) return alert("Geolocation is not supported by your browser");
  if (!window.isSecureContext) return alert("Live GPS only works on an HTTPS page. Open the https:// link of this site on your phone.");

  const key = record.__key || (record.permit_id || record.permit_number).toString(), g = layersMap[key];
  if (!g) return alert("This record has no geometry to navigate to.");
  if (!geojsonGroup.hasLayer(g)) { geojsonGroup.addLayer(g); applyMode(); }
  const target = g.bnds.getCenter();

  nav = { title: `${record.permit_number || ''} ${record.applicant_full_name ? '— ' + record.applicant_full_name : ''}`.trim() || 'Destination' };
  nbq('#nb-steps').innerHTML = '';
  navChip.style.display = 'flex';
  $('track-stop-btn').style.display = 'inline-block';
  renderLoc(); renderSum(); setBoard(true);

  // Every GPS fix: move the blue dot, update address/coordinates, re-route while you move
  const onFix = (pos) => { try { handleFix(pos); } catch (e) { nav.place = '⚠️ ' + e.message; renderLoc(); console.error(e); } };
  const handleFix = (pos) => {
    if (!nav.title) return;                       // tracking was stopped
    const { latitude: lat, longitude: lng } = pos.coords, acc = Math.round(pos.coords.accuracy || 0), here = L.latLng(lat, lng), u = toUTM(lng, lat);
    Object.assign(nav, { lat, lng, acc, utm: `${u[0].toFixed(1)} E, ${u[1].toFixed(1)} N` });

    if (!me) {
      me = L.marker(here, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000 }).bindPopup('');
      halo = L.circle(here, { radius: acc, color: '#2563eb', weight: 1, fillOpacity: .1 });
      trackingLayerGroup.addLayer(halo).addLayer(me);
    }
    me.setLatLng(here).setPopupContent(`<b>📍 You are here</b><br>${lat.toFixed(6)}, ${lng.toFixed(6)}<br>UTM ${nav.utm}`);
    halo.setLatLng(here).setRadius(acc);

    if (routeCoords) {                            // off-route detection opens the board by itself
      const off = distToRoute(here, routeCoords);
      if (off > 40 && !offTrack) { offTrack = nav.off = true; renderSum(); setBoard(true); }
      else if (off < 25 && offTrack) { offTrack = nav.off = false; renderSum(); }
    }

    if (!routing) {
      lastRouted = here;
      routing = L.Routing.control({
        waypoints: [here, L.latLng(target.lat, target.lng)],
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
    } else if (lastRouted.distanceTo(here) > 15) {
      lastRouted = here;
      routing.spliceWaypoints(0, 1, here);        // route restarts from the new position
      if (following) map.panTo(here);
    }
    renderLoc();
    reverseGeocode(lat, lng);
  };

  const onFail = (err) => {
    if (err.code === 1) { stopTracking(); alert("Location permission denied. Allow location for this site in your phone/browser settings (and open the link in Chrome/Safari, not inside WhatsApp)."); }
    else { nav.place = '⚠️ Weak GPS signal, still trying… (turn ON phone location)'; renderLoc(); }
  };

  // Fast first fix + continuous watch so the marker follows you
  navigator.geolocation.getCurrentPosition(onFix, () => {}, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
  watchId = navigator.geolocation.watchPosition(onFix, onFail, { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
}

// keydown + keyCode is reliable on phone keyboards; the Track button works everywhere
on('track-search-input', 'keydown', (e) => { if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); e.target.blur(); runTracker(); } });
on('track-go-btn', 'click', runTracker);
on('track-stop-btn', 'click', stopTracking);

// ---------- 10. Initial load ----------
loadBuildingPermit();
