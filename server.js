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

// Updated Shared SQL Query Generator (Fixed: removed nui column reference)
const getBuildingPermitQuery = () => `
  SELECT 
      p_applicant.person_id AS applicant_id,
      p_applicant.full_name AS applicant_full_name,
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
      p_owner.phone AS owner_phone,
      p_owner.email AS owner_email,
      p_owner.address AS owner_address,
      p_owner.sex AS owner_sex,

      bp.permit_id,
      bp.permit_number,
      bp.floors_above_ground AS floors_above_ground,
      bp.floors_underground,
      bp.building_use,
      bp.parking_place,
      bp.height_m AS height_m,
      bp.area_sq_m AS building_area_sq_m,
      bp.building_cost,
      bp.issue_date,
      bp.expiry_date,
      bp.cos AS cos,
      bp.ces AS ces,
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

// Smart Local / Cloud Fallback Database Endpoint with Detailed Error Reporting
app.get('/api/building-permit', async (req, res) => {
  try {
    // Tries local database first (for your local laptop testing)
    const result = await db.localQuery(getBuildingPermitQuery());
    res.status(200).json(result.rows);
  } catch (localErr) {
    // Automatically falls back to Supabase Cloud when local isn't available (e.g., on Render)
    try {
      const cloudResult = await db.cloudQuery(getBuildingPermitQuery());
      res.status(200).json(cloudResult.rows);
    } catch (cloudErr) {
      console.error('Both Local and Cloud Query Error:', localErr.message, cloudErr.message);
      res.status(500).json({ 
        error: 'Server error fetching building permit from both databases',
        localError: localErr.message,
        cloudError: cloudErr.message
      });
    }
  }
});

// Cloud Database Endpoint
app.get('/api/cloud-building-permit', async (req, res) => {
  try {
    const result = await db.cloudQuery(getBuildingPermitQuery());
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Cloud Database Query Error:', err.message);
    res.status(500).json({ error: 'Server error fetching cloud building permit', details: err.message });
  }
});

// Sync & Insert Endpoint (Saves to both Local PostgreSQL and Supabase Cloud simultaneously)
app.post('/api/sync-building-permit', async (req, res) => {
  const { permit_number, applicant_id, parcel_id, building_use, status } = req.body;
  
  const queryText = `
    INSERT INTO building_permit (permit_number, applicant_id, parcel_id, building_use, status)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *;
  `;
  const values = [permit_number, applicant_id, parcel_id, building_use, status];

  try {
    const result = await db.syncQuery(queryText, values);
    res.status(201).json({
      message: 'Successfully synced and inserted to both Local and Supabase Cloud databases!',
      local: result.local.rows[0],
      cloud: result.cloud.rows[0]
    });
  } catch (err) {
    console.error('Database Sync Insertion Error:', err);
    res.status(500).json({ error: 'Failed to sync and insert record across databases', details: err.message });
  }
});

// Auto-Create Tables in Supabase Cloud from Backend
app.get('/api/setup-cloud-tables', async (req, res) => {
  try {
    // 1. Enable PostGIS extension in Supabase first
    await db.cloudQuery(`CREATE EXTENSION IF NOT EXISTS postgis;`);

    // 2. Create person table
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

    // 3. Create parcel table with PostGIS Geometry
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

    // 4. Create building_permit table with PostGIS Geometry & Foreign Keys
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

    res.status(200).json({ message: 'All Supabase tables and PostGIS schemas created successfully by the backend!' });
  } catch (err) {
    console.error('Table setup error:', err);
    res.status(500).json({ error: 'Failed to create tables', details: err.message });
  }
});

// Migration Route: Sequentially copies Person, Parcel, and Building Permits to Supabase Cloud
app.get('/api/migrate-data', async (req, res) => {
  try {
    // 1. Migrate PERSON table first
    const localPersons = await db.localQuery('SELECT * FROM person;');
    let personCount = 0;
    for (let row of localPersons.rows) {
      await db.cloudQuery(
        `INSERT INTO person (person_id, full_name, nui, phone, email, address, sex) 
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (person_id) DO NOTHING;`,
        [row.person_id, row.full_name, row.nui, row.phone, row.email, row.address, row.sex]
      );
      personCount++;
    }

    // 2. Migrate PARCEL table second
    const localParcels = await db.localQuery('SELECT * FROM parcel;');
    let parcelCount = 0;
    for (let row of localParcels.rows) {
      await db.cloudQuery(
        `INSERT INTO parcel (parcel_id, plot_no, arrondissement, quarter, area_sq_m, cadastral_area, geom, calculated_area, owned_by) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (parcel_id) DO NOTHING;`,
        [row.parcel_id, row.plot_no, row.arrondissement, row.quarter, row.area_sq_m, row.cadastral_area, row.geom, row.calculated_area, row.owned_by]
      );
      parcelCount++;
    }

    // 3. Migrate BUILDING_PERMIT table last
    const localPermits = await db.localQuery('SELECT * FROM building_permit;');
    let permitCount = 0;
    for (let row of localPermits.rows) {
      await db.cloudQuery(
        `INSERT INTO building_permit (permit_id, permit_number, applicant_id, parcel_id, floors_above_ground, floors_underground, building_use, parking_place, height_m, area_sq_m, building_cost, issue_date, expiry_date, cos, ces, setback_front, setback_boundary, estimated_cost, title_rec_no, status, input_database_date, geom, calculated_area) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) ON CONFLICT (permit_id) DO NOTHING;`,
        [
          row.permit_id, row.permit_number, row.applicant_id, row.parcel_id, 
          row.Floors_above_ground, row.floors_underground, row.building_use, 
          row.parking_place, row.height_m, row.area_sq_m, row.building_cost, 
          row.issue_date, row.expiry_date, row.cos, row.ces, 
          row.setback_front, row.setback_boundary, row.estimated_cost, 
          row.title_rec_no, row.status, row.input_database_date, 
          row.geom, row.calculated_area
        ]
      );
      permitCount++;
    }

    res.status(200).json({ 
      message: `Successfully migrated ${personCount} persons, ${parcelCount} parcels, and ${permitCount} building permits to Supabase Cloud!` 
    });
  } catch (err) {
    console.error('Migration error:', err);
    res.status(500).json({ error: 'Migration failed', details: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running smoothly on http://localhost:${PORT}`);
});
