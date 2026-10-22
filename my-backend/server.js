const express = require('express');
const cors = require('cors');
const compression = require('compression'); // Compresses large GeoJSON payloads for performance
require('dotenv').config();

const db = require('./db');

const app = express();

app.use(compression());
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'MBANI WebGIS API is running!' });
});

// FULLY ALIGNED VIEW QUERY: Handles separate permit holder (pr) and land owner (lo), with arrondissement in both tables
const getBuildingPermitQuery = () => `
  SELECT
      -- Permit holder: pulled from 'proprietaire' via the permit's personne_id
      pr.proprietaire_id,
      pr.nom_complet AS proprietaire_nom,
      pr.nui AS proprietaire_nui,
      pr.telephone AS proprietaire_telephone,
      pr.email AS proprietaire_email,
      pr.adresse AS proprietaire_adresse,
      pr.sexe AS proprietaire_sexe,
      pr.cni AS proprietaire_cni,
      pr.nationalite AS proprietaire_nationalite,

      -- Land owner of the parcel: separate info columns
      lo.proprietaire_id AS terrain_proprietaire_id,
      lo.nom_complet AS terrain_proprietaire_nom,
      lo.nui AS terrain_proprietaire_nui,
      lo.telephone AS terrain_proprietaire_telephone,

      -- Applicant Details (from 'personne')
      p.personne_id,
      p.nom_complet AS name,
      p.nui,
      p.telephone,
      p.email,
      p.adresse,
      p.sexe,
      p.cni,

      -- Parcelle Details (with parcel arrondissement)
      pa.parcelle_id,
      pa.plot_no,
      pa.arrondissement AS parcel_arrondissement,
      pa.quartier,
      pa.lieu_dit,
      pa.cadastral_area,
      pa.titre_foncier,
      pa.lotissement,
      pa.servitudes,
      pa.num_Tit_Foncier_Mère,
      pa.num_lot,
      pa.co_owners,
      pa.prop_cert_no,
      pa.prop_cert_date,
      ST_AsGeoJSON(ST_Transform(pa.geom, 4326))::json AS parcel_geom,
      pa.superficie_calculee AS parcel_calculated_area,

      -- Certificat d'Urbanisme Details
      cu.cu_id,
      cu.cu_number,
      cu.num_dossier AS cu_num_dossier,
      cu.date_demande,
      cu.qualite_demandeur,
      cu.operation_demandee,
      cu.usage_du_Bati,
      cu.code_zone,
      cu.nom_zone,
      cu.largeur_voie_minimale_m,
      cu.retrait_minimal_m,
      cu.facade_minimale_m,
      cu.superficie_parcelle_minimale_m2,
      cu.activites_interdites,
      cu.date_delivrance,
      cu.date_expiration,
      cu.statut AS statut_cu,

      -- Permis de Construire Details (with permit arrondissement)
      bp.permis_id,
      bp.numero_permis,
      bp.arrondissement AS permit_arrondissement,
      bp.arrete_number,
      bp.commission_date,
      bp.nature_travaux,
      bp.nombre_planchers,
      bp.etages_hors_sol,
      bp.etages_sous_sol,
      bp.usage_bati,
      bp.nombre_places_parkings,
      bp.hauteur_construction,
      bp.building_cost,
      bp.cout_total_projet,
      bp.cos,
      bp.ces,
      bp.recul_voies_publiques,
      bp.recul_limites_separatives,
      bp.title_rec_no,
      bp.architecte_responsable,
      bp.architect_onac_no,
      bp.status AS statut_permis,
      bp.input_database_date,
      bp.issue_date,
      bp.expiry_date,
      ST_AsGeoJSON(ST_Transform(bp.geom, 4326))::json AS building_geom,
      bp.superficie_calculee AS building_calculated_area,

      -- Spatial Geometries & Rules
      ST_AsGeoJSON(ST_Transform(ST_Collect(pa.geom, bp.geom), 4326))::json AS parcel_and_building_geom,
      ST_Intersects(bp.geom, pa.geom) AS building_intersects_parcel,
      ST_Contains(pa.geom, bp.geom) AS building_fully_contained_in_parcel,

      CASE
          WHEN cu.retrait_minimal_m IS NOT NULL
              THEN bp.recul_voies_publiques >= cu.retrait_minimal_m
          ELSE TRUE
      END AS setback_ok

  FROM permis_construire bp
  LEFT JOIN personne p ON bp.personne_id = p.personne_id
  LEFT JOIN parcelle pa ON bp.parcelle_id = pa.parcelle_id
  LEFT JOIN proprietaire pr ON bp.personne_id = pr.proprietaire_id
  LEFT JOIN proprietaire lo ON pa.proprietaire_id = lo.proprietaire_id
  LEFT JOIN certificat_urbanisme cu ON bp.cu_id = cu.cu_id;
`;

