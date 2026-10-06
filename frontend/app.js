// ===== 1 & 1.1 Spatial Projections, Zoning Engine & Parsing Utilities =====
proj4.defs("EPSG:32632", "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs");
proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");

const ZONING_RULES = {
  'Yaoundé 1': { maxCES: 0.60, maxCOS: 2.0, maxFloors: 4, maxHeightM: 12.0 },
  'Yaoundé 2': { maxCES: 0.70, maxCOS: 2.5, maxFloors: 5, maxHeightM: 15.0 },
  'Yaoundé 3': { maxCES: 0.50, maxCOS: 1.5, maxFloors: 3, maxHeightM: 9.0  },
  'Yaoundé 4': { maxCES: 0.60, maxCOS: 2.0, maxFloors: 4, maxHeightM: 12.0 },
  'Yaoundé 5': { maxCES: 0.55, maxCOS: 1.8, maxFloors: 3, maxHeightM: 10.0 },
  'Yaoundé 6': { maxCES: 0.50, maxCOS: 1.5, maxFloors: 3, maxHeightM: 9.0  },
  'Yaoundé 7': { maxCES: 0.45, maxCOS: 1.2, maxFloors: 2, maxHeightM: 7.5  },
  'Default':   { maxCES: 0.60, maxCOS: 2.0, maxFloors: 4, maxHeightM: 12.0 }
};

function checkZoningCompliance(record) {
  const zoneName = record.parcel_arrondissement || record.quartier || 'Default';
  const rules = ZONING_RULES[zoneName] || ZONING_RULES.Default;
  const issues = [];

  const parcelArea = parseFloat(record.cadastral_area || 0);
  const buildingArea = parseFloat(record.area_sq_m || 0);
  const floors = parseInt(record.floors_above_ground || record.floors_above || 1, 10);
  const heightM = parseFloat(record.height_m || 0);

  if (heightM > 0 && heightM > rules.maxHeightM) {
    issues.push(`Height exceeds limit for ${zoneName} (${heightM}m vs max ${rules.maxHeightM}m)`);
  }
  if (floors > rules.maxFloors) {
    issues.push(`Floors exceed limit for ${zoneName} (${floors} floors vs max ${rules.maxFloors})`);
  }

  const computedCES = (parcelArea > 0 && buildingArea > 0) ? (buildingArea / parcelArea) : parseFloat(record.ces || 0);
  if (computedCES > rules.maxCES) {
    issues.push(`CES exceeds limit for ${zoneName} (${(computedCES * 100).toFixed(1)}% vs max ${rules.maxCES * 100}%)`);
  }

  const computedCOS = (parcelArea > 0 && buildingArea > 0) ? ((buildingArea * floors) / parcelArea) : parseFloat(record.cos || 0);
  if (computedCOS > rules.maxCOS) {
    issues.push(`COS exceeds limit for ${zoneName} (${computedCOS.toFixed(2)} vs max ${rules.maxCOS})`);
  }

  const isCompliant = issues.length === 0;
  return {
    isCompliant,
    zoneUsed: zoneName,
    rulesApplied: rules,
    badgeHTML: `<span style="background:${isCompliant ? '#2ecc71' : '#e74c3c'}; color:white; padding:3px 8px; border-radius:4px; font-weight:bold; font-size:11px;">${isCompliant ? 'Compliant' : 'Non-Compliant'} (${zoneName})</span>`,
    issuesList: issues
  };
}

function parseGeom(geom) {
  if (!geom) return null;
  if (typeof geom === 'string') {
    try { return JSON.parse(geom); } catch (e) { return null; }
  }
  return geom;
}

// 2. Initialize Leaflet Map
const map = L.map('map', {
  zoomControl: true,
  fadeAnimation: true
}).setView([3.848, 11.502], 12);

// Google Satellite Imagery
const googleSatellite = L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
  maxZoom: 20,
  attribution: 'Map data © Google',
  subdomains: ['0', '1', '2', '3']
});

// Google Hybrid Basemap
const googleHybrid = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
  maxZoom: 20,
  attribution: 'Map data © Google',
  subdomains: ['0', '1', '2', '3']
});

