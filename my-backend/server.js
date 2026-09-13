const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();

// Enable Cross-Origin Resource Sharing (allows index.html to fetch data)
app.use(cors());
app.use(express.json());

// API Route: Get Building Permits with GeoJSON Geometries
app.get('/api/building-permits', async (req, res) => {
  try {
    const queryText = `
      SELECT 
          -- Export geometries as GeoJSON for frontend Leaflet rendering
          ST_AsGeoJSON(bp.parcel_geom)::json AS parcel_geom,
          ST_AsGeoJSON(b.geom)::json AS building_geom,

          -- Combined EPSG:4326 GeoJSON fallback
          ST_AsGeoJSON(
              ST_Transform(
                  ST_Collect(ARRAY[bp.parcel_geom, b.geom]),
                  4326
              )
          )::json AS view_combined_geom,

          -- Applicant Details
          p_applicant.person_id AS applicant_person_id,
          p_applicant.full_name AS applicant_full_name,
          p_applicant.niu AS applicant_niu,
          p_applicant.email AS applicant_email,
          p_applicant.phone_number AS applicant_phone_number,
          p_applicant.addresse AS applicant_address,
          p_applicant.sex AS applicant_sex,

          -- Permit & Parcel Details
          bp.permit_id,
          bp.applicant_id,
          bp.no_du_dossier,
          bp.date_de_depot,
          bp.mandateur,
          bp.status AS permit_status,
          bp.permit_number,
          bp.issue_date,
          bp.expired_date,
          bp.cos,
          bp.ces,
          bp.setback_road_m,
          bp.setback_boundary_m,
          bp.estimated_cost AS permit_estimated_cost,
          bp.tax_receipt_no,
          bp.land_title_no,
          bp.lot_no,
          bp.arrondissement,
          bp.quartier,
          bp.numero_du_bloc,
          bp.cadastral_area,

          -- Building Specs
          b.building_id,
          b.permit_id AS building_permit_id,
          b.architect_id,
          b.building_use,
          b.floors_above_ground,
          b.floors_underground,
          b.height_m,
          b.parking_place,
          b.building_cost,

          -- Architect Details
          p_architect.person_id AS architect_person_id,
          p_architect.full_name AS architect_full_name,
          p_architect.niu AS architect_niu,
          p_architect.email AS architect_email,
          p_architect.phone_number AS architect_phone_number,
          p_architect.addresse AS architect_address,
          p_architect.sex AS architect_sex

      FROM building_permit bp
      LEFT JOIN person p_applicant 
             ON bp.applicant_id = p_applicant.person_id
      LEFT JOIN building b 
             ON b.permit_id = bp.permit_id
      LEFT JOIN person p_architect 
             ON b.architect_id = p_architect.person_id;
    `;

    const result = await db.query(queryText);
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Database Query Error:', err.message);
    res.status(500).json({ error: 'Server error fetching building permits' });
  }
});

// Start Express Server on Port 5000
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});