// Helper: Direct Cloud Query Execution (Prevents local failure warning loops)
async function queryWithLocalFirst(queryText, params = []) {
  try {
    const cloudResult = await db.cloudQuery(queryText, params);
    return cloudResult;
  } catch (err) {
    console.error('Cloud Query Error:', err.message);
    throw err;
  }
}

// Building Permit Endpoint
app.get('/api/building-permit', async (req, res) => {
  try {
    const result = await queryWithLocalFirst(getBuildingPermitQuery());
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Building Permit Query Error:', err.message);
    res.status(500).json({ error: 'Server error fetching building permit data', details: err.message });
  }
});

// Explicit Cloud Database Endpoint
app.get('/api/cloud-building-permit', async (req, res) => {
  try {
    const result = await db.cloudQuery(getBuildingPermitQuery());
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Cloud Database Query Error:', err.message);
    res.status(500).json({ error: 'Server error fetching cloud building permit', details: err.message });
  }
});

// Combined POS & PDUY Zoning BBox Endpoint
app.get('/api/zones/bbox', async (req, res) => {
  const { minLng, minLat, maxLng, maxLat } = req.query;
  
  try {
    const query = `
      SELECT 
        id, 
        "Vocation_1" AS zone_type, 
        "Code" AS zone_name,
        "CES" AS ces,
        "COS" AS cos,
        "Hauteur_m_" AS hauteur_max,
        ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry 
      FROM "Zonage_pos"
      WHERE geom && ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), 32632)
      
      UNION ALL
      
      SELECT 
        id, 
        "Vocation_1" AS zone_type, 
        "Code" AS zone_name,
        "CES" AS ces,
        "COS" AS cos,
        "Hauteur_m_" AS hauteur_max,
        ST_AsGeoJSON(ST_Transform(geom, 4326))::json AS geometry 
      FROM "Zonage_pduy"
      WHERE geom && ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), 32632);
    `;
    
    const result = await queryWithLocalFirst(query, [minLng, minLat, maxLng, maxLat]);
    
    const features = result.rows.map(row => ({
      type: "Feature",
      geometry: typeof row.geometry === 'string' ? JSON.parse(row.geometry) : row.geometry,
      properties: {
        id: row.id,
        zone_type: row.zone_type || 'Zone Urbaine',
        zone_name: row.zone_name || 'N/A',
        ces: row.ces,
        cos: row.cos,
        hauteur_max: row.hauteur_max
      }
    }));

    res.json({
      type: "FeatureCollection",
      features: features
    });
    
  } catch (err) {
    console.error('Zoning BBox Query Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch unified zoning data', details: err.message });
  }
});

// Mobile-Optimized Quartiers BBox Endpoint
app.get('/api/quartiers/bbox', async (req, res) => {
  const { minLng, minLat, maxLng, maxLat } = req.query;
  
  try {
    const query = `
      SELECT 
        id, 
        name,
        commune,
        ST_AsGeoJSON(geom) AS geometry 
      FROM "quartier" 
      WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326);
    `;
    
    const result = await queryWithLocalFirst(query, [minLng, minLat, maxLng, maxLat]);
    
    const features = result.rows.map(row => ({
      type: "Feature",
      geometry: typeof row.geometry === 'string' ? JSON.parse(row.geometry) : row.geometry,
      properties: {
        id: row.id,
        name: row.name || 'Unknown Quartier',
        commune: row.commune || 'N/A'
      }
    }));

    res.json({
      type: "FeatureCollection",
      features: features
    });
    
  } catch (err) {
    console.error('Quartiers BBox Query Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch quartiers data', details: err.message });
  }
});

