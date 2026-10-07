// ================= MBANI WebGIS - app.js =================
// 1. Projections
proj4.defs("EPSG:32632", "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs");
proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");

// 1.1 Zoning rules
const ZONING_RULES = {
  'Yaoundé 1': { maxCES: 0.60, maxCOS: 2.0, maxFloors: 4, maxHeightM: 12.0 },
  'Yaoundé 2': { maxCES: 0.70, maxCOS: 2.5, maxFloors: 5, maxHeightM: 15.0 },
  'Yaoundé 3': { maxCES: 0.50, maxCOS: 1.5, maxFloors: 3, maxHeightM: 9.0 },
  'Yaoundé 4': { maxCES: 0.60, maxCOS: 2.0, maxFloors: 4, maxHeightM: 12.0 },
  'Yaoundé 5': { maxCES: 0.55, maxCOS: 1.8, maxFloors: 3, maxHeightM: 10.0 },
  'Yaoundé 6': { maxCES: 0.50, maxCOS: 1.5, maxFloors: 3, maxHeightM: 9.0 },
  'Yaoundé 7': { maxCES: 0.45, maxCOS: 1.2, maxFloors: 2, maxHeightM: 7.5 },
  'Default':   { maxCES: 0.60, maxCOS: 2.0, maxFloors: 4, maxHeightM: 12.0 }
};

function checkZoningCompliance(record) {
  const issues = [];
  const zoneName = record.parcel_arrondissement || record.quartier || 'Default';
  const rules = ZONING_RULES[zoneName] || ZONING_RULES['Default'];

  const parcelArea = parseFloat(record.cadastral_area || 0);
  const buildingArea = parseFloat(record.area_sq_m || 0);
  const floors = parseInt(record.floors_above_ground || record.floors_above || 1, 10);
  const heightM = parseFloat(record.height_m || 0);
  let ces = parseFloat(record.ces || 0);
  let cos = parseFloat(record.cos || 0);

  if (heightM > 0 && heightM > rules.maxHeightM)
    issues.push(`Height exceeds limit for ${zoneName} (${heightM}m vs max ${rules.maxHeightM}m)`);
  if (floors > rules.maxFloors)
    issues.push(`Floors exceed limit for ${zoneName} (${floors} floors vs max ${rules.maxFloors})`);

  if (parcelArea > 0 && buildingArea > 0) {
    ces = buildingArea / parcelArea;
    cos = (buildingArea * floors) / parcelArea;
  }
  if (ces > rules.maxCES)
    issues.push(`CES exceeds limit for ${zoneName} (${(ces * 100).toFixed(1)}% vs max ${rules.maxCES * 100}%)`);
  if (cos > rules.maxCOS)
    issues.push(`COS exceeds limit for ${zoneName} (${cos.toFixed(2)} vs max ${rules.maxCOS})`);

  const ok = issues.length === 0;
  const color = ok ? '#2ecc71' : '#e74c3c';
  return {
    isCompliant: ok,
    zoneUsed: zoneName,
    rulesApplied: rules,
    badgeHTML: `<span style="background:${color};color:white;padding:3px 8px;border-radius:4px;font-weight:bold;font-size:11px;">${ok ? 'Compliant' : 'Non-Compliant'} (${zoneName})</span>`,
    issuesList: issues
  };
}

// ---------- Geometry helpers ----------
function parseGeom(geom) {
  if (!geom) return null;
  if (typeof geom === 'string') { try { return JSON.parse(geom); } catch (e) { return null; } }
  return geom;
}

// Convert any coordinate array (UTM or WGS84) to WGS84 [lng, lat], recursively
function reprojectCoords(c) {
  if (typeof c[0] === 'number' && typeof c[1] === 'number') {
    return (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90)
      ? proj4("EPSG:32632", "EPSG:4326", [c[0], c[1]]) : c;
  }
  return c.map(reprojectCoords);
}

function toWGS84Geom(raw) {
  const g = parseGeom(raw);
  if (!g) return null;
  try {
    const copy = JSON.parse(JSON.stringify(g));
    if (copy.type === 'GeometryCollection') {
      copy.geometries.forEach(x => { x.coordinates = reprojectCoords(x.coordinates); });
    } else if (copy.coordinates) {
      copy.coordinates = reprojectCoords(copy.coordinates);
    }
    return copy;
  } catch (e) { return g; }
}