// OpenStreetMap Basemap
const openStreetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
  subdomains: ['a', 'b', 'c']
});

googleSatellite.addTo(map);

const baseLayers = {
  "Google Satellite": googleSatellite,
  "Google Satellite Hybrid": googleHybrid,
  "OpenStreetMap": openStreetMap
};
L.control.layers(baseLayers).addTo(map);

const geojsonGroup = L.featureGroup().addTo(map);
let globalPermitData = [];
const layersMap = {};
let activePermitLayer = null; 
let isShowingAllGeometries = false; 

// Routing control & tracking layer group
let trackingLayerGroup = L.layerGroup().addTo(map);
let currentRoutingControl = null;
let activeWatchId = null;     // Continuous geolocation watch ID
let liveUserMarker = null;    // Dynamic GPS marker instance

// Sorting state trackers
let currentSortColumn = null;
let isAscending = true;

// 3. Live Cursor Location Tracker (UTM Zone 32N coordinates)
map.on('mousemove', function(e) {
  const utmCoords = proj4("EPSG:4326", "EPSG:32632", [e.latlng.lng, e.latlng.lat]);
  const coordDisplay = document.getElementById('coord-display');
  if (coordDisplay) {
    coordDisplay.innerText = `UTM Zone 32N (EPSG:32632) | X: ${utmCoords[0].toFixed(2)} m E | Y: ${utmCoords[1].toFixed(2)} m N`;
  }
});

function sortTableBy(columnKey) {
  if (currentSortColumn === columnKey) {
    isAscending = !isAscending;
  } else {
    currentSortColumn = columnKey;
    isAscending = true;
  }

  globalPermitData.sort((a, b) => {
    let valA = (a[columnKey] || '').toString().toLowerCase();
    let valB = (b[columnKey] || '').toString().toLowerCase();

    if (!isNaN(valA) && !isNaN(valB) && valA !== '' && valB !== '') {
      valA = parseFloat(valA);
      valB = parseFloat(valB);
    }

    if (valA < valB) return isAscending ? -1 : 1;
    if (valA > valB) return isAscending ? 1 : -1;
    return 0;
  });

  renderTableAndMap(globalPermitData);
}

/**
 * Robust Centroid Calculation with Projection Auto-Detection (UTM 32N -> WGS84)
 */
function getWGS84Centroid(rawGeom) {
  const geojson = parseGeom(rawGeom);
  if (!geojson) return null;
  try {
    let coords = geojson.coordinates;
    if (geojson.type === 'GeometryCollection' && geojson.geometries && geojson.geometries.length > 0) {
      coords = geojson.geometries[0].coordinates;
    }
    if (!coords) return null;

    while (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
      coords = coords[0];
    }

    let sumX = 0, sumY = 0, count = 0;
    for (let i = 0; i < coords.length; i++) {
      if (typeof coords[i][0] === 'number' && typeof coords[i][1] === 'number') {
        sumX += coords[i][0];
        sumY += coords[i][1];
        count++;
      }
    }

    if (count > 0) {
      const avgX = sumX / count;
      const avgY = sumY / count;

      // Auto-detect UTM projected coordinates (EPSG:32632) vs WGS84
      if (Math.abs(avgX) > 180 || Math.abs(avgY) > 90) {
        const wgs = proj4("EPSG:32632", "EPSG:4326", [avgX, avgY]);
        return { lng: wgs[0], lat: wgs[1] };
      }

      return { lng: avgX, lat: avgY };
    }
  } catch (err) {
    console.warn('Centroid calculation error:', err);
  }
  return null;
}

function getProjectedCentroid(geojson) {
  const center = getWGS84Centroid(geojson);
  if (!center) return { x: 'N/A', y: 'N/A' };
  const utm = proj4("EPSG:4326", "EPSG:32632", [center.lng, center.lat]);
  return { x: utm[0].toFixed(2), y: utm[1].toFixed(2) };
}

