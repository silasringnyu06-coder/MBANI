// ===== Setup & helpers =====
proj4.defs("EPSG:32632", "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs");
proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");
const $ = id => document.getElementById(id), NA = v => v || 'N/A';
const isUTM = (x, y) => Math.abs(x) > 180 || Math.abs(y) > 90;
const toWGS = (x, y) => proj4("EPSG:32632", "EPSG:4326", [x, y]);
const toUTM = (lng, lat) => proj4("EPSG:4326", "EPSG:32632", [lng, lat]);
const has = (r, q, fs) => fs.some(f => r[f] && String(r[f]).toLowerCase().includes(q));
const ALL_LABEL = '🌐 Show All Parcels & Footprints';

// ===== Zoning: [maxCES, maxCOS, maxFloors, maxHeightM] =====
const ZONES = {
  'Yaoundé 1': [.60, 2.0, 4, 12], 'Yaoundé 2': [.70, 2.5, 5, 15], 'Yaoundé 3': [.50, 1.5, 3, 9],
  'Yaoundé 4': [.60, 2.0, 4, 12], 'Yaoundé 5': [.55, 1.8, 3, 10], 'Yaoundé 6': [.50, 1.5, 3, 9],
  'Yaoundé 7': [.45, 1.2, 2, 7.5], 'Default': [.60, 2.0, 4, 12]
};
const rulesFor = z => { const [maxCES, maxCOS, maxFloors, maxHeightM] = ZONES[z] || ZONES.Default; return { maxCES, maxCOS, maxFloors, maxHeightM }; };

function checkZoningCompliance(r) {
  const zone = r.parcel_arrondissement || r.quartier || 'Default', R = rulesFor(zone), issues = [];
  const pA = parseFloat(r.cadastral_area || 0), bA = parseFloat(r.area_sq_m || 0);
  const floors = parseInt(r.floors_above_ground || r.floors_above || 1, 10), h = parseFloat(r.height_m || 0);
  const both = pA > 0 && bA > 0;
  const ces = both ? bA / pA : parseFloat(r.ces || 0), cos = both ? bA * floors / pA : parseFloat(r.cos || 0);
  if (h > 0 && h > R.maxHeightM) issues.push(`Height exceeds limit for ${zone} (${h}m vs max ${R.maxHeightM}m)`);
  if (floors > R.maxFloors) issues.push(`Floors exceed limit for ${zone} (${floors} floors vs max ${R.maxFloors})`);
  if (ces > R.maxCES) issues.push(`CES exceeds limit for ${zone} (${(ces * 100).toFixed(1)}% vs max ${R.maxCES * 100}%)`);
  if (cos > R.maxCOS) issues.push(`COS exceeds limit for ${zone} (${cos.toFixed(2)} vs max ${R.maxCOS})`);
  const ok = !issues.length;
  return {
    isCompliant: ok, zoneUsed: zone, rulesApplied: R, issuesList: issues,
    badgeHTML: `<span style="background:${ok ? '#2ecc71' : '#e74c3c'}; color:white; padding:3px 8px; border-radius:4px; font-weight:bold; font-size:11px;">${ok ? 'Compliant' : 'Non-Compliant'} (${zone})</span>`
  };
}