function firstRing(raw) {
  const g = parseGeom(raw);
  if (!g) return null;
  let c = g.type === 'GeometryCollection' && g.geometries && g.geometries.length
    ? g.geometries[0].coordinates : g.coordinates;
  if (!c) return null;
  while (Array.isArray(c[0]) && Array.isArray(c[0][0])) c = c[0];
  return c;
}

function getWGS84Centroid(raw) {
  try {
    const ring = firstRing(raw);
    if (!ring) return null;
    let sx = 0, sy = 0, n = 0;
    ring.forEach(p => {
      if (typeof p[0] === 'number' && typeof p[1] === 'number') { sx += p[0]; sy += p[1]; n++; }
    });
    if (!n) return null;
    const ax = sx / n, ay = sy / n;
    if (Math.abs(ax) > 180 || Math.abs(ay) > 90) {
      const w = proj4("EPSG:32632", "EPSG:4326", [ax, ay]);
      return { lng: w[0], lat: w[1] };
    }
    return { lng: ax, lat: ay };
  } catch (err) { console.warn('Centroid error:', err); return null; }
}

function getProjectedCentroid(raw) {
  const c = getWGS84Centroid(raw);
  if (!c) return { x: 'N/A', y: 'N/A' };
  const u = proj4("EPSG:4326", "EPSG:32632", [c.lng, c.lat]);
  return { x: u[0].toFixed(2), y: u[1].toFixed(2) };
}

function getAllProjectedCoordinates(record) {
  const project = (raw) => {
    const ring = firstRing(raw);
    if (!ring) return [];
    return ring.map((pt, i) => {
      if (typeof pt[0] !== 'number' || typeof pt[1] !== 'number') return { index: i + 1, x: 'N/A', y: 'N/A' };
      if (Math.abs(pt[0]) > 180 || Math.abs(pt[1]) > 90) return { index: i + 1, x: pt[0].toFixed(2), y: pt[1].toFixed(2) };
      const u = proj4("EPSG:4326", "EPSG:32632", [pt[0], pt[1]]);
      return { index: i + 1, x: u[0].toFixed(2), y: u[1].toFixed(2) };
    });
  };
  const res = { parcel: [], building: [] };
  if (record.parcel_geom) res.parcel = project(record.parcel_geom);
  if (record.building_geom) res.building = project(record.building_geom);
  if (!res.parcel.length && !res.building.length && record.view_combined_geom)
    res.parcel = project(record.view_combined_geom);
  return res;
}

// ---------- 2. Map ----------
const map = L.map('map', { zoomControl: true, fadeAnimation: true }).setView([3.848, 11.502], 12);

const googleSatellite = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: 'Map data © Google' });
const googleHybrid = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', { maxZoom: 20, attribution: 'Map data © Google' });
const openStreetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors', subdomains: ['a', 'b', 'c'] });

googleSatellite.addTo(map);
L.control.layers({
  "Google Satellite": googleSatellite,
  "Google Satellite Hybrid": googleHybrid,
  "OpenStreetMap": openStreetMap
}).addTo(map);

const geojsonGroup = L.featureGroup().addTo(map);
let globalPermitData = [];
const layersMap = {};
let activePermitLayer = null;
let isShowingAllGeometries = false;

// Tracking state (declared ONCE)
const trackingLayerGroup = L.layerGroup().addTo(map);
let currentRoutingControl = null;
let activeWatchId = null;
let liveUserMarker = null;
let lastRouteFrom = null;

let currentSortColumn = null;
let isAscending = true;

// 3. Cursor UTM coordinates
map.on('mousemove', (e) => {
  const u = proj4("EPSG:4326", "EPSG:32632", [e.latlng.lng, e.latlng.lat]);
  const el = document.getElementById('coord-display');
  if (el) el.innerText = `UTM Zone 32N (EPSG:32632) | X: ${u[0].toFixed(2)} m E | Y: ${u[1].toFixed(2)} m N`;
});

function sortTableBy(columnKey) {
  if (currentSortColumn === columnKey) isAscending = !isAscending;
  else { currentSortColumn = columnKey; isAscending = true; }

  globalPermitData.sort((a, b) => {
    let A = (a[columnKey] || '').toString().toLowerCase();
    let B = (b[columnKey] || '').toString().toLowerCase();
    if (A !== '' && B !== '' && !isNaN(A) && !isNaN(B)) { A = parseFloat(A); B = parseFloat(B); }
    if (A < B) return isAscending ? -1 : 1;
    if (A > B) return isAscending ? 1 : -1;
    return 0;
  });
  renderTableAndMap(globalPermitData);
}

