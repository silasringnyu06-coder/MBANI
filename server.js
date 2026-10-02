const express = require('express');
const cors = require('cors');
require('dotenv').config();

const db = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'MBANI WebGIS API is running!' });
});

// Cleaned SQL Query (Using lowercase column names)
const getBuildingPermitQuery = () => `
  SELECT 
      p_applicant.person_id AS applicant_id,
      p_applicant.full_name AS applicant_full_name,
      p_applicant.nui AS applicant_nui,
      p_applicant.phone AS applicant_phone,
      p_applicant.email AS applicant_email,
      p_applicant.address AS applicant_address,
      p_applicant.sex AS applicant_sex,
      
      pa.parcel_id,
      pa.plot_no,
      pa.arrondissement AS parcel_arrondissement,
      pa.quarter AS parcel_quarter,
      pa.area_sq_m AS parcel_area_sq_m,
      pa.cadastral_area,
      ST_AsGeoJSON(ST_Transform(pa.geom, 4326))::json AS parcel_geom,
      pa.calculated_area AS parcel_calculated_area,
      
      p_owner.person_id AS owner_id,
      p_owner.full_name AS owner_full_name,
      p_owner.nui AS owner_nui,                  
      p_owner.phone AS owner_phone,
      p_owner.email AS owner_email,
      p_owner.address AS owner_address,
      p_owner.sex AS owner_sex,

      bp.permit_id,
      bp.permit_number,
      bp.floors_above_ground,
      bp.floors_underground,
      bp.building_use,
      bp.parking_place,
      bp.height_m,
      bp.area_sq_m AS building_area_sq_m,
      bp.building_cost,
      bp.issue_date,
      bp.expiry_date,
      bp.cos,
      bp.ces,
      bp.setback_front,
      bp.setback_boundary,
      bp.estimated_cost,
      bp.title_rec_no,
      bp.status AS permit_status,
      bp.input_database_date,
      ST_AsGeoJSON(ST_Transform(bp.geom, 4326))::json AS building_geom,
      bp.calculated_area AS building_calculated_area,
      
      ST_AsGeoJSON(ST_Transform(ST_Collect(pa.geom, bp.geom), 4326))::json AS parcel_and_building_geom,
      ST_Intersects(bp.geom, pa.geom) AS building_intersects_parcel,
      ST_Contains(pa.geom, bp.geom) AS building_fully_contained_in_parcel

  FROM building_permit bp
  LEFT JOIN person p_applicant ON bp.applicant_id = p_applicant.person_id
  LEFT JOIN parcel pa ON bp.parcel_id = pa.parcel_id
  LEFT JOIN person p_owner ON pa.owned_by = p_owner.person_id;
`;

// Fetch endpoints
app.get('/api/building-permit', async (req, res) => {
  try {
    const result = await db.localQuery(getBuildingPermitQuery());
    res.status(200).json(result.rows);
  } catch (localErr) {
    try {
      const cloudResult = await db.cloudQuery(getBuildingPermitQuery());
      res.status(200).json(cloudResult.rows);
    } catch (cloudErr) {
      res.status(500).json({ 
        error: 'Server error fetching building permit from both databases',
        localError: localErr.message,
        cloudError: cloudErr.message
      });
    }
  }
});

// Setup Tables in Supabase Cloud
app.get('/api/setup-cloud-tables', async (req, res) => {
  try {
    await db.cloudQuery(`CREATE EXTENSION IF NOT EXISTS postgis;`);

    await db.cloudQuery(`
      CREATE TABLE IF NOT EXISTS person (
        person_id SERIAL PRIMARY KEY,
        full_name VARCHAR(50),
        nui VARCHAR(80),
        phone INTEGER,
        email VARCHAR(50),
        address VARCHAR(255),
        sex VARCHAR(10)
      );
    `);

    await db.cloudQuery(`
      CREATE TABLE IF NOT EXISTS parcel (
        parcel_id SERIAL PRIMARY KEY,
        plot_no VARCHAR(50),
        arrondissement VARCHAR(50),
        quarter VARCHAR(50),
        area_sq_m NUMERIC,
        cadastral_area NUMERIC,
        geom GEOMETRY(Polygon, 32632),
        calculated_area NUMERIC,
        owned_by INTEGER REFERENCES person(person_id)
      );
    `);

    await db.cloudQuery(`
      CREATE TABLE IF NOT EXISTS building_permit (
        permit_id SERIAL PRIMARY KEY,
        permit_number VARCHAR(20),
        applicant_id INTEGER REFERENCES person(person_id),
        parcel_id INTEGER REFERENCES parcel(parcel_id),
        floors_above_ground VARCHAR(50),
        floors_underground VARCHAR(50),
        building_use VARCHAR(100),
        parking_place VARCHAR(50),
        height_m NUMERIC,
        area_sq_m NUMERIC,
        building_cost NUMERIC,
        issue_date DATE,
        expiry_date DATE,
        cos NUMERIC,
        ces NUMERIC,
        setback_front NUMERIC,
        setback_boundary NUMERIC,
        estimated_cost NUMERIC,
        title_rec_no VARCHAR(50),
        status VARCHAR(50),
        input_database_date TIMESTAMP,
        geom GEOMETRY(Polygon, 32632),
        calculated_area NUMERIC
      );
    `);

    res.status(200).json({ message: 'All Supabase tables and PostGIS schemas created successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create tables', details: err.message });
  }
});

