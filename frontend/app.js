// 1. Register Spatial Projection Definitions
proj4.defs("EPSG:32632", "+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs");
proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs");

// 2. Initialize Leaflet Map (Centered over Yaoundé, Cameroon)
const map = L.map('map').setView([3.848, 11.502], 12);

// Google Hybrid/Satellite Basemap (High-resolution aerial imagery + roads/labels)
L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
  maxZoom: 20,
  attribution: 'Map data ©2026 Google'
}).addTo(map);

const geojsonGroup = L.featureGroup().addTo(map);
let globalPermitsData = [];
const layersMap = {};
let customLocationMarker = null;
let userPosMarker = null;

// 3. Live Cursor Location Tracker (Displays Projected UTM Zone 32N coordinates)
map.on('mousemove', function(e) {
  const utmCoords = proj4("EPSG:4326", "EPSG:32632", [e.latlng.lng, e.latlng.lat]);
  const coordDisplay = document.getElementById('coord-display');
  if (coordDisplay) {
    coordDisplay.innerText = `UTM Zone 32N (EPSG:32632) | X: ${utmCoords[0].toFixed(2)} m E | Y: ${utmCoords[1].toFixed(2)} m N`;
  }
});

/**
 * Converts EPSG:32632 (UTM Zone 32N meters) GeoJSON to EPSG:4326 (WGS84 Lng/Lat)
 */
function reprojectGeoJSON(geojson) {
  if (!geojson) return null;
  const cloned = JSON.parse(JSON.stringify(geojson));
  
  function transformCoords(coords) {
    if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      return proj4("EPSG:32632", "EPSG:4326", [coords[0], coords[1]]);
    }
    return coords.map(transformCoords);
  }
  
  if (cloned.type === 'GeometryCollection') {
    cloned.geometries = cloned.geometries.map(geom => {
      geom.coordinates = transformCoords(geom.coordinates);
      return geom;
    });
  } else if (cloned.coordinates) {
    cloned.coordinates = transformCoords(cloned.coordinates);
  }

  return cloned;
}

/**
 * Extracts centroid projected X/Y coordinates in meters from raw EPSG:32632 GeoJSON
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
        sumX += coords[i][0];
        sumY += coords[i][1];
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

/**
 * Extracts ALL boundary vertices (X, Y) grouped by geometry layer
 */
function getAllProjectedCoordinates(record) {
  const result = { parcel: [], building: [] };
  function extractPoints(geojson) {
    if (!geojson) return [];
    try {
      let coords = geojson.type === 'GeometryCollection' && geojson.geometries.length > 0 
        ? geojson.geometries[0].coordinates 
        : geojson.coordinates;
      if (!coords) return [];

      while (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
        coords = coords[0];
      }

      return coords.map((pt, i) => ({
        index: i + 1,
        x: typeof pt[0] === 'number' ? pt[0].toFixed(2) : 'N/A',
        y: typeof pt[1] === 'number' ? pt[1].toFixed(2) : 'N/A'
      }));
    } catch (e) {
      return [];
    }
  }

  if (record.parcel_geom) result.parcel = extractPoints(record.parcel_geom);
  if (record.building_geom) result.building = extractPoints(record.building_geom);
  if (result.parcel.length === 0 && result.building.length === 0 && record.view_combined_geom) {
    result.parcel = extractPoints(record.view_combined_geom);
  }
  return result;
}

// 4. Fetch Spatial Data from Node.js Express Server
async function loadBuildingPermits() {
  try {
    const response = await fetch('http://localhost:5000/api/building-permits');
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

    globalPermitsData = await response.json();
    renderTableAndMap(globalPermitsData);
  } catch (error) {
    console.error('Error fetching data:', error);
    document.getElementById('permits-table-body').innerHTML = 
      `<tr><td colspan="7" style="text-align:center; color: red;">Failed to load data from server.</td></tr>`;
  }
}

