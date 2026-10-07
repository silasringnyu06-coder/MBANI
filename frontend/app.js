// ================= MBANI WebGIS - app.js =================
// 1. Register Spatial Projection Definitions
proj4.defs("EPSG:32632", "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs");
proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");

// 1.1 Zoning rules & compliance logic
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
  const rawZone = record.parcel_arrondissement || record.quartier || 'Default';
  let zoneName = 'Default';
  if (rawZone.match(/1/)) zoneName = 'Yaoundé 1';
  else if (rawZone.match(/2/)) zoneName = 'Yaoundé 2';
  else if (rawZone.match(/3/)) zoneName = 'Yaoundé 3';
  else if (rawZone.match(/4/)) zoneName = 'Yaoundé 4';
  else if (rawZone.match(/5/)) zoneName = 'Yaoundé 5';
  else if (rawZone.match(/6/)) zoneName = 'Yaoundé 6';
  else if (rawZone.match(/7/)) zoneName = 'Yaoundé 7';

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
    badgeHTML: `<span style="background:${isCompliant ? '#2ecc71' : '#e74c3c'}; color:white; padding:3px 8px; border-radius:4px; font-weight:bold; font-size:11px; white-space:nowrap;">${isCompliant ? 'Compliant' : 'Non-Compliant'} (${zoneName})</span>`,
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

// 2. Initialize Leaflet Map (Centered over Yaoundé, Cameroon)
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
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    subdomains: ['a', 'b', 'c']
});

googleSatellite.addTo(map);

const baseLayers = {
  "Google Satellite": googleSatellite,
  "Google Satellite Hybrid": googleHybrid
};
L.control.layers(baseLayers).addTo(map);

const geojsonGroup = L.featureGroup().addTo(map);
let globalPermitData = [];
const layersMap = {};

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

/**
 * Table Sorting Helper Function (Ascending / Descending)
 */
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

    // Numeric comparison if values are numbers
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
 * Since server coordinates are stored/returned as WGS84 (EPSG:4326) [lng, lat],
 * Leaflet needs them as-is. But for the modal table, we want to convert them 
 * BACK to projected UTM Zone 32N (EPSG:32632).
 */
function getProjectedCentroid(geojson) {
  if (!geojson) return { x: 'N/A', y: 'N/A' };
  try {
    let coords = geojson.coordinates;
    if (geojson.type === 'GeometryCollection' && geojson.geometries.length > 0) {
      coords = geojson.geometries[0].coordinates;
    }
    if (!coords) return { x: 'N/A', y: 'N/A' };

    while (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
      coords = coords[0];
    }

    let sumX = 0, sumY = 0, count = 0;
    for (let i = 0; i < coords.length; i++) {
      if (typeof coords[i][0] === 'number' && typeof coords[i][1] === 'number') {
        // Transform from server's [lng, lat] to UTM Zone 32N
        const utm = proj4("EPSG:4326", "EPSG:32632", [coords[i][0], coords[i][1]]);
        sumX += utm[0];
        sumY += utm[1];
        count++;
      }
    }

    if (count > 0) {
      return { x: (sumX / count).toFixed(2), y: (sumY / count).toFixed(2) };
    }
  } catch (err) {
    console.warn('Centroid error:', err);
  }
  return { x: 'N/A', y: 'N/A' };
}

function getAllProjectedCoordinates(record) {
  const result = { parcel: [], building: [] };
  
  function extractAndProjectPoints(geojson) {
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
          // Convert server [lng, lat] to UTM Zone 32N [Easting, Northing]
          const utm = proj4("EPSG:4326", "EPSG:32632", [pt[0], pt[1]]);
          return {
            index: i + 1,
            x: utm[0].toFixed(2),
            y: utm[1].toFixed(2)
          };
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
    tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center;">Loading building permit data from ${dbSource} database...</td></tr>`;
  }

  // Forces local backend usage when running locally or straight from file explorer
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
      tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: red;">Failed to load data from ${dbSource} server. Make sure backend is running on port 5000.</td></tr>`;
    }
  }
}