function getAllProjectedCoordinates(record) {
  const result = { parcel: [], building: [] };
  
  function extractAndProjectPoints(rawGeom) {
    const geojson = parseGeom(rawGeom);
    if (!geojson) return [];
    try {
      let coords = geojson.type === 'GeometryCollection' && geojson.geometries.length > 0 
        ? geojson.geometries[0].coordinates 
        : geojson.coordinates;
      if (!coords) return [];

      while (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
        coords = coords[0];
      }

      return coords.map((pt, i) => {
        if (typeof pt[0] === 'number' && typeof pt[1] === 'number') {
          if (Math.abs(pt[0]) > 180 || Math.abs(pt[1]) > 90) {
            return { index: i + 1, x: pt[0].toFixed(2), y: pt[1].toFixed(2) };
          }
          const utm = proj4("EPSG:4326", "EPSG:32632", [pt[0], pt[1]]);
          return { index: i + 1, x: utm[0].toFixed(2), y: utm[1].toFixed(2) };
        }
        return { index: i + 1, x: 'N/A', y: 'N/A' };
      });
    } catch (e) {
      return [];
    }
  }

  if (record.parcel_geom) result.parcel = extractAndProjectPoints(record.parcel_geom);
  if (record.building_geom) result.building = extractAndProjectPoints(record.building_geom);
  if (result.parcel.length === 0 && result.building.length === 0 && record.view_combined_geom) {
    result.parcel = extractAndProjectPoints(record.view_combined_geom);
  }
  return result;
}

// 4. Fetch Spatial Data from Backend
async function loadBuildingPermit(dbSource = 'local') {
  const tableBody = document.getElementById('permit-table-body');
  if (tableBody) {
    tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;">Loading building permit data...</td></tr>`;
  }

  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' || window.location.protocol === 'file:';
  const baseUrl = isLocal ? 'http://localhost:5000' : 'https://mbani.onrender.com';

  const endpoint = dbSource === 'cloud' 
    ? `${baseUrl}/api/cloud-building-permit` 
    : `${baseUrl}/api/building-permit`;

  try {
    const response = await fetch(endpoint);
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

    globalPermitData = await response.json();
    renderTableAndMap(globalPermitData);
  } catch (error) {
    console.error('Error fetching data:', error);
    if (tableBody) {
      tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: red;">Failed to load data from server. Ensure backend API is active on port 5000.</td></tr>`;
    }
  }
}