// Spatial Lookup Endpoint for Parcel Zoning & Quartier Diagnosis
app.get('/api/parcelle/spatial-info/:id', async (req, res) => {
  const parcelId = req.params.id;

  try {
    const query = `
      SELECT 
        pa.parcelle_id,
        pa.plot_no,
        pa.titre_foncier,
        q.name AS quartier_nom,
        q.commune AS commune_nom,
        COALESCE(z_pos."Vocation_1", z_pdu."Vocation_1") AS zone_type,
        COALESCE(z_pos."Code", z_pdu."Code") AS zone_code,
        COALESCE(z_pos."CES", z_pdu."CES") AS zone_ces,
        COALESCE(z_pos."COS", z_pdu."COS") AS zone_cos,
        COALESCE(z_pos."Hauteur_m_", z_pdu."Hauteur_m_") AS zone_hauteur_max
      FROM parcelle pa
      LEFT JOIN "quartier" q ON ST_Intersects(ST_Transform(pa.geom, 4326), q.geom)
      LEFT JOIN "Zonage_pos" z_pos ON ST_Intersects(pa.geom, z_pos.geom)
      LEFT JOIN "Zonage_pduy" z_pdu ON ST_Intersects(pa.geom, z_pdu.geom)
      WHERE pa.parcelle_id = $1
      LIMIT 1;
    `;

    const result = await queryWithLocalFirst(query, [parcelId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Parcel not found or outside covered spatial data limits." });
    }

    const info = result.rows[0];
    const vocation = (info.zone_type || '').toLowerCase();
    let constructibilityStatus = "Constructible";
    let statusColor = "#2ecc71"; // Green

    if (vocation.includes('non constructible') || vocation.includes('pente') || vocation.includes('inondable') || vocation.includes('marécage') || vocation.includes('vert')) {
      constructibilityStatus = "Non-Constructible (Zone Protégée/Risque)";
      statusColor = "#e74c3c"; // Red
    } else if (vocation.includes('sous condition') || vocation.includes('special')) {
      constructibilityStatus = "Constructibilité Sous Condition";
      statusColor = "#f39c12"; // Orange
    }

    res.json({
      parcel_id: info.parcelle_id,
      plot_no: info.plot_no,
      titre_foncier: info.titre_foncier,
      quartier: info.quartier_nom || 'N/A',
      commune: info.commune_nom || 'N/A',
      zone_code: info.zone_code || 'N/A',
      zone_vocation: info.zone_type || 'Zone Urbaine',
      ces_max: info.zone_ces || 'N/A',
      cos_max: info.zone_cos || 'N/A',
      hauteur_max: info.zone_hauteur_max || 'N/A',
      constructibility_status: constructibilityStatus,
      status_color: statusColor
    });

  } catch (err) {
    console.error("Spatial Info Error:", err.message);
    res.status(500).json({ error: "Failed to evaluate spatial overlap", details: err.message });
  }
});

// Sync & Insert Endpoint
app.post('/api/sync-building-permit', async (req, res) => {
  const { numero_permis, personne_id, parcelle_id, usage_bati, status, arrondissement } = req.body;
  
  const queryText = `
    INSERT INTO permis_construire (numero_permis, personne_id, parcelle_id, usage_bati, status, arrondissement)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *;
  `;
  const values = [numero_permis, personne_id, parcelle_id, usage_bati, status, arrondissement];

  try {
    const result = await db.cloudQuery(queryText, values);
    res.status(201).json({
      message: 'Successfully inserted to Supabase Cloud database!',
      cloud: result.rows[0]
    });
  } catch (err) {
    console.error('Database Insertion Error:', err);
    res.status(500).json({ error: 'Failed to insert record', details: err.message });
  }
});

// Auto-Create Tables in Supabase Cloud from Backend
app.get('/api/setup-cloud-tables', async (req, res) => {
  try {
    await db.cloudQuery(`CREATE EXTENSION IF NOT EXISTS postgis;`);

    await db.cloudQuery(`
      CREATE TABLE IF NOT EXISTS proprietaire (
          proprietaire_id SERIAL PRIMARY KEY,
          nom_complet VARCHAR(150) NOT NULL,
          nui VARCHAR(80) UNIQUE,
          telephone VARCHAR(20),
          email VARCHAR(50),
          adresse VARCHAR(150),
          sexe CHAR(1),
          cni VARCHAR(50),
          nationalite VARCHAR(50)
      );
    `);

    await db.cloudQuery(`
      CREATE TABLE IF NOT EXISTS personne (
          personne_id SERIAL PRIMARY KEY,
          nom_complet VARCHAR(150),
          nui VARCHAR(80) UNIQUE,
          telephone VARCHAR(20),
          email VARCHAR(50),
          adresse VARCHAR(150),
          sexe CHAR(1),
          cni VARCHAR(50)
      );
    `);

    await db.cloudQuery(`
      CREATE TABLE IF NOT EXISTS parcelle (
          parcelle_id SERIAL PRIMARY KEY,
          proprietaire_id INTEGER REFERENCES proprietaire(proprietaire_id) ON DELETE SET NULL,
          plot_no VARCHAR(50) UNIQUE NOT NULL,
          arrondissement VARCHAR(30),
          quartier VARCHAR(50),
          lieu_dit VARCHAR(80),
          cadastral_area VARCHAR(50),
          titre_foncier VARCHAR(30) UNIQUE,
          lotissement VARCHAR(10),
          servitudes VARCHAR(10),
          num_Tit_Foncier_Mère VARCHAR(30),
          num_lot VARCHAR(255),
          co_owners VARCHAR(255),
          prop_cert_no VARCHAR(50),
          prop_cert_date DATE,
          geom GEOMETRY(Polygon, 32632),
          superficie_calculee NUMERIC GENERATED ALWAYS AS (ST_Area(geom)) STORED
      );
    `);

    await db.cloudQuery(`
      CREATE TABLE IF NOT EXISTS certificat_urbanisme (
          cu_id SERIAL PRIMARY KEY,
          personne_id INTEGER REFERENCES personne(personne_id) ON DELETE CASCADE,
          parcelle_id INTEGER REFERENCES parcelle(parcelle_id) ON DELETE CASCADE,
          cu_number VARCHAR(60) UNIQUE NOT NULL,
          num_dossier VARCHAR(30),
          date_demande DATE,
          qualite_demandeur VARCHAR(20),
          operation_demandee VARCHAR(40),
          "usage_du_Bati" VARCHAR(30),
          code_zone VARCHAR(10),
          nom_zone VARCHAR(150),
          largeur_voie_minimale_m NUMERIC(5,2),
          retrait_minimal_m NUMERIC(5,2),
          facade_minimale_m NUMERIC(5,2),
          superficie_parcelle_minimale_m2 NUMERIC(8,2),
          activites_interdites TEXT,
          date_delivrance DATE,
          date_expiration DATE,
          statut VARCHAR(20)
      );
    `);

    await db.cloudQuery(`
      CREATE TABLE IF NOT EXISTS permis_construire (
          permis_id SERIAL PRIMARY KEY,
          personne_id INTEGER REFERENCES personne(personne_id) ON DELETE CASCADE,
          parcelle_id INTEGER REFERENCES parcelle(parcelle_id) ON DELETE CASCADE,
          cu_id INTEGER REFERENCES certificat_urbanisme(cu_id) ON DELETE SET NULL,
          numero_permis VARCHAR(60),
          arrondissement VARCHAR(30),
          arrete_number VARCHAR(60),
          commission_date DATE,
          nature_travaux VARCHAR(40),
          nombre_planchers VARCHAR(30),
          etages_hors_sol VARCHAR(30),
          etages_sous_sol VARCHAR(30),
          usage_bati VARCHAR(30),
          nombre_places_parkings VARCHAR(20),
          hauteur_construction NUMERIC(5,2),
          building_cost VARCHAR(30),
          cout_total_projet NUMERIC(12,2),
          cos NUMERIC(4,2),
          ces NUMERIC(4,2),
          recul_voies_publiques NUMERIC(5,2),
          recul_limites_separatives NUMERIC(5,2),
          title_rec_no VARCHAR(50),
          architecte_responsable VARCHAR(150),
          architect_onac_no VARCHAR(20),
          status VARCHAR(20),
          input_database_date DATE DEFAULT CURRENT_DATE,
          issue_date DATE,
          expiry_date DATE,
          geom GEOMETRY(Polygon, 32632),
          superficie_calculee NUMERIC GENERATED ALWAYS AS (ST_Area(geom)) STORED
      );
    `);

    res.status(200).json({ message: 'All Supabase tables and PostGIS schemas created successfully by the backend!' });
  } catch (err) {
    console.error('Table setup error:', err);
    res.status(500).json({ error: 'Failed to create tables', details: err.message });
  }
});

// Migration Route: Sequentially copies all 5 tables to Supabase Cloud with full success metrics
app.get('/api/migrate-data', async (req, res) => {
  try {
    const localProp = await db.localQuery('SELECT * FROM proprietaire;');
    let propCount = 0;
    for (let row of localProp.rows) {
      await db.cloudQuery(
        `INSERT INTO proprietaire (proprietaire_id, nom_complet, nui, telephone, email, adresse, sexe, cni, nationalite) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (proprietaire_id) DO NOTHING;`,
        [row.proprietaire_id, row.nom_complet, row.nui, row.telephone, row.email, row.adresse, row.sexe, row.cni, row.nationalite]
      );
      propCount++;
    }

    const localPersons = await db.localQuery('SELECT * FROM personne;');
    let personCount = 0;
    for (let row of localPersons.rows) {
      await db.cloudQuery(
        `INSERT INTO personne (personne_id, nom_complet, nui, telephone, email, adresse, sexe, cni) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (personne_id) DO NOTHING;`,
        [row.personne_id, row.nom_complet, row.nui, row.telephone, row.email, row.adresse, row.sexe, row.cni]
      );
      personCount++;
    }

    const localParcels = await db.localQuery('SELECT * FROM parcelle;');
    let parcelCount = 0;
    for (let row of localParcels.rows) {
      await db.cloudQuery(
        `INSERT INTO parcelle (parcelle_id, proprietaire_id, plot_no, arrondissement, quartier, lieu_dit, cadastral_area, titre_foncier, lotissement, servitudes, num_Tit_Foncier_Mère, num_lot, co_owners, prop_cert_no, prop_cert_date, geom) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT (parcelle_id) DO NOTHING;`,
        [
          row.parcelle_id, row.proprietaire_id, row.plot_no, row.arrondissement, row.quartier, row.lieu_dit,
          row.cadastral_area, row.titre_foncier, row.lotissement, row.servitudes,
          row['num_tit_foncier_mère'] ?? row['num_Tit_Foncier_Mère'] ?? row.num_tit_foncier_mere ?? null,
          row.num_lot, row.co_owners, row.prop_cert_no, row.prop_cert_date, row.geom
        ]
      );
      parcelCount++;
    }

    const localCU = await db.localQuery('SELECT * FROM certificat_urbanisme;');
    let cuCount = 0;
    for (let row of localCU.rows) {
      await db.cloudQuery(
        `INSERT INTO certificat_urbanisme (cu_id, personne_id, parcelle_id, cu_number, num_dossier, date_demande, qualite_demandeur, operation_demandee, usage_du_bati, code_zone, nom_zone, largeur_voie_minimale_m, retrait_minimal_m, facade_minimale_m, superficie_parcelle_minimale_m2, activites_interdites, date_delivrance, date_expiration, statut)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) ON CONFLICT (cu_id) DO NOTHING;`,
        [row.cu_id, row.personne_id, row.parcelle_id, row.cu_number, row.num_dossier, row.date_demande, row.qualite_demandeur, row.operation_demandee, row.usage_du_bati, row.code_zone, row.nom_zone, row.largeur_voie_minimale_m, row.retrait_minimal_m, row.facade_minimale_m, row.superficie_parcelle_minimale_m2, row.activites_interdites, row.date_delivrance, row.date_expiration, row.statut]
      );
      cuCount++;
    }

    const localPermits = await db.localQuery('SELECT * FROM permis_construire;');
    let permitCount = 0;
    for (let row of localPermits.rows) {
      await db.cloudQuery(
        `INSERT INTO permis_construire (permis_id, personne_id, parcelle_id, cu_id, numero_permis, arrondissement, arrete_number, commission_date, nature_travaux, nombre_planchers, etages_hors_sol, etages_sous_sol, usage_Bati, nombre_places_parkings, hauteur_construction, building_cost, cout_total_projet, cos, ces, recul_voies_publiques, recul_limites_separatives, title_rec_no, architecte_responsable, architect_onac_no, status, input_database_date, issue_date, expiry_date, geom) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29) ON CONFLICT (permis_id) DO NOTHING;`,
        [row.permis_id, row.personne_id, row.parcelle_id, row.cu_id, row.numero_permis, row.arrondissement, row.arrete_number, row.commission_date, row.nature_travaux, row.nombre_planchers, row.etages_hors_sol, row.etages_sous_sol, row.usage_Bati, row.nombre_places_parkings, row.hauteur_construction, row.building_cost, row.cout_total_projet, row.cos, row.ces, row.recul_voies_publiques, row.recul_limites_separatives, row.title_rec_no, row.architecte_responsable, row.architect_onac_no, row.status, row.input_database_date, row.issue_date, row.expiry_date, row.geom]
      );
      permitCount++;
    }

    res.status(200).json({ 
      message: `Successfully migrated ${propCount} proprietaires, ${personCount} personnes, ${parcelCount} parcelles, ${cuCount} certificats d'urbanisme, and ${permitCount} permis de construire to Supabase Cloud!` 
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