// 5. Render Data into Table and Map
function renderTableAndMap(data) {
  const tableBody = document.getElementById('permit-table-body');
  if (!tableBody) return;
  
  tableBody.innerHTML = '';
  geojsonGroup.clearLayers();
  Object.keys(layersMap).forEach(key => delete layersMap[key]);

  if (!data || data.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No records found.</td></tr>';
    return;
  }

  data.forEach((record, idx) => {
    const compliance = checkZoningCompliance(record);
    const status = (record.status || record.permit_status || '').toLowerCase();
    let badgeClass = 'status-badge status-pending';
    if (status.includes('approv') || status.includes('valide')) badgeClass = 'status-badge status-approved';
    else if (status.includes('reject') || status.includes('refus')) badgeClass = 'status-badge status-rejected';

    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${record.permit_number || 'N/A'}</strong></td>
      <td>${record.applicant_full_name || 'N/A'}</td>
      <td>${record.applicant_email || 'N/A'}</td>
      <td>${record.applicant_phone_number || record.applicant_phone || 'N/A'}</td>
      <td>${record.parcel_arrondissement || 'N/A'}</td>
      <td>
        <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
          <span>${record.building_use || 'N/A'}</span>
          ${compliance.badgeHTML}
        </div>
      </td>
      <td><button class="btn-details" onclick="event.stopPropagation(); showDetails(${idx})">View All</button></td>
    `;
    
    const permitGroup = L.featureGroup();

    // Render Parcel Geometry with "Parcel" Popup Header
    if (record.parcel_geom) {
      const parsedParcelGeom = parseGeom(record.parcel_geom);
      if (parsedParcelGeom) {
        const parcelLayer = L.geoJSON(parsedParcelGeom, {
          style: { color: '#00d2ff', weight: 3, fillColor: '#00d2ff', fillOpacity: 0.25 }
        });

        const utmParcel = getProjectedCentroid(parsedParcelGeom);
        parcelLayer.bindPopup(`
          <div style="font-size:13px;">
            <strong style="color: #0284c7; font-size: 14px;">Parcel</strong><br>
            <strong>Permit:</strong> ${record.permit_number || 'N/A'}<br>
            <strong>Applicant:</strong> ${record.applicant_full_name || 'N/A'}<br>
            <strong>Zoning:</strong> ${compliance.badgeHTML}<br>
            <strong>Center UTM X:</strong> ${utmParcel.x} m E<br>
            <strong>Center UTM Y:</strong> ${utmParcel.y} m N<br><br>
            <a href="#" onclick="showDetails(${idx}); return false;">View Details</a>
          </div>
        `);
        parcelLayer.addTo(permitGroup);
      }
    }

    // Render Building Geometry with red "Building Permit" Popup Header
    if (record.building_geom) {
      const parsedBuildingGeom = parseGeom(record.building_geom);
      if (parsedBuildingGeom) {
        const buildingLayer = L.geoJSON(parsedBuildingGeom, {
          style: { color: '#ffea00', weight: 2, fillColor: '#ffab00', fillOpacity: 0.65 }
        });

        const utmBuilding = getProjectedCentroid(parsedBuildingGeom);
        buildingLayer.bindPopup(`
          <div style="font-size:13px;">
            <strong style="color: red; font-size: 14px;">Building Permit</strong><br>
            <strong>Permit:</strong> ${record.permit_number || 'N/A'}<br>
            <strong>Applicant:</strong> ${record.applicant_full_name || 'N/A'}<br>
            <strong>Zoning:</strong> ${compliance.badgeHTML}<br>
            <strong>Center UTM X:</strong> ${utmBuilding.x} m E<br>
            <strong>Center UTM Y:</strong> ${utmBuilding.y} m N<br><br>
            <a href="#" onclick="showDetails(${idx}); return false;">View Details</a>
          </div>
        `);
        buildingLayer.addTo(permitGroup);
      }
    }

    // Fallback combined geometry if separate ones don't exist
    if (!record.parcel_geom && !record.building_geom && record.view_combined_geom) {
      const parsedCombinedGeom = parseGeom(record.view_combined_geom);
      if (parsedCombinedGeom) {
        const combinedLayer = L.geoJSON(parsedCombinedGeom, {
          style: { color: '#00d2ff', weight: 2, fillColor: '#00d2ff', fillOpacity: 0.3 }
        });

        const utmCombined = getProjectedCentroid(parsedCombinedGeom);
        combinedLayer.bindPopup(`
          <div style="font-size:13px;">
            <strong style="color: #0284c7; font-size: 14px;">Parcel / Building</strong><br>
            <strong>Permit:</strong> ${record.permit_number || 'N/A'}<br>
            <strong>Applicant:</strong> ${record.applicant_full_name || 'N/A'}<br>
            <strong>Zoning:</strong> ${compliance.badgeHTML}<br>
            <strong>Center UTM X:</strong> ${utmCombined.x} m E<br>
            <strong>Center UTM Y:</strong> ${utmCombined.y} m N<br><br>
            <a href="#" onclick="showDetails(${idx}); return false;">View Details</a>
          </div>
        `);
        combinedLayer.addTo(permitGroup);
      }
    }

    if (permitGroup.getLayers().length > 0) {
      geojsonGroup.addLayer(permitGroup);
      layersMap[record.permit_id || record.permit_number || idx] = permitGroup;
    }

    row.onclick = () => {
      focusOnPermit(record.permit_id || record.permit_number || idx);
    };
    
    tableBody.appendChild(row);
  });

  if (geojsonGroup.getLayers().length > 0) {
    map.fitBounds(geojsonGroup.getBounds());
  }

  setTimeout(() => {
    map.invalidateSize();
  }, 200);
}

function focusOnPermit(permitKey) {
  const layerGroup = layersMap[permitKey];
  if (layerGroup) {
    map.fitBounds(layerGroup.getBounds(), { padding: [50, 50], maxZoom: 18 });
    layerGroup.openPopup();
  }
}

function showDetails(index) {
  const r = globalPermitData[index];
  const modalBody = document.getElementById('modal-body');
  const modalTitle = document.getElementById('modal-title');

  if (modalTitle) modalTitle.innerText = `Building Permit Details: ${r.permit_number || 'N/A'}`;

  const vertices = getAllProjectedCoordinates(r);
  const compliance = checkZoningCompliance(r);

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

  const issuesHTML = compliance.issuesList.length
    ? compliance.issuesList.map(i => `<li style="color:#c0392b;margin:4px 0;">⚠️ ${i}</li>`).join('')
    : `<li style="color:#16a34a;font-weight:bold;list-style:none;">✓ Passed all zoning rules for ${compliance.zoneUsed}</li>`;

  if (modalBody) {
    modalBody.innerHTML = `
      <div class="details-section">Zoning Compliance Diagnosis</div>
      <div class="details-item">
        <span>Status (${compliance.zoneUsed})</span>
        <div style="margin-top:4px;">${compliance.badgeHTML}</div>
      </div>
      <div class="details-item">
        <span>Regulatory Evaluation</span>
        <ul style="padding-left:16px;font-size:13px;margin-top:2px;">${issuesHTML}</ul>
      </div>

      <div class="details-section">All Spatial Vertices (EPSG:32632 / UTM Zone 32N)</div>
      ${renderTable(vertices.parcel, 'Parcel Boundary Vertices')}
      ${renderTable(vertices.building, 'Building Footprint Vertices')}

      <div class="details-section">Applicant Information</div>
      <div class="details-item"><span>Full Name</span>${r.applicant_full_name || 'N/A'}</div>
      <div class="details-item"><span>nui</span>${r.applicant_nui || r.applicant_nui || 'N/A'}</div>
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
      
      <div class="details-section">Building permit</div>
      <div class="details-item"><span>Building Use</span>${r.building_use || 'N/A'}</div>
      <div class="details-item"><span>Floors Above Ground</span>${r.floors_above_ground || 'N/A'}</div>
      <div class="details-item"><span>Underground Floors</span>${r.floors_underground || 'N/A'}</div>
      <div class="details-item"><span>Height</span>${r.height_m ? r.height_m + ' m' : 'N/A'}</div>
      <div class="details-item"><span>COS</span>${r.cos || 'N/A'}</div>
      <div class="details-item"><span>CES</span>${r.ces || 'N/A'}</div>
      <div class="details-item"><span>estimated cost</span>${r.estimated_cost || 'N/A'}</div>
      <div class="details-item"><span>parking place</span>${r.parking_place || 'N/A'}</div>
      <div class="details-item"><span>height m</span>${r.height_m || 'N/A'}</div>
      <div class="details-item"><span>area sq m</span>${r.area_sq_m || 'N/A'}</div>
    `;
  }

  const detailModal = document.getElementById('detail-modal');
  if (detailModal) detailModal.style.display = 'flex';
}

function closeModal() {
  const detailModal = document.getElementById('detail-modal');
  if (detailModal) detailModal.style.display = 'none';
}

// 6. Toggle Buttons UI Logic for Switching Search Bars
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

// General Search Input Handler
const searchInput = document.getElementById('search-input');
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
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
  });
}

// GPS Tracker & Road-Following Routing Search Handler (Yango style)
const trackSearchInput = document.getElementById('track-search-input');
let trackingLayerGroup = L.layerGroup().addTo(map);
let currentRoutingControl = null;

if (trackSearchInput) {
  trackSearchInput.addEventListener('keypress', async function (e) {
    if (e.key === 'Enter') {
      const query = e.target.value.trim().toLowerCase();
      if (!query) return;

      // Clear previous routes/markers
      trackingLayerGroup.clearLayers();
      if (currentRoutingControl) {
        map.removeControl(currentRoutingControl);
        currentRoutingControl = null;
      }

      const matchedRecord = globalPermitData.find(r => 
        (r.permit_number && r.permit_number.toLowerCase().includes(query)) ||
        (r.applicant_full_name && r.applicant_full_name.toLowerCase().includes(query)) ||
        (r.land_title_no && r.land_title_no.toLowerCase().includes(query)) ||
        (r.parcel_arrondissement && r.parcel_arrondissement.toLowerCase().includes(query))
      );

      if (!matchedRecord) {
        alert("No matching permit or house found!");
        return;
      }

      if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser");
        return;
      }

      navigator.geolocation.getCurrentPosition(async (position) => {
        const userLat = position.coords.latitude;
        const userLng = position.coords.longitude;

        const userMarker = L.marker([userLat, userLng]).bindPopup("📍 You are here");
        trackingLayerGroup.addLayer(userMarker);

        const key = matchedRecord.permit_id || matchedRecord.permit_number;
        const layerGroup = layersMap[key];
        
        if (layerGroup) {
          // Get bounds center of the target permit geometry as parcel/house destination point
          const bounds = layerGroup.getBounds();
          const targetLatLng = bounds.getCenter();

          // Initialize Leaflet Routing Machine to trace streets like Yango
          currentRoutingControl = L.Routing.control({
            waypoints: [
              L.latLng(userLat, userLng),     // Starting point: Live user GPS
              L.latLng(targetLatLng.lat, targetLatLng.lng) // Destination: Parcel/House center
            ],
            routeWhileDragging: false,
            lineOptions: {
              styles: [{ color: '#2563eb', weight: 6, opacity: 0.8 }]
            },
            show: true, // Displays turn-by-turn text box instructions
            addWaypoints: false
          }).addTo(map);

          map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
        } 
      }, (error) => {
        alert("Unable to retrieve your GPS location. Please check phone settings.");
        console.error(error);
      });
    }
  });
}

// Initial Load
loadBuildingPermit('local');