// ===== Geometry =====
function parseGeom(g) {
  if (typeof g === 'string') { try { return JSON.parse(g); } catch (e) { return null; } }
  return g || null;
}
function getCoords(g) {
  let c = g.type === 'GeometryCollection' && g.geometries && g.geometries.length ? g.geometries[0].coordinates : g.coordinates;
  if (!c) return null;
  while (Array.isArray(c[0]) && Array.isArray(c[0][0])) c = c[0];
  return c;
}
function getWGS84Centroid(raw) {
  const g = parseGeom(raw);
  if (!g) return null;
  try {
    const c = getCoords(g);
    if (!c) return null;
    let sx = 0, sy = 0, n = 0;
    c.forEach(p => { if (typeof p[0] === 'number' && typeof p[1] === 'number') { sx += p[0]; sy += p[1]; n++; } });
    if (!n) return null;
    const x = sx / n, y = sy / n;
    if (isUTM(x, y)) { const w = toWGS(x, y); return { lng: w[0], lat: w[1] }; }
    return { lng: x, lat: y };
  } catch (e) { return null; }
}
function projectedCentroid(raw) {
  const c = getWGS84Centroid(raw);
  if (!c) return { x: 'N/A', y: 'N/A' };
  const u = toUTM(c.lng, c.lat);
  return { x: u[0].toFixed(2), y: u[1].toFixed(2) };
}
function vertices(rec) {
  const pts = raw => {
    const g = parseGeom(raw);
    try {
      const c = g && getCoords(g);
      return (c || []).map((p, i) => {
        if (typeof p[0] !== 'number' || typeof p[1] !== 'number') return { i: i + 1, x: 'N/A', y: 'N/A' };
        const u = isUTM(p[0], p[1]) ? p : toUTM(p[0], p[1]);
        return { i: i + 1, x: u[0].toFixed(2), y: u[1].toFixed(2) };
      });
    } catch (e) { return []; }
  };
  const out = { parcel: rec.parcel_geom ? pts(rec.parcel_geom) : [], building: rec.building_geom ? pts(rec.building_geom) : [] };
  if (!out.parcel.length && !out.building.length && rec.view_combined_geom) out.parcel = pts(rec.view_combined_geom);
  return out;
}

// ===== Map =====
const map = L.map('map', { zoomControl: true, fadeAnimation: true }).setView([3.848, 11.502], 12);
const gTiles = l => L.tileLayer(`https://mt1.google.com/vt/lyrs=${l}&x={x}&y={y}&z={z}`, { maxZoom: 20, attribution: 'Map data © Google', subdomains: ['0', '1', '2', '3'] });
const sat = gTiles('s').addTo(map);
L.control.layers({
  "Google Satellite": sat, "Google Satellite Hybrid": gTiles('y'),
  "OpenStreetMap": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors', subdomains: ['a', 'b', 'c'] })
}).addTo(map);

const geojsonGroup = L.featureGroup().addTo(map), trackingLayerGroup = L.layerGroup().addTo(map);
const layersMap = {};
let globalPermitData = [], activePermitLayer = null, showingAll = false, sortCol = null, asc = true;
let activeWatchId = null, liveUserMarker = null;

const setAllBtn = on => { const b = $('toggleAllGeomBtn'); if (b) { b.classList.toggle('active', on); b.innerHTML = on ? '❌ Clear All Features' : ALL_LABEL; } };

map.on('mousemove', e => {
  const u = toUTM(e.latlng.lng, e.latlng.lat), el = $('coord-display');
  if (el) el.innerText = `UTM Zone 32N (EPSG:32632) | X: ${u[0].toFixed(2)} m E | Y: ${u[1].toFixed(2)} m N`;
});

// ===== Data, table, sorting =====
async function loadBuildingPermit(src = 'local') {
  const body = $('permit-table-body');
  const msg = (t, s = 'text-align:center;') => { if (body) body.innerHTML = `<tr><td colspan="7" style="${s}">${t}</td></tr>`; };
  msg('Loading building permit data...');
  const { hostname: h, protocol: p } = location;
  const base = h === 'localhost' || h === '127.0.0.1' || p === 'file:' ? 'http://localhost:5000' : 'https://mbani.onrender.com';
  try {
    const res = await fetch(`${base}/api/${src === 'cloud' ? 'cloud-building-permit' : 'building-permit'}`);
    if (!res.ok) throw new Error(`HTTP error! Status: ${res.status}`);
    globalPermitData = await res.json();
    renderTableAndMap(globalPermitData);
  } catch (e) {
    console.error('Error fetching data:', e);
    msg('Failed to load data from server. Ensure backend API is active on port 5000.', 'text-align:center; color: red;');
  }
}

function sortTableBy(col) {
  if (sortCol === col) asc = !asc; else { sortCol = col; asc = true; }
  globalPermitData.sort((a, b) => {
    let x = (a[col] || '').toString().toLowerCase(), y = (b[col] || '').toString().toLowerCase();
    if (!isNaN(x) && !isNaN(y) && x !== '' && y !== '') { x = parseFloat(x); y = parseFloat(y); }
    return x < y ? (asc ? -1 : 1) : x > y ? (asc ? 1 : -1) : 0;
  });
  renderTableAndMap(globalPermitData);
}