// 4. Load data
async function loadBuildingPermit(dbSource = 'local') {
  const tableBody = document.getElementById('permit-table-body');
  if (tableBody) tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;">Loading building permit data...</td></tr>`;

  const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname) || window.location.protocol === 'file:';
  const baseUrl = isLocal ? 'http://localhost:5000' : 'https://mbani.onrender.com';
  const endpoint = dbSource === 'cloud' ? `${baseUrl}/api/cloud-building-permit` : `${baseUrl}/api/building-permit`;

  try {
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
    globalPermitData = await response.json();
    renderTableAndMap(globalPermitData);
  } catch (error) {
    console.error('Error fetching data:', error);
    if (tableBody) tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:red;">Failed to load data from server. The server may be waking up (Render free plan), wait 30 seconds and refresh.</td></tr>`;
  }
}

// 5. Table + map objects
function renderTableAndMap(data) {
  const tableBody = document.getElementById('permit-table-body');
  if (!tableBody) return;

  tableBody.innerHTML = '';
  geojsonGroup.clearLayers();
  Object.keys(layersMap).forEach(k => delete layersMap[k]);
  activePermitLayer = null;
  isShowingAllGeometries = false;

  const toggleAllBtn = document.getElementById('toggleAllGeomBtn');
  if (toggleAllBtn) {
    toggleAllBtn.classList.remove('active');
    toggleAllBtn.innerHTML = '🌐 Show All Parcels & Footprints';
  }

  if (!data || data.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No records found.</td></tr>';
    return;
  }

  data.forEach((record, idx) => {
    const permitKey = (record.permit_id || record.permit_number || idx).toString();
    layersMap[permitKey] = record;

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${record.permit_number || 'N/A'}</strong></td>
      <td>${record.applicant_full_name || 'N/A'}</td>
      <td>${record.applicant_email || 'N/A'}</td>
      <td>${record.applicant_phone_number || record.applicant_phone || 'N/A'}</td>
      <td>${record.parcel_arrondissement || 'N/A'}</td>
      <td>${record.building_use || 'N/A'}</td>
      <td>
        <button class="btn-details" data-act="show">👁️ Show/Hide</button>
        <button class="btn-details" data-act="details">Details</button>
      </td>`;

    // Event listeners (safe even if permit keys contain quotes)
    row.querySelector('[data-act="show"]').addEventListener('click', (e) => { e.stopPropagation(); togglePermitOnMap(permitKey); });
    row.querySelector('[data-act="details"]').addEventListener('click', (e) => { e.stopPropagation(); showDetails(idx); });
    row.addEventListener('click', () => togglePermitOnMap(permitKey));
    tableBody.appendChild(row);
  });

  setTimeout(() => map.invalidateSize(), 200);
}

function makeLayer(rawGeom, style, title, titleColor, record, compliance, withUtm) {
  const geom = toWGS84Geom(rawGeom);
  if (!geom) return null;
  const layer = L.geoJSON(geom, { style });
  let utm = '';
  if (withUtm) {
    const c = getProjectedCentroid(rawGeom);
    utm = `<br><strong>UTM X:</strong> ${c.x} m E | <strong>Y:</strong> ${c.y} m N`;
  }
  layer.bindPopup(`
    <div style="font-size:13px;">
      <strong style="color:${titleColor};font-size:14px;">${title}</strong><br>
      <strong>Permit:</strong> ${record.permit_number || 'N/A'}<br>
      <strong>Applicant:</strong> ${record.applicant_full_name || 'N/A'}<br>
      <strong>Compliance:</strong> ${compliance.badgeHTML}${utm}
    </div>`);
  return layer;
}

const PARCEL_STYLE = { color: '#00d2ff', weight: 3, fillColor: '#00d2ff', fillOpacity: 0.35 };
const BUILDING_STYLE = { color: '#ffea00', weight: 2, fillColor: '#ffab00', fillOpacity: 0.7 };

function togglePermitOnMap(permitKey) {
  const record = layersMap[permitKey];
  if (!record) return;

  if (activePermitLayer && activePermitLayer.permitKey === permitKey) {
    geojsonGroup.clearLayers();
    activePermitLayer = null;
    return;
  }
  geojsonGroup.clearLayers();

  const group = L.featureGroup();
  const compliance = checkZoningCompliance(record);

  if (record.parcel_geom) {
    const l = makeLayer(record.parcel_geom, PARCEL_STYLE, 'Parcel Boundary', '#0284c7', record, compliance, true);
    if (l) l.addTo(group);
  }
  if (record.building_geom) {
    const l = makeLayer(record.building_geom, BUILDING_STYLE, 'Building Footprint', 'red', record, compliance, true);
    if (l) l.addTo(group);
  }
  if (!record.parcel_geom && !record.building_geom && record.view_combined_geom) {
    const l = makeLayer(record.view_combined_geom, { ...PARCEL_STYLE, weight: 2 }, 'Parcel / Building', '#0284c7', record, compliance, true);
    if (l) l.addTo(group);
  }

  if (group.getLayers().length > 0) {
    geojsonGroup.addLayer(group);
    activePermitLayer = group;
    activePermitLayer.permitKey = permitKey;
    map.fitBounds(group.getBounds(), { padding: [30, 30], maxZoom: 19, animate: true });
    group.openPopup();
  }
}

function toggleAllPermitsOnMap() {
  const btn = document.getElementById('toggleAllGeomBtn');

  if (isShowingAllGeometries) {
    geojsonGroup.clearLayers();
    activePermitLayer = null;
    isShowingAllGeometries = false;
    if (btn) { btn.classList.remove('active'); btn.innerHTML = '🌐 Show All Parcels & Footprints'; }
    return;
  }

  geojsonGroup.clearLayers();
  activePermitLayer = null;
  const all = L.featureGroup();

  Object.values(layersMap).forEach(record => {
    const compliance = checkZoningCompliance(record);
    const geoms = [
      [record.parcel_geom, { ...PARCEL_STYLE, weight: 2, fillOpacity: 0.3 }, 'Parcel Boundary', '#0284c7'],
      [record.building_geom, { ...BUILDING_STYLE, fillOpacity: 0.6 }, 'Building Footprint', 'red']
    ];
    geoms.forEach(([g, style, title, color]) => {
      if (!g) return;
      const l = makeLayer(g, style, title, color, record, compliance, false);
      if (l) l.addTo(all);
    });
  });

  if (all.getLayers().length > 0) {
    geojsonGroup.addLayer(all);
    map.fitBounds(all.getBounds(), { padding: [30, 30], animate: true });
    isShowingAllGeometries = true;
    if (btn) { btn.classList.add('active'); btn.innerHTML = '❌ Clear All Features'; }
  } else {
    alert("No spatial geometries found in the loaded database records.");
  }
}

// ---------- Details modal ----------
function showDetails(index) {
  const r = globalPermitData[index];
  if (!r) return;
  const modalBody = document.getElementById('modal-body');
  const modalTitle = document.getElementById('modal-title');
  if (modalTitle) modalTitle.innerText = `Building Permit Details: ${r.permit_number || r.permit_id || 'N/A'}`;

  const vertices = getAllProjectedCoordinates(r);
  const c = checkZoningCompliance(r);
  const zone = c.zoneUsed.toUpperCase();

  const issues = c.issuesList.length
    ? c.issuesList.map(i => `<li style="color:#c0392b;margin:4px 0;">⚠️ ${i}</li>`).join('')
    : `<li style="color:#16a34a;font-weight:bold;list-style:none;">✓ Passed all zoning rules for ${c.zoneUsed}</li>`;

  const item = (label, value) =>
    `<div class="details-item"><span>${label}</span>${value || value === 0 ? value : 'N/A'}</div>`;

  const vTable = (points, title) => {
    if (!points || !points.length)
      return `<div class="dx-box"><div class="dx-label">${title}</div><div style="font-size:16px;">N/A</div></div>`;
    return `
      <div class="dx-box">
        <div class="dx-label">${title} (${points.length} Vertices)</div>
        <div class="dx-scroll">
          <table class="vtable">
            <thead><tr><th>Point</th><th>UTM Easting (X)</th><th>UTM Northing (Y)</th></tr></thead>
            <tbody>${points.map(p => `<tr><td>P${p.index}</td><td>${p.x} m E</td><td>${p.y} m N</td></tr>`).join('')}</tbody>
          </table>
        </div>
      </div>`;
  };

  if (modalBody) {
    modalBody.innerHTML = `
      <div class="dx-header">Zoning Compliance Diagnosis</div>
      <div class="dx-box">
        <div class="dx-label">Status (${zone})</div>
        <div class="dx-badge" style="background:${c.isCompliant ? '#2ecc71' : '#e74c3c'};">
          ${c.isCompliant ? 'Compliant' : 'Non-Compliant'} (${zone})
        </div>
      </div>
      <div class="dx-box">
        <div class="dx-label">Regulatory Evaluation</div>
        <ul style="padding-left:18px;font-size:14px;">${issues}</ul>
      </div>

      <div class="dx-section">All Spatial Vertices (EPSG:32632 / UTM Zone 32N)</div>
      ${vTable(vertices.parcel, 'Parcel Boundary Vertices')}
      ${vTable(vertices.building, 'Building Footprint Vertices')}

      <div class="dx-section">Applicant Information</div>
      <div class="dx-grid">
        ${item('Full Name', r.applicant_full_name)}
        ${item('Email', r.applicant_email)}
        ${item('Phone', r.applicant_phone_number || r.applicant_phone)}
        ${item('NUI', r.applicant_nui)}
        ${item('Applicant Arrondissement', r.applicant_arrondissement)}
      </div>

      <div class="dx-section">Parcel Information</div>
      <div class="dx-grid">
        ${item('Land Title No', r.land_title_no)}
        ${item('Title Rec No', r.title_rec_no)}
        ${item('Parcel Arrondissement', r.parcel_arrondissement)}
        ${item('Cadastral Area', r.cadastral_area ? r.cadastral_area + ' m²' : '')}
      </div>

      <div class="dx-section">Building Permit Information</div>
      <div class="dx-grid">
        ${item('Permit Number', r.permit_number)}
        ${item('Building Use', r.building_use)}
        ${item('Floors Above Ground', r.floors_above_ground)}
        ${item('Underground Floors', r.floors_underground)}
        ${item('Height', r.height_m ? r.height_m + ' m' : '')}
        ${item('COS', r.cos)}
        ${item('CES', r.ces)}
        ${item('Estimated Cost', r.estimated_cost)}
        ${item('Parking Places', r.parking_place)}
        ${item('Area (sq m)', r.area_sq_m)}
      </div>`;
  }
  const modal = document.getElementById('detail-modal');
  if (modal) modal.style.display = 'flex';
}

function closeModal() {
  const modal = document.getElementById('detail-modal');
  if (modal) modal.style.display = 'none';
}

// 6. Zone info inspector
function displayZoneInfo(selectedZone) {
  const rules = ZONING_RULES[selectedZone] || ZONING_RULES['Default'];
  const el = document.getElementById('zone-info-display');
  if (el) el.innerHTML = `Max Height: <strong>${rules.maxHeightM}m</strong> | Max Floors: <strong>${rules.maxFloors}</strong> | Max CES: <strong>${Math.round(rules.maxCES * 100)}%</strong> | Max COS: <strong>${rules.maxCOS}</strong>`;
}

// 7. Mode toggle buttons
const togglePermitBtn = document.getElementById('togglePermitBtn');
const toggleTrackerBtn = document.getElementById('toggleTrackerBtn');
const permitSearchBox = document.getElementById('permitSearchBox');
const trackerSearchBox = document.getElementById('trackerSearchBox');

if (togglePermitBtn && toggleTrackerBtn) {
  togglePermitBtn.addEventListener('click', () => {
    permitSearchBox.style.display = 'block';
    trackerSearchBox.style.display = 'none';
    togglePermitBtn.style.background = '#0f172a'; togglePermitBtn.style.color = 'white';
    toggleTrackerBtn.style.background = '#e2e8f0'; toggleTrackerBtn.style.color = '#333';
  });
  toggleTrackerBtn.addEventListener('click', () => {
    trackerSearchBox.style.display = 'block';
    permitSearchBox.style.display = 'none';
    toggleTrackerBtn.style.background = '#2563eb'; toggleTrackerBtn.style.color = 'white';
    togglePermitBtn.style.background = '#e2e8f0'; togglePermitBtn.style.color = '#333';
  });
}

// General search filter
const searchInput = document.getElementById('search-input');
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    const fields = ['applicant_full_name', 'permit_number', 'land_title_no', 'title_rec_no', 'applicant_arrondissement', 'parcel_arrondissement', 'applicant_nui'];
    renderTableAndMap(globalPermitData.filter(r => fields.some(f => r[f] && r[f].toString().toLowerCase().includes(q))));
  });
}

// ================= 8. GPS TRACKER (phone + laptop safe) =================
const trackSearchInput = document.getElementById('track-search-input');
const trackGoBtn = document.getElementById('track-go-btn');

function clearTracking() {
  trackingLayerGroup.clearLayers();
  if (currentRoutingControl) { map.removeControl(currentRoutingControl); currentRoutingControl = null; }
  if (activeWatchId !== null) { navigator.geolocation.clearWatch(activeWatchId); activeWatchId = null; }
  liveUserMarker = null;
  lastRouteFrom = null;
}

function gpsErrorMessage(err) {
  if (err.code === 1) return "Location permission denied. Allow Location for this site in your browser settings and turn on GPS on your phone. If you opened the link inside WhatsApp/Facebook, open it in Chrome or Safari instead.";
  if (err.code === 2) return "Your position is unavailable. Turn on GPS / Location and try outdoors.";
  if (err.code === 3) return "GPS took too long. Please try again.";
  return "Unable to get your GPS position.";
}

function getTargetLatLng(record) {
  const geom = record.parcel_geom || record.building_geom || record.view_combined_geom;
  const c = getWGS84Centroid(geom);
  return c ? L.latLng(c.lat, c.lng) : null;
}

function drawRoute(from, to) {
  if (currentRoutingControl) { map.removeControl(currentRoutingControl); currentRoutingControl = null; }
  currentRoutingControl = L.Routing.control({
    waypoints: [from, to],
    routeWhileDragging: false,
    addWaypoints: false,
    draggableWaypoints: false,
    fitSelectedRoutes: false,
    show: false,
    createMarker: () => null,
    lineOptions: { styles: [{ color: '#2563eb', weight: 6, opacity: 0.8 }] }
  })
  .on('routingerror', () => {
    L.polyline([from, to], { color: '#2563eb', weight: 4, dashArray: '8,8' }).addTo(trackingLayerGroup);
  })
  .addTo(map);
}

function startLiveTracking(target, highAccuracy = true) {
  if (activeWatchId !== null) navigator.geolocation.clearWatch(activeWatchId);
  let firstFix = true;

  activeWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      const here = L.latLng(pos.coords.latitude, pos.coords.longitude);

      if (!liveUserMarker) {
        liveUserMarker = L.circleMarker(here, { radius: 9, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 })
          .bindPopup('📍 You are here').addTo(trackingLayerGroup);
      } else {
        liveUserMarker.setLatLng(here);
      }

      if (firstFix || !lastRouteFrom || here.distanceTo(lastRouteFrom) > 30) {
        lastRouteFrom = here;
        drawRoute(here, target);
      }
      if (firstFix) {
        map.fitBounds(L.latLngBounds([here, target]), { padding: [40, 40], maxZoom: 19 });
        firstFix = false;
      }
    },
    (err) => {
      if (err.code === 3 && highAccuracy) { startLiveTracking(target, false); return; }
      alert(gpsErrorMessage(err));
    },
    { enableHighAccuracy: highAccuracy, maximumAge: 5000, timeout: 20000 }
  );
}

// Not async: geolocation must be called directly inside the tap (iOS/Android)
function runTracker() {
  const query = (trackSearchInput.value || '').trim().toLowerCase();
  if (!query) return;
  trackSearchInput.blur();

  if (!('geolocation' in navigator)) { alert("Geolocation is not supported by this browser."); return; }

  // Search the full dataset (not only the filtered table)
  const record = globalPermitData.find(r =>
    (r.permit_number && r.permit_number.toLowerCase().includes(query)) ||
    (r.applicant_full_name && r.applicant_full_name.toLowerCase().includes(query)) ||
    (r.land_title_no && r.land_title_no.toLowerCase().includes(query)) ||
    (r.parcel_arrondissement && r.parcel_arrondissement.toLowerCase().includes(query))
  );
  if (!record) { alert("No matching permit or house found! (Is the data loaded?)"); return; }

  const target = getTargetLatLng(record);
  if (!target) { alert("This permit has no geometry to navigate to."); return; }

  clearTracking();

  // Make sure the record is in layersMap, then show it (without toggling it off)
  const idx = globalPermitData.indexOf(record);
  const key = (record.permit_id || record.permit_number || idx).toString();
  layersMap[key] = record;
  if (!activePermitLayer || activePermitLayer.permitKey !== key) togglePermitOnMap(key);

  L.marker(target).bindPopup('🏠 ' + (record.permit_number || 'Destination')).addTo(trackingLayerGroup);
  startLiveTracking(target, true);
}

if (trackGoBtn) trackGoBtn.addEventListener('click', runTracker);
if (trackSearchInput) {
  trackSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); runTracker(); }
  });
}

// Initial load
loadBuildingPermit('local');