// 5. Render Data into Table & Prepare Spatial Map Objects
function renderTableAndMap(data) {
  const tableBody = document.getElementById('permit-table-body');
  if (!tableBody) return;
  
  tableBody.innerHTML = '';
  
  geojsonGroup.clearLayers();
  Object.keys(layersMap).forEach(key => delete layersMap[key]);
  if (activePermitLayer) {
    map.removeLayer(activePermitLayer);
    activePermitLayer = null;
  }
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
        <button class="btn-details" onclick="event.stopPropagation(); togglePermitOnMap('${permitKey}')">👁️ Show/Hide</button>
        <button class="btn-details" onclick="event.stopPropagation(); showDetails(${idx})">Details</button>
      </td>
    `;
    
    row.onclick = () => {
      togglePermitOnMap(permitKey);
    };
    
    tableBody.appendChild(row);
  });

  setTimeout(() => {
    map.invalidateSize();
  }, 200);
}

/**
 * Toggle Parcel / Building Footprint On-Click
 */
function togglePermitOnMap(permitKey) {
  const record = layersMap[permitKey];
  if (!record) return;

  if (activePermitLayer && activePermitLayer.permitKey === permitKey) {
    geojsonGroup.clearLayers();
    activePermitLayer = null;
    return;
  }

  geojsonGroup.clearLayers();

  const permitGroup = L.featureGroup();
  const compliance = checkZoningCompliance(record);

  function createGeoJsonLayer(rawGeom, style) {
    const parsed = parseGeom(rawGeom);
    if (!parsed) return null;

    let targetGeom = parsed;
    const centroid = getWGS84Centroid(parsed);
    if (centroid) {
      try {
        const reprojectCoords = (coords) => {
          if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            if (Math.abs(coords[0]) > 180 || Math.abs(coords[1]) > 90) {
              return proj4("EPSG:32632", "EPSG:4326", [coords[0], coords[1]]);
            }
            return coords;
          }
          return coords.map(reprojectCoords);
        };
        targetGeom = JSON.parse(JSON.stringify(parsed));
        targetGeom.coordinates = reprojectCoords(targetGeom.coordinates);
      } catch (e) {
        targetGeom = parsed;
      }
    }

    return L.geoJSON(targetGeom, { style });
  }

  if (record.parcel_geom) {
    const parcelLayer = createGeoJsonLayer(record.parcel_geom, { color: '#00d2ff', weight: 3, fillColor: '#00d2ff', fillOpacity: 0.35 });
    if (parcelLayer) {
      const utmParcel = getProjectedCentroid(record.parcel_geom);
      parcelLayer.bindPopup(`
        <div style="font-size:13px;">
          <strong style="color: #0284c7; font-size: 14px;">Parcel Boundary</strong><br>
          <strong>Permit:</strong> ${record.permit_number || 'N/A'}<br>
          <strong>Applicant:</strong> ${record.applicant_full_name || 'N/A'}<br>
          <strong>Compliance:</strong> ${compliance.badgeHTML}<br>
          <strong>UTM X:</strong> ${utmParcel.x} m E | <strong>Y:</strong> ${utmParcel.y} m N
        </div>
      `);
      parcelLayer.addTo(permitGroup);
    }
  }

  if (record.building_geom) {
    const buildingLayer = createGeoJsonLayer(record.building_geom, { color: '#ffea00', weight: 2, fillColor: '#ffab00', fillOpacity: 0.7 });
    if (buildingLayer) {
      const utmBuilding = getProjectedCentroid(record.building_geom);
      buildingLayer.bindPopup(`
        <div style="font-size:13px;">
          <strong style="color: red; font-size: 14px;">Building Footprint</strong><br>
          <strong>Permit:</strong> ${record.permit_number || 'N/A'}<br>
          <strong>Applicant:</strong> ${record.applicant_full_name || 'N/A'}<br>
          <strong>Compliance:</strong> ${compliance.badgeHTML}<br>
          <strong>UTM X:</strong> ${utmBuilding.x} m E | <strong>Y:</strong> ${utmBuilding.y} m N
        </div>
      `);
      buildingLayer.addTo(permitGroup);
    }
  }

  if (!record.parcel_geom && !record.building_geom && record.view_combined_geom) {
    const combinedLayer = createGeoJsonLayer(record.view_combined_geom, { color: '#00d2ff', weight: 2, fillColor: '#00d2ff', fillOpacity: 0.35 });
    if (combinedLayer) {
      const utmCombined = getProjectedCentroid(record.view_combined_geom);
      combinedLayer.bindPopup(`
        <div style="font-size:13px;">
          <strong style="color: #0284c7; font-size: 14px;">Parcel / Building</strong><br>
          <strong>Permit:</strong> ${record.permit_number || 'N/A'}<br>
          <strong>Applicant:</strong> ${record.applicant_full_name || 'N/A'}<br>
          <strong>Compliance:</strong> ${compliance.badgeHTML}<br>
          <strong>UTM X:</strong> ${utmCombined.x} m E | <strong>Y:</strong> ${utmCombined.y} m N
        </div>
      `);
      combinedLayer.addTo(permitGroup);
    }
  }

  if (permitGroup.getLayers().length > 0) {
    geojsonGroup.addLayer(permitGroup);
    activePermitLayer = permitGroup;
    activePermitLayer.permitKey = permitKey;

    map.fitBounds(permitGroup.getBounds(), { padding: [30, 30], maxZoom: 19, animate: true });
    permitGroup.openPopup();
  }
}

/**
 * Global Map Toggle: Display/Hide All Loaded Parcels
 */
function toggleAllPermitsOnMap() {
  const toggleBtn = document.getElementById('toggleAllGeomBtn');

  if (isShowingAllGeometries) {
    geojsonGroup.clearLayers();
    activePermitLayer = null;
    isShowingAllGeometries = false;
    if (toggleBtn) {
      toggleBtn.classList.remove('active');
      toggleBtn.innerHTML = '🌐 Show All Parcels & Footprints';
    }
    return;
  }

  geojsonGroup.clearLayers();
  activePermitLayer = null;

  const allGroup = L.featureGroup();

  Object.values(layersMap).forEach(record => {
    const compliance = checkZoningCompliance(record);
    const parcelGeom = parseGeom(record.parcel_geom);
    const buildingGeom = parseGeom(record.building_geom);

    if (parcelGeom) {
      const parcelLayer = L.geoJSON(parcelGeom, { style: { color: '#00d2ff', weight: 2, fillColor: '#00d2ff', fillOpacity: 0.3 } });
      parcelLayer.bindPopup(`
        <div style="font-size:13px;">
          <strong>Permit:</strong> ${record.permit_number || 'N/A'}<br>
          <strong>Applicant:</strong> ${record.applicant_full_name || 'N/A'}<br>
          <strong>Compliance:</strong> ${compliance.badgeHTML}
        </div>
      `);
      parcelLayer.addTo(allGroup);
    }

    if (buildingGeom) {
      const buildingLayer = L.geoJSON(buildingGeom, { style: { color: '#ffea00', weight: 2, fillColor: '#ffab00', fillOpacity: 0.6 } });
      buildingLayer.bindPopup(`
        <div style="font-size:13px;">
          <strong>Building Footprint</strong><br>
          <strong>Permit:</strong> ${record.permit_number || 'N/A'}<br>
          <strong>Applicant:</strong> ${record.applicant_full_name || 'N/A'}
        </div>
      `);
      buildingLayer.addTo(allGroup);
    }
  });

  if (allGroup.getLayers().length > 0) {
    geojsonGroup.addLayer(allGroup);
    map.fitBounds(allGroup.getBounds(), { padding: [30, 30], animate: true });
    isShowingAllGeometries = true;
    if (toggleBtn) {
      toggleBtn.classList.add('active');
      toggleBtn.innerHTML = '❌ Clear All Features';
    }
  } else {
    alert("No spatial geometries found in the loaded database records.");
  }
}

function showDetails(index) {
  const r = globalPermitData[index];
  const modalBody = document.getElementById('modal-body');
  const modalTitle = document.getElementById('modal-title');

  if (modalTitle) modalTitle.innerText = `Building Permit Details: ${r.permit_number || 'N/A'}`;

  const vertices = getAllProjectedCoordinates(r);
  const compliance = checkZoningCompliance(r);

  const issuesMarkup = compliance.issuesList.length > 0 
    ? compliance.issuesList.map(issue => `<li style="color:#e74c3c; margin-bottom:2px; font-weight:500;">⚠️ ${issue}</li>`).join('')
    : `<li style="color:#2ecc71; font-weight:bold; list-style-type:none;">✓ Passed all zoning rules for ${compliance.zoneUsed}</li>`;

  const renderTable = (points, title) => {
    if (!points || points.length === 0) return `<div class="details-item" style="grid-column: span 2;"><span>${title}</span>N/A</div>`;
    return `
      <div class="details-item" style="grid-column: span 2;">
        <span>${title} (${points.length} Vertices)</span>
        <div style="max-height: 130px; overflow-y: auto; margin-top: 6px; border: 1px solid #e2e8f0; border-radius: 4px;">
          <table style="width: 100%; border-collapse: collapse; font-size: 11px; text-align: left;">
            <thead style="background-color: #f1f5f9; position: sticky; top: 0;">
              <tr>
                <th style="padding: 4px 8px; border-bottom: 1px solid #e2e8f0;">Point</th>
                <th style="padding: 4px 8px; border-bottom: 1px solid #e2e8f0;">UTM Easting (X)</th>
                <th style="padding: 4px 8px; border-bottom: 1px solid #e2e8f0;">UTM Northing (Y)</th>
              </tr>
            </thead>
            <tbody>
              ${points.map(pt => `
                <tr>
                  <td style="padding: 3px 8px; border-bottom: 1px solid #f8fafc;">P${pt.index}</td>
                  <td style="padding: 3px 8px; border-bottom: 1px solid #f8fafc;">${pt.x} m E</td>
                  <td style="padding: 3px 8px; border-bottom: 1px solid #f8fafc;">${pt.y} m N</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  };

  if (modalBody) {
    modalBody.innerHTML = `
      <div class="details-section" style="background:#0f172a; color:white; padding:6px 8px; font-weight:bold; border-radius:4px;">Zoning Compliance Diagnosis</div>
      <div class="details-item"><span>Status (${compliance.zoneUsed})</span>${compliance.badgeHTML}</div>
      <div class="details-item" style="grid-column: span 2;">
        <span>Regulatory Evaluation</span>
        <ul style="margin: 4px 0 0 16px; padding:0; font-size:12px;">
          ${issuesMarkup}
        </ul>
      </div>

      <div class="details-section">All Spatial Vertices (EPSG:32632 / UTM Zone 32N)</div>
      ${renderTable(vertices.parcel, 'Parcel Boundary Vertices')}
      ${renderTable(vertices.building, 'Building Footprint Vertices')}

      <div class="details-section">Applicant Information</div>
      <div class="details-item"><span>Full Name</span>${r.applicant_full_name || 'N/A'}</div>
      <div class="details-item"><span>NUI</span>${r.applicant_nui || 'N/A'}</div>
      <div class="details-item"><span>Phone</span>${r.applicant_phone_number || r.applicant_phone || 'N/A'}</div>
      <div class="details-item"><span>Email</span>${r.applicant_email || 'N/A'}</div>
      <div class="details-item" style="grid-column: span 2;"><span>Address</span>${r.applicant_address || 'N/A'}</div>

      <div class="details-section">Permit & Parcel Details</div>
      <div class="details-item"><span>Permit No</span>${r.permit_number || 'N/A'}</div>
      <div class="details-item"><span>Dossier No</span>${r.no_du_dossier || r.title_rec_no || 'N/A'}</div>
      <div class="details-item"><span>Status</span>${r.status || r.permit_status || 'N/A'}</div>
      <div class="details-item"><span>Deposit Date</span>${r.date_de_depot || r.input_database_date || 'N/A'}</div>
      <div class="details-item"><span>Land Title No</span>${r.land_title_no || r.title_rec_no || 'N/A'}</div>
      <div class="details-item"><span>Quarter</span>${r.parcel_quarter || r.quartier || 'N/A'}</div>
      <div class="details-item"><span>Arrondissement</span>${r.parcel_arrondissement || 'N/A'}</div>
      <div class="details-item"><span>Cadastral Area</span>${r.cadastral_area ? r.cadastral_area + ' m²' : 'N/A'}</div>
      
      <div class="details-section">Building Parameters</div>
      <div class="details-item"><span>Building Use</span>${r.building_use || 'N/A'}</div>
      <div class="details-item"><span>Floors Above Ground</span>${r.floors_above_ground || 'N/A'}</div>
      <div class="details-item"><span>Underground Floors</span>${r.floors_underground || 'N/A'}</div>
      <div class="details-item"><span>Height</span>${r.height_m ? r.height_m + ' m' : 'N/A'}</div>
      <div class="details-item"><span>COS</span>${r.cos || 'N/A'}</div>
      <div class="details-item"><span>CES</span>${r.ces || 'N/A'}</div>
      <div class="details-item"><span>Estimated Cost</span>${r.estimated_cost || 'N/A'}</div>
      <div class="details-item"><span>Parking Places</span>${r.parking_place || 'N/A'}</div>
      <div class="details-item"><span>Area</span>${r.area_sq_m ? r.area_sq_m + ' m²' : 'N/A'}</div>
    `;
  }
  const detailModal = document.getElementById('detail-modal');
  if (detailModal) detailModal.style.display = 'flex';
}

function closeModal() {
  const detailModal = document.getElementById('detail-modal');
  if (detailModal) detailModal.style.display = 'none';
}

// 6. Zone Info Inspector Listener
function displayZoneInfo(selectedZone) {
  const rules = ZONING_RULES[selectedZone] || ZONING_RULES['Default'];
  const infoDisplay = document.getElementById('zone-info-display');
  if (infoDisplay) {
    infoDisplay.innerHTML = `
      Max Height: <strong>${rules.maxHeightM}m</strong> | 
      Max Floors: <strong>${rules.maxFloors}</strong> | 
      Max CES: <strong>${rules.maxCES * 100}%</strong> | 
      Max COS: <strong>${rules.maxCOS}</strong>
    `;
  }
}

// 7. Toggle Search Mode Buttons
const togglePermitBtn = document.getElementById('togglePermitBtn');
const toggleTrackerBtn = document.getElementById('toggleTrackerBtn');
const permitSearchBox = document.getElementById('permitSearchBox');
const trackerSearchBox = document.getElementById('trackerSearchBox');

if (togglePermitBtn && toggleTrackerBtn) {
  togglePermitBtn.addEventListener('click', () => {
    permitSearchBox.style.display = 'block';
    trackerSearchBox.style.display = 'none';
    
    togglePermitBtn.style.background = '#0f172a';
    togglePermitBtn.style.color = 'white';
    
    toggleTrackerBtn.style.background = '#e2e8f0';
    toggleTrackerBtn.style.color = '#333';
  });

  toggleTrackerBtn.addEventListener('click', () => {
    trackerSearchBox.style.display = 'block';
    permitSearchBox.style.display = 'none';
    
    toggleTrackerBtn.style.background = '#2563eb';
    toggleTrackerBtn.style.color = 'white';
    
    togglePermitBtn.style.background = '#e2e8f0';
    togglePermitBtn.style.color = '#333';
  });
}

// General Search Input Handler (With Auto-Zoom on Single Match)
const searchInput = document.getElementById('search-input');
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    if (!query) {
      renderTableAndMap(globalPermitData);
      return;
    }

    const filtered = globalPermitData.filter(r => 
      (r.applicant_full_name && r.applicant_full_name.toLowerCase().includes(query)) ||
      (r.permit_number && r.permit_number.toLowerCase().includes(query)) ||
      (r.land_title_no && r.land_title_no.toLowerCase().includes(query)) ||
      (r.title_rec_no && r.title_rec_no.toLowerCase().includes(query)) ||
      (r.applicant_arrondissement && r.applicant_arrondissement.toLowerCase().includes(query)) ||
      (r.parcel_arrondissement && r.parcel_arrondissement.toLowerCase().includes(query)) ||
      (r.applicant_nui && r.applicant_nui.toLowerCase().includes(query))
    );

    renderTableAndMap(filtered);

    // Auto-zoom onto target footprint if search yields exactly 1 result
    if (filtered.length === 1) {
      const matchKey = (filtered[0].permit_id || filtered[0].permit_number).toString();
      togglePermitOnMap(matchKey);
    }
  });
}

// 8. REAL-TIME LIVE GPS TRACKER & ROAD-FOLLOWING ROUTING ENGINE
const trackSearchInput = document.getElementById('track-search-input');

if (trackSearchInput) {
  trackSearchInput.addEventListener('keypress', async function (e) {
    if (e.key === 'Enter') {
      const query = e.target.value.trim().toLowerCase();
      if (!query) return;

      // Stop any existing live geolocation watcher
      if (activeWatchId !== null) {
        navigator.geolocation.clearWatch(activeWatchId);
        activeWatchId = null;
      }

      // Clear previous tracking layers & controls
      trackingLayerGroup.clearLayers();
      liveUserMarker = null;

      if (currentRoutingControl) {
        try { map.removeControl(currentRoutingControl); } catch (err) {}
        currentRoutingControl = null;
      }

      // Reset "Show All" state if active to prevent state overlap
      if (isShowingAllGeometries) {
        const toggleBtn = document.getElementById('toggleAllGeomBtn');
        isShowingAllGeometries = false;
        if (toggleBtn) {
          toggleBtn.classList.remove('active');
          toggleBtn.innerHTML = '🌐 Show All Parcels & Footprints';
        }
      }

      // Find matching record by Permit No, Applicant Name, or Land Title
      const matchedRecord = globalPermitData.find(r => 
        (r.permit_number && r.permit_number.toLowerCase().includes(query)) ||
        (r.applicant_full_name && r.applicant_full_name.toLowerCase().includes(query)) ||
        (r.land_title_no && r.land_title_no.toLowerCase().includes(query)) ||
        (r.title_rec_no && r.title_rec_no.toLowerCase().includes(query)) ||
        (r.parcel_arrondissement && r.parcel_arrondissement.toLowerCase().includes(query))
      );

      if (!matchedRecord) {
        alert("No matching building permit, house, or land title record found for: " + query);
        return;
      }

      const key = (matchedRecord.permit_id || matchedRecord.permit_number || '').toString();
      togglePermitOnMap(key);

      const rawTargetGeom = matchedRecord.parcel_geom || matchedRecord.building_geom || matchedRecord.view_combined_geom;
      const targetCentroid = getWGS84Centroid(rawTargetGeom);

      if (!targetCentroid) {
        alert("This record does not have valid geometry coordinates to calculate a road route.");
        return;
      }

      // Helper function to initialize road route calculation
      const calculateRoute = (originLat, originLng, isGps = true) => {
        // User Location Pulsing Marker (Dynamic instance)
        liveUserMarker = L.circleMarker([originLat, originLng], {
          radius: 10,
          fillColor: isGps ? '#2563eb' : '#f59e0b',
          color: '#ffffff',
          weight: 3,
          opacity: 1,
          fillOpacity: 0.95
        }).bindPopup(`<b>${isGps ? '📍 Live GPS Location (Active)' : '📍 Fallback Origin (Hôtel de Ville, Yaoundé)'}</b>`);

        trackingLayerGroup.addLayer(liveUserMarker);

        // OSRM Road Router Engine with Navigation Instructions Panel
        currentRoutingControl = L.Routing.control({
          waypoints: [
            L.latLng(originLat, originLng),
            L.latLng(targetCentroid.lat, targetCentroid.lng)
          ],
          router: L.Routing.osrmv1({
            serviceUrl: 'https://router.project-osrm.org/route/v1'
          }),
          routeWhileDragging: false,
          addWaypoints: false,
          draggableWaypoints: false,
          fitSelectedRoutes: true,
          show: true,
          createMarker: function(i, wp) {
            if (i === 0) return liveUserMarker;
            return L.marker(wp.latLng, {
              title: "Destination Site"
            }).bindPopup(`
              <div style="font-size:13px;">
                <strong style="color:#2563eb;">🎯 Destination</strong><br>
                <strong>Permit:</strong> ${matchedRecord.permit_number || 'N/A'}<br>
                <strong>Applicant:</strong> ${matchedRecord.applicant_full_name || 'N/A'}
              </div>
            `);
          },
          lineOptions: {
            styles: [{ color: '#2563eb', weight: 6, opacity: 0.85 }]
          }
        }).addTo(map);
      };

      // Continuous Real-Time Geolocation Tracking (Yango / Navigation Style)
      if (navigator.geolocation) {
        const gpsOptions = {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0
        };

        // 1. Initial Position Fix
        navigator.geolocation.getCurrentPosition(
          (position) => {
            const initialLat = position.coords.latitude;
            const initialLng = position.coords.longitude;

            calculateRoute(initialLat, initialLng, true);

            // 2. Active Continuous Location Watcher
            activeWatchId = navigator.geolocation.watchPosition(
              (pos) => {
                const liveLat = pos.coords.latitude;
                const liveLng = pos.coords.longitude;

                // Move user marker live as you walk or drive
                if (liveUserMarker) {
                  liveUserMarker.setLatLng([liveLat, liveLng]);
                }

                // Update route origin waypoint dynamically
                if (currentRoutingControl) {
                  currentRoutingControl.spliceWaypoints(0, 1, L.latLng(liveLat, liveLng));
                }
              },
              (err) => {
                console.warn("Live GPS position update failed:", err);
              },
              gpsOptions
            );
          },
          (error) => {
            let errorMsg = "GPS access unavailable. Defaulting route origin to Hôtel de Ville de Yaoundé.";
            if (error.code === error.PERMISSION_DENIED) {
              errorMsg = "GPS access denied. Please enable location permissions on your phone.";
            } else if (error.code === error.TIMEOUT) {
              errorMsg = "GPS request timed out. Make sure GPS is turned ON on your phone.";
            }
            console.warn("GPS Location Access Failed/Denied:", error);
            alert(errorMsg);

            // Fallback origin: Hôtel de Ville de Yaoundé (3.8666, 11.5167)
            calculateRoute(3.8666, 11.5167, false);
          },
          gpsOptions
        );
      } else {
        calculateRoute(3.8666, 11.5167, false);
      }
    }
  });
}

// Initial Data Load
loadBuildingPermit('local');