function renderTableAndMap(data) {
  const body = $('permit-table-body');
  if (!body) return;
  body.innerHTML = '';
  geojsonGroup.clearLayers();
  Object.keys(layersMap).forEach(k => delete layersMap[k]);
  if (activePermitLayer) { map.removeLayer(activePermitLayer); activePermitLayer = null; }
  showingAll = false; setAllBtn(false);
  if (!data || !data.length) { body.innerHTML = '<tr><td colspan="7" style="text-align:center;">No records found.</td></tr>'; return; }

  data.forEach((r, i) => {
    const key = (r.permit_id || r.permit_number || i).toString();
    layersMap[key] = r;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${NA(r.permit_number)}</strong></td><td>${NA(r.applicant_full_name)}</td><td>${NA(r.applicant_email)}</td>
      <td>${NA(r.applicant_phone_number || r.applicant_phone)}</td><td>${NA(r.parcel_arrondissement)}</td><td>${NA(r.building_use)}</td>
      <td>
        <button class="btn-details" onclick="event.stopPropagation(); togglePermitOnMap('${key}')">👁️ Show/Hide</button>
        <button class="btn-details" onclick="event.stopPropagation(); showDetails(${i})">Details</button>
      </td>`;
    tr.onclick = () => togglePermitOnMap(key);
    body.appendChild(tr);
  });
  setTimeout(() => map.invalidateSize(), 200);
}

// ===== Map layers =====
function togglePermitOnMap(key) {
  const rec = layersMap[key];
  if (!rec) return;
  if (activePermitLayer && activePermitLayer.permitKey === key) { geojsonGroup.clearLayers(); activePermitLayer = null; return; }
  geojsonGroup.clearLayers();

  const group = L.featureGroup(), comp = checkZoningCompliance(rec);
  const reproject = c => typeof c[0] === 'number' && typeof c[1] === 'number' ? (isUTM(c[0], c[1]) ? toWGS(c[0], c[1]) : c) : c.map(reproject);

  const add = (raw, style, title, color) => {
    let g = parseGeom(raw);
    if (!g) return;
    if (getWGS84Centroid(g)) { try { const copy = JSON.parse(JSON.stringify(g)); copy.coordinates = reproject(copy.coordinates); g = copy; } catch (e) {} }
    const u = projectedCentroid(raw);
    L.geoJSON(g, { style }).bindPopup(`
      <div style="font-size:13px;">
        <strong style="color: ${color}; font-size: 14px;">${title}</strong><br>
        <strong>Permit:</strong> ${NA(rec.permit_number)}<br><strong>Applicant:</strong> ${NA(rec.applicant_full_name)}<br>
        <strong>Compliance:</strong> ${comp.badgeHTML}<br>
        <strong>UTM X:</strong> ${u.x} m E | <strong>Y:</strong> ${u.y} m N
      </div>`).addTo(group);
  };

  if (rec.parcel_geom) add(rec.parcel_geom, { color: '#00d2ff', weight: 3, fillColor: '#00d2ff', fillOpacity: 0.35 }, 'Parcel Boundary', '#0284c7');
  if (rec.building_geom) add(rec.building_geom, { color: '#ffea00', weight: 2, fillColor: '#ffab00', fillOpacity: 0.7 }, 'Building Footprint', 'red');
  if (!rec.parcel_geom && !rec.building_geom && rec.view_combined_geom)
    add(rec.view_combined_geom, { color: '#00d2ff', weight: 2, fillColor: '#00d2ff', fillOpacity: 0.35 }, 'Parcel / Building', '#0284c7');

  if (group.getLayers().length) {
    geojsonGroup.addLayer(group);
    activePermitLayer = group; group.permitKey = key;
    map.fitBounds(group.getBounds(), { padding: [30, 30], maxZoom: 19, animate: true });
    group.openPopup();
  }
}

function toggleAllPermitsOnMap() {
  geojsonGroup.clearLayers(); activePermitLayer = null;
  if (showingAll) { showingAll = false; setAllBtn(false); return; }

  const all = L.featureGroup();
  Object.values(layersMap).forEach(rec => {
    const comp = checkZoningCompliance(rec);
    const add = (raw, style, head, badge) => {
      const g = parseGeom(raw);
      if (g) L.geoJSON(g, { style }).bindPopup(`
        <div style="font-size:13px;">${head}<strong>Permit:</strong> ${NA(rec.permit_number)}<br>
        <strong>Applicant:</strong> ${NA(rec.applicant_full_name)}${badge ? `<br><strong>Compliance:</strong> ${comp.badgeHTML}` : ''}</div>`).addTo(all);
    };
    add(rec.parcel_geom, { color: '#00d2ff', weight: 2, fillColor: '#00d2ff', fillOpacity: 0.3 }, '', true);
    add(rec.building_geom, { color: '#ffea00', weight: 2, fillColor: '#ffab00', fillOpacity: 0.6 }, '<strong>Building Footprint</strong><br>', false);
  });

  if (all.getLayers().length) {
    geojsonGroup.addLayer(all);
    map.fitBounds(all.getBounds(), { padding: [30, 30], animate: true });
    showingAll = true; setAllBtn(true);
  } else alert("No spatial geometries found in the loaded database records.");
}

// ===== Details modal =====
function showDetails(i) {
  const r = globalPermitData[i], c = checkZoningCompliance(r), v = vertices(r), u = (x, s) => x && x + s;
  if ($('modal-title')) $('modal-title').innerText = `Building Permit Details: ${NA(r.permit_number)}`;

  const item = (l, val, wide) => `<div class="details-item"${wide ? ' style="grid-column: span 2;"' : ''}><span>${l}</span>${NA(val)}</div>`;
  const th = 'padding: 4px 8px; border-bottom: 1px solid #e2e8f0;', td = 'padding: 3px 8px; border-bottom: 1px solid #f8fafc;';
  const vTable = (pts, title) => !pts.length ? item(title, '', 1) : `
    <div class="details-item" style="grid-column: span 2;"><span>${title} (${pts.length} Vertices)</span>
      <div style="max-height: 130px; overflow-y: auto; margin-top: 6px; border: 1px solid #e2e8f0; border-radius: 4px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 11px; text-align: left;">
          <thead style="background-color: #f1f5f9; position: sticky; top: 0;"><tr>
            <th style="${th}">Point</th><th style="${th}">UTM Easting (X)</th><th style="${th}">UTM Northing (Y)</th></tr></thead>
          <tbody>${pts.map(p => `<tr><td style="${td}">P${p.i}</td><td style="${td}">${p.x} m E</td><td style="${td}">${p.y} m N</td></tr>`).join('')}</tbody>
        </table>
      </div></div>`;

  const groups = {
    'Applicant Information': [['Full Name', r.applicant_full_name], ['NUI', r.applicant_nui], ['Phone', r.applicant_phone_number || r.applicant_phone],
      ['Email', r.applicant_email], ['Address', r.applicant_address, 1]],
    'Permit & Parcel Details': [['Permit No', r.permit_number], ['Dossier No', r.no_du_dossier || r.title_rec_no], ['Status', r.status || r.permit_status],
      ['Deposit Date', r.date_de_depot || r.input_database_date], ['Land Title No', r.land_title_no || r.title_rec_no],
      ['Quarter', r.parcel_quarter || r.quartier], ['Arrondissement', r.parcel_arrondissement], ['Cadastral Area', u(r.cadastral_area, ' m²')]],
    'Building Parameters': [['Building Use', r.building_use], ['Floors Above Ground', r.floors_above_ground], ['Underground Floors', r.floors_underground],
      ['Height', u(r.height_m, ' m')], ['COS', r.cos], ['CES', r.ces], ['Estimated Cost', r.estimated_cost], ['Parking Places', r.parking_place], ['Area', u(r.area_sq_m, ' m²')]]
  };
  const issues = c.issuesList.length
    ? c.issuesList.map(x => `<li style="color:#e74c3c; margin-bottom:2px; font-weight:500;">⚠️ ${x}</li>`).join('')
    : `<li style="color:#2ecc71; font-weight:bold; list-style-type:none;">✓ Passed all zoning rules for ${c.zoneUsed}</li>`;

  if ($('modal-body')) $('modal-body').innerHTML = `
    <div class="details-section" style="background:#0f172a; color:white; padding:6px 8px; font-weight:bold; border-radius:4px;">Zoning Compliance Diagnosis</div>
    ${item(`Status (${c.zoneUsed})`, c.badgeHTML)}
    ${item('Regulatory Evaluation', `<ul style="margin: 4px 0 0 16px; padding:0; font-size:12px;">${issues}</ul>`, 1)}
    <div class="details-section">All Spatial Vertices (EPSG:32632 / UTM Zone 32N)</div>
    ${vTable(v.parcel, 'Parcel Boundary Vertices')}${vTable(v.building, 'Building Footprint Vertices')}
    ${Object.entries(groups).map(([t, f]) => `<div class="details-section">${t}</div>${f.map(x => item(...x)).join('')}`).join('')}`;
  if ($('detail-modal')) $('detail-modal').style.display = 'flex';
}
const closeModal = () => { if ($('detail-modal')) $('detail-modal').style.display = 'none'; };

function displayZoneInfo(z) {
  const R = rulesFor(z), el = $('zone-info-display');
  if (el) el.innerHTML = `Max Height: <strong>${R.maxHeightM}m</strong> | Max Floors: <strong>${R.maxFloors}</strong> | Max CES: <strong>${R.maxCES * 100}%</strong> | Max COS: <strong>${R.maxCOS}</strong>`;
}

// ===== Search UI =====
const [pBtn, tBtn, pBox, tBox] = ['togglePermitBtn', 'toggleTrackerBtn', 'permitSearchBox', 'trackerSearchBox'].map($);
if (pBtn && tBtn) {
  const mode = permit => {
    pBox.style.display = permit ? 'block' : 'none'; tBox.style.display = permit ? 'none' : 'block';
    [[pBtn, permit, '#0f172a'], [tBtn, !permit, '#2563eb']].forEach(([b, on, c]) => { b.style.background = on ? c : '#e2e8f0'; b.style.color = on ? 'white' : '#333'; });
  };
  pBtn.addEventListener('click', () => mode(true));
  tBtn.addEventListener('click', () => mode(false));
}

if ($('search-input')) $('search-input').addEventListener('input', e => {
  const q = e.target.value.toLowerCase().trim();
  if (!q) return renderTableAndMap(globalPermitData);
  const hits = globalPermitData.filter(r => has(r, q, ['applicant_full_name', 'permit_number', 'land_title_no', 'title_rec_no', 'applicant_arrondissement', 'parcel_arrondissement', 'applicant_nui']));
  renderTableAndMap(hits);
  if (hits.length === 1) togglePermitOnMap((hits[0].permit_id || hits[0].permit_number).toString());
});

// ===== Yango-style live tracker =====
if ($('track-search-input')) {
  const FALLBACK = [3.8666, 11.5167], ARRIVE = 25, OFF = 40, COOLDOWN = 8000, ZOOM = 17;
  const LAND = ['land_title_no', 'title_rec_no'], HOUSE = ['permit_number', 'applicant_full_name'];
  const router = L.Routing.osrmv1({ serviceUrl: 'https://router.project-osrm.org/route/v1' });
  const TURN = { Left: ['⬅️', 'Turn left'], Right: ['➡️', 'Turn right'], SlightLeft: ['↖️', 'Bear left'], SlightRight: ['↗️', 'Bear right'],
    SharpLeft: ['↙️', 'Sharp left'], SharpRight: ['↘️', 'Sharp right'], TurnAround: ['↩️', 'Make a U-turn'], Roundabout: ['🔄', 'Take the roundabout'],
    DestinationReached: ['🎯', 'Arrive at destination'] };

  let follow = true, gps = false, arrived = false, session = 0, target = null, label = '';
  let ring = null, line = null, casing = null, route = null, idx = 0, prog = 0, off = 0;
  let pending = false, lastReq = 0, headRef = null, angle = null, lastFix = 0, frame = null;

  const fmt = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
  const bearing = (a, b) => {
    const r = Math.PI / 180, d = (b.lng - a.lng) * r;
    return (Math.atan2(Math.sin(d) * Math.cos(b.lat * r), Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos(d)) / r + 360) % 360;
  };
  const arrowIcon = L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 15],
    html: `<div class="gps-arrow" style="width:30px;height:30px;transition:transform .35s linear;"><svg viewBox="0 0 28 28" width="30" height="30">
      <path d="M14 0 L21 10 L7 10 Z" fill="#2563eb" stroke="#fff" stroke-width="1.5"/><circle cx="14" cy="15" r="9" fill="#2563eb" stroke="#fff" stroke-width="3"/></svg></div>` });

  // Single HUD: next turn, ETA, buttons
  const hud = document.createElement('div');
  hud.style.cssText = 'display:none;position:absolute;top:10px;left:60px;right:60px;max-width:420px;margin:0 auto;z-index:1001;background:#0f172a;color:#fff;border-radius:12px;padding:10px 14px;box-shadow:0 2px 8px rgba(0,0,0,.4);font:13px sans-serif;';
  const btn = 'padding:5px 9px;border:0;border-radius:6px;cursor:pointer;color:#fff;font-size:12px;margin-right:4px;background:';
  hud.innerHTML = `<div style="display:flex;gap:10px;align-items:center;"><span id="h-ico" style="font-size:28px;"></span>
    <div style="flex:1;min-width:0;"><b id="h-main" style="font-size:18px;"></b>
    <div id="h-sub" style="opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div></div></div>
    <div id="h-eta" style="margin:6px 0;font-weight:600;"></div>
    <button id="h-follow" style="${btn}#2563eb">🧭 Following</button><button id="h-stop" style="${btn}#dc2626">✖ Stop</button>`;
  L.DomEvent.disableClickPropagation(hud);
  map.getContainer().appendChild(hud);
  const setText = (id, t) => { $(id).textContent = t; };

  const setFollow = on => {
    follow = on; setText('h-follow', on ? '🧭 Following' : '🧭 Recenter');
    if (on && liveUserMarker) map.setView(liveUserMarker.getLatLng(), Math.max(map.getZoom(), ZOOM));
  };
  $('h-follow').addEventListener('click', () => setFollow(!follow));
  $('h-stop').addEventListener('click', () => stop());
  map.on('dragstart', () => { if (liveUserMarker && follow) setFollow(false); });

  function stop() {
    session++;
    if (activeWatchId !== null) { navigator.geolocation.clearWatch(activeWatchId); activeWatchId = null; }
    if (frame) { cancelAnimationFrame(frame); frame = null; }
    trackingLayerGroup.clearLayers();
    liveUserMarker = ring = line = casing = route = headRef = angle = null;
    idx = prog = off = 0; pending = arrived = false;
    hud.style.display = 'none';
  }

  // Route handling
  function setRoute(r) {
    const c = r.coordinates;
    if (!c || c.length < 2) return false;
    const cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + c[i - 1].distanceTo(c[i]));
    route = { c, cum, total: cum[cum.length - 1] || 1, time: r.summary.totalTime, steps: r.instructions || [] };
    idx = prog = off = 0;
    if (!line) {
      const o = { lineCap: 'round', lineJoin: 'round', interactive: false };
      casing = L.polyline([], { color: '#fff', weight: 11, opacity: .9, ...o });
      line = L.polyline([], { color: '#2563eb', weight: 7, opacity: .95, ...o });
      trackingLayerGroup.addLayer(casing); trackingLayerGroup.addLayer(line);
    }
    return true;
  }
  const draw = from => { if (route && line) { const p = [from, ...route.c.slice(idx + 1)]; casing.setLatLngs(p); line.setLatLngs(p); } };

  function requestRoute(from) {
    const s = session, first = !route;
    pending = true; lastReq = Date.now();
    router.route([L.Routing.waypoint(from), L.Routing.waypoint(target)], (err, routes) => {
      if (s !== session) return;
      pending = false;
      if (err || !routes || !routes.length || !setRoute(routes[0])) console.warn('Routing failed:', err);
      else { draw(from); if (first && !gps) map.fitBounds(line.getBounds(), { padding: [90, 40] }); }
      if (liveUserMarker) updateHud(liveUserMarker.getLatLng());
    });
  }

  // Nearest point on route near the last known position
  function snap(h) {
    const c = route.c, kx = 111320 * Math.cos(h.lat * Math.PI / 180), ky = 110540;
    let b = { d: Infinity, i: idx, t: 0 };
    for (let i = Math.max(0, idx - 3); i <= Math.min(c.length - 2, idx + 400); i++) {
      const ax = (c[i].lng - h.lng) * kx, ay = (c[i].lat - h.lat) * ky;
      const dx = (c[i + 1].lng - h.lng) * kx - ax, dy = (c[i + 1].lat - h.lat) * ky - ay, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l)) : 0, d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < b.d) b = { d, i, t };
    }
    return b;
  }

  // Smooth gliding marker + heading
  function glide(to, ms) {
    if (!liveUserMarker) return;
    const from = liveUserMarker.getLatLng(), t0 = performance.now();
    if (frame) cancelAnimationFrame(frame);
    const step = now => {
      if (!liveUserMarker) return;
      const k = Math.min(1, (now - t0) / ms), p = L.latLng(from.lat + (to.lat - from.lat) * k, from.lng + (to.lng - from.lng) * k);
      liveUserMarker.setLatLng(p);
      if (follow) map.panTo(p, { animate: false });
      frame = k < 1 ? requestAnimationFrame(step) : null;
    };
    frame = requestAnimationFrame(step);
  }
  function setArrow(deg) {
    angle = angle === null ? deg : angle + ((deg - angle + 540) % 360) - 180;
    const el = liveUserMarker.getElement && liveUserMarker.getElement(), a = el && el.querySelector('.gps-arrow');
    if (a) a.style.transform = `rotate(${angle}deg)`;
  }

  function updateHud(here) {
    let rem = map.distance(here, target), secs = null, ico = '⬆️', main = fmt(rem), sub = pending ? 'Calculating route…' : 'Heading to destination';
    if (route) {
      rem = Math.max(0, route.total - prog); secs = route.time * rem / route.total;
      const n = route.steps.find(s => s.index > idx);
      if (n) {
        const [i, t] = TURN[n.type] || ['⬆️', 'Continue straight'];
        ico = i; sub = t + (n.road && n.type !== 'DestinationReached' ? ` onto ${n.road}` : '');
        main = fmt(Math.max(0, route.cum[Math.min(n.index, route.cum.length - 1)] - prog));
      }
      if (pending) sub = 'Rerouting…';
    }
    setText('h-ico', ico); setText('h-main', main); setText('h-sub', sub);
    setText('h-eta', `${label} · ` + (secs === null ? `${fmt(rem)} straight-line`
      : `${Math.max(1, Math.round(secs / 60))} min · ${fmt(rem)} · arrive ${new Date(Date.now() + secs * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
  }

  function arrive(here) {
    arrived = true;
    if (activeWatchId !== null) { navigator.geolocation.clearWatch(activeWatchId); activeWatchId = null; }
    if (line) { line.setLatLngs([]); casing.setLatLngs([]); }
    setText('h-ico', '🎉'); setText('h-main', 'You have arrived'); setText('h-sub', label); setText('h-eta', label);
    L.popup().setLatLng(here).setContent('🎉 You have arrived at the destination').openOn(map);
  }

  function begin(lat, lng, isGps, accuracy, rec, kind) {
    const o = L.latLng(lat, lng);
    gps = isGps; arrived = false; lastFix = Date.now(); headRef = o;
    liveUserMarker = (isGps ? L.marker(o, { icon: arrowIcon, zIndexOffset: 1000 })
      : L.circleMarker(o, { radius: 10, fillColor: '#f59e0b', color: '#fff', weight: 3, opacity: 1, fillOpacity: .95 }))
      .bindPopup(`<b>${isGps ? '📍 Live GPS Location (Active)' : '📍 Fallback Origin (Hôtel de Ville, Yaoundé)'}</b>`);
    trackingLayerGroup.addLayer(liveUserMarker);
    if (isGps) trackingLayerGroup.addLayer(ring = L.circle(o, { radius: accuracy || 0, color: '#2563eb', weight: 1, fillColor: '#2563eb', fillOpacity: .12, interactive: false }));
    trackingLayerGroup.addLayer(L.marker(target, { title: 'Destination Site', icon: L.divIcon({ className: '', iconSize: [30, 30], iconAnchor: [15, 28],
      html: `<div style="font-size:30px;line-height:30px;">${kind === 'parcel' ? '📍' : '🏠'}</div>` }) }));
    $('h-follow').style.display = isGps ? '' : 'none';
    hud.style.display = 'block';
    follow = isGps; if (isGps) setFollow(true);
    if (isGps && map.distance(o, target) <= ARRIVE) return arrive(o);
    updateHud(o); requestRoute(o);
  }

  function onFix(pos) {
    if (!liveUserMarker || arrived) return;
    const { latitude, longitude, accuracy, heading, speed } = pos.coords, here = L.latLng(latitude, longitude), now = Date.now();
    const dt = Math.min(1500, Math.max(300, now - lastFix)); lastFix = now;

    let shown = here;
    if (route) {
      const s = snap(here);
      if (s.d <= Math.max(OFF, accuracy || 0)) {
        off = 0; idx = s.i;
        prog = route.cum[s.i] + s.t * (route.cum[s.i + 1] - route.cum[s.i]);
        const a = route.c[s.i], b = route.c[s.i + 1], on = L.latLng(a.lat + (b.lat - a.lat) * s.t, a.lng + (b.lng - a.lng) * s.t);
        if (s.d <= 20) shown = on;
        draw(on);
      } else off++;
    }

    let deg = null;
    if (typeof heading === 'number' && !isNaN(heading) && (speed == null || speed > 1)) { deg = heading; headRef = here; }
    else if (headRef && map.distance(headRef, here) > 5) { deg = bearing(headRef, here); headRef = here; }
    else if (angle === null && route) deg = bearing(here, route.c[Math.min(idx + 3, route.c.length - 1)]);
    if (deg !== null) setArrow(deg);

    glide(shown, dt);
    if (ring) ring.setLatLng(here).setRadius(accuracy || 0);
    if (map.distance(here, target) <= ARRIVE) return arrive(here);
    if ((!route || off >= 2) && !pending && now - lastReq > COOLDOWN) requestRoute(here);
    updateHud(here);
  }

  // Search & start: land title -> parcel, permit number / name -> house
  $('track-search-input').addEventListener('keypress', e => {
    if (e.key !== 'Enter') return;
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    stop();
    if (showingAll) { showingAll = false; setAllBtn(false); }

    const find = (fs, exact) => globalPermitData.find(r => exact ? fs.some(f => r[f] && String(r[f]).toLowerCase() === q) : has(r, q, fs));
    let rec, kind;
    if ((rec = find(LAND, 1))) kind = 'parcel';
    else if ((rec = find(HOUSE, 1))) kind = 'house';
    else if ((rec = find(LAND))) kind = 'parcel';
    else if ((rec = find(HOUSE) || find(['parcel_arrondissement']))) kind = 'house';
    else return alert("No matching land title, permit number, or applicant found for: " + q);

    const key = (rec.permit_id || rec.permit_number || globalPermitData.indexOf(rec)).toString();
    if (!layersMap[key]) renderTableAndMap(globalPermitData);
    if (!(activePermitLayer && activePermitLayer.permitKey === key)) togglePermitOnMap(key);

    const geom = kind === 'parcel' ? rec.parcel_geom || rec.view_combined_geom || rec.building_geom : rec.building_geom || rec.parcel_geom || rec.view_combined_geom;
    const c = getWGS84Centroid(geom);
    if (!c) return alert("This record does not have valid geometry coordinates to calculate a road route.");
    target = L.latLng(c.lat, c.lng);
    label = kind === 'parcel' ? `Parcel · Land title ${rec.land_title_no || rec.title_rec_no || 'N/A'}`
      : `House · Permit ${NA(rec.permit_number)}${rec.applicant_full_name ? ' — ' + rec.applicant_full_name : ''}`;

    if (!navigator.geolocation) return begin(...FALLBACK, false, 0, rec, kind);
    const opts = { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }, s = session;
    navigator.geolocation.getCurrentPosition(
      p => {
        if (s !== session) return;
        begin(p.coords.latitude, p.coords.longitude, true, p.coords.accuracy, rec, kind);
        if (!arrived) activeWatchId = navigator.geolocation.watchPosition(onFix, er => console.warn("Live GPS position update failed:", er), opts);
      },
      er => {
        if (s !== session) return;
        console.warn("GPS Location Access Failed/Denied:", er);
        alert(er.code === er.PERMISSION_DENIED ? "GPS access denied. Please enable location permissions on your phone."
          : er.code === er.TIMEOUT ? "GPS request timed out. Make sure GPS is turned ON on your phone."
          : "GPS access unavailable. Defaulting route origin to Hôtel de Ville de Yaoundé.");
        begin(...FALLBACK, false, 0, rec, kind);
      }, opts);
  });
}

loadBuildingPermit('local');