// 5. Render PostGIS Data into Table and Leaflet Map
function renderTableAndMap(data) {
  const tableBody = document.getElementById('permits-table-body');
  tableBody.innerHTML = '';
  geojsonGroup.clearLayers();

  if (!data || data.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;">No records found.</td></tr>';
    return;
  }

  data.forEach((record, idx) => {
    // Populate Dashboard Table
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${record.permit_number || 'N/A'}</strong></td>
      <td>${record.applicant_full_name || 'N/A'}</td>
      <td>${record.applicant_phone_number || record.applicant_phone || 'N/A'}</td>
      <td><span class="status-badge">${record.permit_status || 'N/A'}</span></td>
      <td>${record.building_use || 'N/A'}</td>
      <td>${record.floors_above_ground || 'N/A'}</td>
      <td><button onclick="event.stopPropagation(); showDetails(${idx})" style="padding:4px 8px; cursor:pointer;">View All</button></td>
    `;
    
    const permitGroup = L.featureGroup();

    // Render Parcel Geometry (Bright Blue Outer Boundary for high visibility on satellite)
    if (record.parcel_geom) {
      const wgsParcel = reprojectGeoJSON(record.parcel_geom);
      if (wgsParcel) {
        L.geoJSON(wgsParcel, {
          style: { color: '#00d2ff', weight: 3, fillColor: '#00d2ff', fillOpacity: 0.25 }
        }).addTo(permitGroup);
      }
    }

    // Render Building Footprint Geometry (Bright Yellow/Orange Overlay)
    if (record.building_geom) {
      const wgsBuilding = reprojectGeoJSON(record.building_geom);
      if (wgsBuilding) {
        L.geoJSON(wgsBuilding, {
          style: { color: '#ffea00', weight: 2, fillColor: '#ffab00', fillOpacity: 0.65 }
        }).addTo(permitGroup);
      }
    }

    // Fallback: Render combined geometry if individual columns are empty
    if (!record.parcel_geom && !record.building_geom && record.view_combined_geom) {
      const wgsCombined = reprojectGeoJSON(record.view_combined_geom);
      if (wgsCombined) {
        L.geoJSON(wgsCombined, {
          style: { color: '#00d2ff', weight: 2, fillColor: '#00d2ff', fillOpacity: 0.3 }
        }).addTo(permitGroup);
      }
    }

    if (permitGroup.getLayers().length > 0) {
      const mainGeom = record.parcel_geom || record.view_combined_geom;
      const utmCoords = getProjectedCentroid(mainGeom);

      permitGroup.bindPopup(`
        <div style="font-size:13px;">
          <strong>Permit:</strong> ${record.permit_number || 'N/A'}<br>
          <strong>Applicant:</strong> ${record.applicant_full_name || 'N/A'}<br>
          <strong>Center UTM X:</strong> ${utmCoords.x} m E<br>
          <strong>Center UTM Y:</strong> ${utmCoords.y} m N<br><br>
          <a href="#" onclick="showDetails(${idx}); return false;">View Details</a>
        </div>
      `);

      geojsonGroup.addLayer(permitGroup);
      layersMap[record.permit_id] = permitGroup;
    }

    // Precise Spatial Location Tracking on Row Click
    row.onclick = () => {
      focusOnPermit(record.permit_id);
    };
    
    tableBody.appendChild(row);
  });

  // Fit map view to bounds of all rendered layers
  if (geojsonGroup.getLayers().length > 0) {
    map.fitBounds(geojsonGroup.getBounds());
  }
}

/**
 * 6. Precise Spatial Tracking & Smooth Focus Function
 */
function focusOnPermit(permitId) {
  const layerGroup = layersMap[permitId];
  if (layerGroup) {
    // 1. Zoom and center map smoothly on the feature boundary
    map.fitBounds(layerGroup.getBounds(), { padding: [50, 50], maxZoom: 18 });
    
    // 2. Open spatial popup
    layerGroup.openPopup();
    
    // 3. Highlight geometry border temporarily for instant spatial detection
    layerGroup.eachLayer(layer => {
      if (layer.setStyle) {
        const originalColor = layer.options.color;
        const originalWeight = layer.options.weight;

        layer.setStyle({ color: '#ff0055', weight: 5 });
        setTimeout(() => {
          layer.setStyle({ color: originalColor, weight: originalWeight });
        }, 2000);
      }
    });
  }
}

/**
 * 7. Locate Parcel via Manual Direct UTM Coordinates (EPSG:32632)
 */
function goToUTMCoordinates() {
  const xInput = document.getElementById('utm-x-input');
  const yInput = document.getElementById('utm-y-input');

  if (!xInput || !yInput) return;

  const x = parseFloat(xInput.value);
  const y = parseFloat(yInput.value);

  if (isNaN(x) || isNaN(y)) {
    alert('Please enter valid numerical UTM X (Easting) and Y (Northing) values.');
    return;
  }

  // Convert UTM Zone 32N meters back to Lat/Lng (WGS84) for Leaflet map centering
  const lonLat = proj4("EPSG:32632", "EPSG:4326", [x, y]);
  const latLng = [lonLat[1], lonLat[0]];

  // Center map on coordinates with street/parcel level zoom
  map.setView(latLng, 18);

  // Drop temporary highlight marker
  if (customLocationMarker) map.removeLayer(customLocationMarker);
  
  customLocationMarker = L.marker(latLng).addTo(map)
    .bindPopup(`<b>Located Coordinate</b><br>UTM X: ${x.toFixed(2)} m E<br>UTM Y: ${y.toFixed(2)} m N`)
    .openPopup();
}

/**
 * 8. Real-Time Field Inspector GPS Geolocation Tracking
 */
function startFieldTracking() {
  map.locate({ setView: true, maxZoom: 18, watch: true, enableHighAccuracy: true });
}

map.on('locationfound', function(e) {
  const radius = e.accuracy / 2;
  const utmCoords = proj4("EPSG:4326", "EPSG:32632", [e.lng, e.lat]);

  if (!userPosMarker) {
    userPosMarker = L.circleMarker(e.latlng, {
      radius: 8,
      fillColor: '#10b981',
      color: '#ffffff',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.9
    }).addTo(map);
  } else {
    userPosMarker.setLatLng(e.latlng);
  }

  userPosMarker.bindPopup(`
    <b>Your Position</b><br>
    UTM X: ${utmCoords[0].toFixed(2)} m E<br>
    UTM Y: ${utmCoords[1].toFixed(2)} m N<br>
    Accuracy: ±${radius.toFixed(1)} m
  `);
});

map.on('locationerror', function(e) {
  console.warn("GPS Location tracking unavailable:", e.message);
});

// 9. Display Details Modal with EPSG:32632 Projected Coordinates & Vertices
function showDetails(index) {
  const r = globalPermitsData[index];
  const modalBody = document.getElementById('modal-body');

  const vertices = getAllProjectedCoordinates(r);

  const renderTable = (points, title) => {
    if (!points || points.length === 0) return `<div><strong>${title}:</strong> N/A</div>`;
    return `
      <div style="font-weight: bold; margin-top: 6px; font-size: 13px;">${title} (${points.length} Vertices):</div>
      <div style="max-height: 130px; overflow-y: auto; margin-top: 4px; border: 1px solid #e5e7eb; border-radius: 4px;">
        <table style="width: 100%; border-collapse: collapse; font-size: 11px; text-align: left;">
          <thead style="background-color: #f3f4f6; position: sticky; top: 0;">
            <tr>
              <th style="padding: 4px 8px; border-bottom: 1px solid #e5e7eb;">Point</th>
              <th style="padding: 4px 8px; border-bottom: 1px solid #e5e7eb;">UTM Easting (X)</th>
              <th style="padding: 4px 8px; border-bottom: 1px solid #e5e7eb;">UTM Northing (Y)</th>
            </tr>
          </thead>
          <tbody>
            ${points.map(pt => `
              <tr>
                <td style="padding: 3px 8px; border-bottom: 1px solid #f3f4f6;">P${pt.index}</td>
                <td style="padding: 3px 8px; border-bottom: 1px solid #f3f4f6;">${pt.x} m E</td>
                <td style="padding: 3px 8px; border-bottom: 1px solid #f3f4f6;">${pt.y} m N</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  };

  modalBody.innerHTML = `
    <div class="details-section">All Spatial Vertices (EPSG:32632 / UTM Zone 32N)</div>
    ${renderTable(vertices.parcel, 'Parcel Boundary Vertices')}
    ${renderTable(vertices.building, 'Building Footprint Vertices')}

    <div class="details-section">Applicant Information (Person Table)</div>
    <div><strong>Full Name:</strong> ${r.applicant_full_name || 'N/A'}</div>
    <div><strong>NIU:</strong> ${r.applicant_niu || 'N/A'}</div>
    <div><strong>Phone:</strong> ${r.applicant_phone_number || r.applicant_phone || 'N/A'}</div>
    <div><strong>Email:</strong> ${r.applicant_email || 'N/A'}</div>
    <div><strong>Address:</strong> ${r.applicant_address || 'N/A'}</div>

    <div class="details-section">Permit & Parcel Details (Building_Permit Table)</div>
    <div><strong>Permit No:</strong> ${r.permit_number || 'N/A'}</div>
    <div><strong>Dossier No:</strong> ${r.no_du_dossier || 'N/A'}</div>
    <div><strong>Status:</strong> ${r.permit_status || 'N/A'}</div>
    <div><strong>Deposit Date:</strong> ${r.date_de_depot || 'N/A'}</div>
    <div><strong>Land Title No:</strong> ${r.land_title_no || 'N/A'}</div>
    <div><strong>Quarter / Quartier:</strong> ${r.quartier || 'N/A'}</div>
    <div><strong>Arrondissement:</strong> ${r.arrondissement || 'N/A'}</div>
    <div><strong>Cadastral Area:</strong> ${r.cadastral_area ? r.cadastral_area + ' m²' : 'N/A'}</div>
    <div><strong>COS / CES:</strong> ${r.cos || 'N/A'} / ${r.ces || 'N/A'}</div>
    <div><strong>Road Setback:</strong> ${r.setback_road_m ? r.setback_road_m + ' m' : 'N/A'}</div>

    <div class="details-section">Building & Structure Specs (Building Table)</div>
    <div><strong>Building Use:</strong> ${r.building_use || 'N/A'}</div>
    <div><strong>Floors Above Ground:</strong> ${r.floors_above_ground || 'N/A'}</div>
    <div><strong>Underground Floors:</strong> ${r.floors_underground || 'N/A'}</div>
    <div><strong>Height:</strong> ${r.height_m ? r.height_m + ' m' : 'N/A'}</div>
    <div><strong>Architect Name:</strong> ${r.architect_full_name || 'N/A'}</div>
  `;

  document.getElementById('detail-modal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('detail-modal').style.display = 'none';
}

// 10. Real-Time Search Filter
const searchInput = document.getElementById('search-input');
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const filtered = globalPermitsData.filter(r => 
      (r.applicant_full_name && r.applicant_full_name.toLowerCase().includes(query)) ||
      (r.permit_number && r.permit_number.toLowerCase().includes(query)) ||
      (r.land_title_no && r.land_title_no.toLowerCase().includes(query)) ||
      (r.applicant_niu && r.applicant_niu.toLowerCase().includes(query))
    );
    renderTableAndMap(filtered);
  });
}

// 11. Execute Initial Load
loadBuildingPermits();