// Sync handler function
const pushLocalDataHandler = async (req, res) => {
  try {
    const localPersons = await db.localQuery('SELECT * FROM person;');
    for (let row of localPersons.rows) {
      await db.cloudQuery(
        `INSERT INTO person (person_id, full_name, nui, phone, email, address, sex) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) 
         ON CONFLICT (person_id) DO UPDATE SET
           full_name = EXCLUDED.full_name, nui = EXCLUDED.nui, phone = EXCLUDED.phone, email = EXCLUDED.email, address = EXCLUDED.address, sex = EXCLUDED.sex;`,
        [row.person_id, row.full_name, row.nui || row.NUI, row.phone, row.email, row.address, row.sex]
      );
    }

    const localParcels = await db.localQuery('SELECT * FROM parcel;');
    for (let row of localParcels.rows) {
      await db.cloudQuery(
        `INSERT INTO parcel (parcel_id, plot_no, arrondissement, quarter, area_sq_m, cadastral_area, geom, calculated_area, owned_by) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
         ON CONFLICT (parcel_id) DO UPDATE SET
           plot_no = EXCLUDED.plot_no, arrondissement = EXCLUDED.arrondissement, quarter = EXCLUDED.quarter, area_sq_m = EXCLUDED.area_sq_m, cadastral_area = EXCLUDED.cadastral_area, geom = EXCLUDED.geom, calculated_area = EXCLUDED.calculated_area, owned_by = EXCLUDED.owned_by;`,
        [row.parcel_id, row.plot_no, row.arrondissement, row.quarter, row.area_sq_m, row.cadastral_area, row.geom, row.calculated_area, row.owned_by]
      );
    }

    const localPermits = await db.localQuery('SELECT * FROM building_permit;');
    for (let row of localPermits.rows) {
      await db.cloudQuery(
        `INSERT INTO building_permit (permit_id, permit_number, applicant_id, parcel_id, floors_above_ground, floors_underground, building_use, parking_place, height_m, area_sq_m, building_cost, issue_date, expiry_date, cos, ces, setback_front, setback_boundary, estimated_cost, title_rec_no, status, input_database_date, geom, calculated_area) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) 
         ON CONFLICT (permit_id) DO UPDATE SET
           permit_number = EXCLUDED.permit_number, applicant_id = EXCLUDED.applicant_id, parcel_id = EXCLUDED.parcel_id, floors_above_ground = EXCLUDED.floors_above_ground, floors_underground = EXCLUDED.floors_underground, building_use = EXCLUDED.building_use, parking_place = EXCLUDED.parking_place, height_m = EXCLUDED.height_m, area_sq_m = EXCLUDED.area_sq_m, building_cost = EXCLUDED.building_cost, issue_date = EXCLUDED.issue_date, expiry_date = EXCLUDED.expiry_date, cos = EXCLUDED.cos, ces = EXCLUDED.ces, setback_front = EXCLUDED.setback_front, setback_boundary = EXCLUDED.setback_boundary, estimated_cost = EXCLUDED.estimated_cost, title_rec_no = EXCLUDED.title_rec_no, status = EXCLUDED.status, input_database_date = EXCLUDED.input_database_date, geom = EXCLUDED.geom, calculated_area = EXCLUDED.calculated_area;`,
        [
          row.permit_id, 
          row.permit_number, 
          row.applicant_id, 
          row.parcel_id, 
          row.floors_above_ground, 
          row.floors_underground, 
          row.building_use, 
          row.parking_place, 
          row.height_m, 
          row.area_sq_m, 
          row.building_cost, 
          row.issue_date, 
          row.expiry_date, 
          row.cos, 
          row.ces, 
          row.setback_front, 
          row.setback_boundary, 
          row.estimated_cost, 
          row.title_rec_no, 
          row.status, 
          row.input_database_date, 
          row.geom, 
          row.calculated_area
        ]
      );
    }

    res.status(200).json({ message: 'Successfully synced local data to Supabase Cloud!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to push local data', details: err.message });
  }
};

// Expose both endpoint routes so either URL works
app.get('/api/push-local-data', pushLocalDataHandler);
app.get('/api/migrate-data', pushLocalDataHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running smoothly on http://localhost:${PORT}`);
});