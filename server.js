const express = require('express');
const cors = require('cors');
const compression = require('compression'); // Compresses large GeoJSON payloads for performance
require('dotenv').config();

const db = require('./db'); // must export localQuery(sql, params) and cloudQuery(sql, params)

const app = express();

app.use(compression());
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'MBANI WebGIS API is running!' });
});

// =====================================================================
// MAIN VIEW QUERY: permit holder (pr), land owner (lo), applicant (p),
// parcel (pa), urban certificate (cu) and building permit (bp)
// =====================================================================
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

  FROM parcelle pa
  LEFT JOIN permis_construire bp ON pa.parcelle_id = bp.parcelle_id
  LEFT JOIN personne p ON bp.personne_id = p.personne_id
  LEFT JOIN proprietaire pr ON bp.personne_id = pr.proprietaire_id
  LEFT JOIN proprietaire lo ON pa.proprietaire_id = lo.proprietaire_id
  LEFT JOIN certificat_urbanisme cu ON bp.cu_id = cu.cu_id;
`;

// =====================================================================
// READ HELPER: local database first, Supabase cloud as fallback.
// On your laptop the local PostgreSQL answers; on Render (no local DB)
// the query automatically goes to Supabase.
// =====================================================================
async function queryWithLocalFirst(queryText, params = []) {
  try {
    return await db.localQuery(queryText, params);
  } catch (localErr) {
    try {
      return await db.cloudQuery(queryText, params);
    } catch (cloudErr) {
      console.error('Local error:', localErr.message, '| Cloud error:', cloudErr.message);
      throw cloudErr;
    }
  }
}

// =====================================================================
// BUILDING PERMIT ENDPOINTS
// =====================================================================
app.get('/api/building-permit', async (req, res) => {
  try {
    const result = await queryWithLocalFirst(getBuildingPermitQuery());
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Building Permit Query Error:', err.message);
    res.status(500).json({ error: 'Server error fetching building permit data', details: err.message });
  }
});

// Explicit cloud / local endpoints (handy to compare both databases in Chrome)
app.get('/api/cloud-building-permit', async (req, res) => {
  try {
    const result = await db.cloudQuery(getBuildingPermitQuery());
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Cloud Database Query Error:', err.message);
    res.status(500).json({ error: 'Server error fetching cloud building permit', details: err.message });
  }
});

app.get('/api/local-building-permit', async (req, res) => {
  try {
    const result = await db.localQuery(getBuildingPermitQuery());
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Local Database Query Error:', err.message);
    res.status(500).json({ error: 'Server error fetching local building permit', details: err.message });
  }
});

// =====================================================================
// ZONING / QUARTIERS / PARCELS
// =====================================================================
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
      type: 'Feature',
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

    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error('Zoning BBox Query Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch unified zoning data', details: err.message });
  }
});

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
      type: 'Feature',
      geometry: typeof row.geometry === 'string' ? JSON.parse(row.geometry) : row.geometry,
      properties: {
        id: row.id,
        name: row.name || 'Unknown Quartier',
        commune: row.commune || 'N/A'
      }
    }));

    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error('Quartiers BBox Query Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch quartiers data', details: err.message });
  }
});

// Parcelles BBox: groups all building permits of each parcel into an array
app.get('/api/parcelles/bbox', async (req, res) => {
  const { minLng, minLat, maxLng, maxLat } = req.query;

  try {
    const query = `
      SELECT 
        pa.parcelle_id, 
        pa.plot_no,
        pa.titre_foncier,
        pa.arrondissement,
        pa.quartier,
        ST_AsGeoJSON(ST_Transform(pa.geom, 4326))::json AS geometry,
        COALESCE(
          json_agg(
            json_build_object(
              'permis_id', bp.permis_id,
              'numero_permis', bp.numero_permis,
              'usage_bati', bp.usage_bati,
              'status', bp.status,
              'issue_date', bp.issue_date
            )
          ) FILTER (WHERE bp.permis_id IS NOT NULL),
          '[]'::json
        ) AS building_permits
      FROM "parcelle" pa
      LEFT JOIN "permis_construire" bp ON pa.parcelle_id = bp.parcelle_id
      WHERE pa.geom && ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), 32632)
      GROUP BY pa.parcelle_id, pa.plot_no, pa.titre_foncier, pa.arrondissement, pa.quartier, pa.geom;
    `;

    const result = await queryWithLocalFirst(query, [minLng, minLat, maxLng, maxLat]);

    const features = result.rows.map(row => ({
      type: 'Feature',
      geometry: typeof row.geometry === 'string' ? JSON.parse(row.geometry) : row.geometry,
      properties: {
        id: row.parcelle_id,
        plot_no: row.plot_no || 'N/A',
        titre_foncier: row.titre_foncier || 'N/A',
        arrondissement: row.arrondissement || 'N/A',
        quartier: row.quartier || 'N/A',
        building_permits: row.building_permits
      }
    }));

    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    console.error('Parcelles BBox Query Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch parcelles data', details: err.message });
  }
});

// Spatial lookup: parcel zoning & quartier diagnosis
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
      return res.status(404).json({ error: 'Parcel not found or outside covered spatial data limits.' });
    }

    const info = result.rows[0];
    const vocation = (info.zone_type || '').toLowerCase();
    let constructibilityStatus = 'Constructible';
    let statusColor = '#2ecc71'; // Green

    if (vocation.includes('non constructible') || vocation.includes('pente') || vocation.includes('inondable') || vocation.includes('marécage') || vocation.includes('vert')) {
      constructibilityStatus = 'Non-Constructible (Zone Protégée/Risque)';
      statusColor = '#e74c3c'; // Red
    } else if (vocation.includes('sous condition') || vocation.includes('special')) {
      constructibilityStatus = 'Constructibilité Sous Condition';
      statusColor = '#f39c12'; // Orange
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
    console.error('Spatial Info Error:', err.message);
    res.status(500).json({ error: 'Failed to evaluate spatial overlap', details: err.message });
  }
});

// Sync & Insert Endpoint: the new permit is saved in LOCAL and CLOUD with the same permis_id
app.post('/api/sync-building-permit', async (req, res) => {
  const { numero_permis, personne_id, parcelle_id, usage_bati, status, arrondissement } = req.body;

  const queryText = `
    INSERT INTO permis_construire (numero_permis, personne_id, parcelle_id, usage_bati, status, arrondissement)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *;
  `;
  const values = [numero_permis, personne_id, parcelle_id, usage_bati, status, arrondissement];

  try {
    let saved = null, localOk = false, cloudOk = false;

    try { saved = (await db.localQuery(queryText, values)).rows[0]; localOk = true; }
    catch (e) { console.warn('Local insert skipped:', e.message); }

    try {
      if (saved) {
        await db.cloudQuery(
          `INSERT INTO permis_construire (permis_id, numero_permis, personne_id, parcelle_id, usage_bati, status, arrondissement)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (permis_id) DO UPDATE SET
             numero_permis = EXCLUDED.numero_permis, personne_id = EXCLUDED.personne_id,
             parcelle_id = EXCLUDED.parcelle_id, usage_bati = EXCLUDED.usage_bati,
             status = EXCLUDED.status, arrondissement = EXCLUDED.arrondissement;`,
          [saved.permis_id, numero_permis, personne_id, parcelle_id, usage_bati, status, arrondissement]
        );
      } else {
        saved = (await db.cloudQuery(queryText, values)).rows[0];
      }
      cloudOk = true;
    } catch (e) { console.error('Cloud insert failed:', e.message); }

    if (!localOk && !cloudOk) throw new Error('Could not save in the local or the cloud database');

    res.status(201).json({
      message: localOk && cloudOk ? 'Permit saved in local and Supabase cloud databases.' : 'Permit saved in one database only.',
      local: localOk,
      cloud: cloudOk,
      record: saved
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
          usage_du_Bati VARCHAR(30),
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

// Helpers for the migration route: one upsert on the cloud that records any row error
// Runs one INSERT ... ON CONFLICT DO UPDATE on the cloud and records any row error
async function cloudUpsert(stats, id, sql, params) {
  try { await db.cloudQuery(sql, params); stats.ok++; }
  catch (e) { stats.errors.push({ id, error: e.message }); }
}
const newStats = () => ({ ok: 0, errors: [] });

// Migration Route: copies all 5 tables from LOCAL to Supabase Cloud.
// Existing cloud rows are now UPDATED (geometry included) instead of skipped.
app.get('/api/migrate-data', async (req, res) => {
  try {
    const sProp = newStats(), sPerson = newStats(), sParcel = newStats(), sCU = newStats(), sPermit = newStats();

    const localProp = await db.localQuery('SELECT * FROM proprietaire ORDER BY proprietaire_id;');
    for (let row of localProp.rows) {
      await cloudUpsert(sProp, row.proprietaire_id,
        `INSERT INTO proprietaire (proprietaire_id, nom_complet, nui, telephone, email, adresse, sexe, cni, nationalite) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (proprietaire_id) DO UPDATE SET
           nom_complet = EXCLUDED.nom_complet, nui = EXCLUDED.nui, telephone = EXCLUDED.telephone,
           email = EXCLUDED.email, adresse = EXCLUDED.adresse, sexe = EXCLUDED.sexe,
           cni = EXCLUDED.cni, nationalite = EXCLUDED.nationalite;`,
        [row.proprietaire_id, row.nom_complet, row.nui, row.telephone, row.email, row.adresse, row.sexe, row.cni, row.nationalite]
      );
    }

    const localPersons = await db.localQuery('SELECT * FROM personne ORDER BY personne_id;');
    for (let row of localPersons.rows) {
      await cloudUpsert(sPerson, row.personne_id,
        `INSERT INTO personne (personne_id, nom_complet, nui, telephone, email, adresse, sexe, cni) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (personne_id) DO UPDATE SET
           nom_complet = EXCLUDED.nom_complet, nui = EXCLUDED.nui, telephone = EXCLUDED.telephone,
           email = EXCLUDED.email, adresse = EXCLUDED.adresse, sexe = EXCLUDED.sexe, cni = EXCLUDED.cni;`,
        [row.personne_id, row.nom_complet, row.nui, row.telephone, row.email, row.adresse, row.sexe, row.cni]
      );
    }

    const localParcels = await db.localQuery('SELECT * FROM parcelle ORDER BY parcelle_id;');
    for (let row of localParcels.rows) {
      await cloudUpsert(sParcel, row.parcelle_id,
        `INSERT INTO parcelle (parcelle_id, proprietaire_id, plot_no, arrondissement, quartier, lieu_dit, cadastral_area, titre_foncier, lotissement, servitudes, num_Tit_Foncier_Mère, num_lot, co_owners, prop_cert_no, prop_cert_date, geom) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (parcelle_id) DO UPDATE SET
           proprietaire_id = EXCLUDED.proprietaire_id, plot_no = EXCLUDED.plot_no,
           arrondissement = EXCLUDED.arrondissement, quartier = EXCLUDED.quartier, lieu_dit = EXCLUDED.lieu_dit,
           cadastral_area = EXCLUDED.cadastral_area, titre_foncier = EXCLUDED.titre_foncier,
           lotissement = EXCLUDED.lotissement, servitudes = EXCLUDED.servitudes,
           num_Tit_Foncier_Mère = EXCLUDED.num_Tit_Foncier_Mère, num_lot = EXCLUDED.num_lot,
           co_owners = EXCLUDED.co_owners, prop_cert_no = EXCLUDED.prop_cert_no,
           prop_cert_date = EXCLUDED.prop_cert_date, geom = EXCLUDED.geom;`,
        [
          row.parcelle_id, row.proprietaire_id, row.plot_no, row.arrondissement, row.quartier, row.lieu_dit,
          row.cadastral_area, row.titre_foncier, row.lotissement, row.servitudes,
          row['num_tit_foncier_mère'] ?? row['num_Tit_Foncier_Mère'] ?? row.num_tit_foncier_mere ?? null,
          row.num_lot, row.co_owners, row.prop_cert_no, row.prop_cert_date, row.geom
        ]
      );
    }

    const localCU = await db.localQuery('SELECT * FROM certificat_urbanisme ORDER BY cu_id;');
    for (let row of localCU.rows) {
      await cloudUpsert(sCU, row.cu_id,
        `INSERT INTO certificat_urbanisme (cu_id, personne_id, parcelle_id, cu_number, num_dossier, date_demande, qualite_demandeur, operation_demandee, usage_du_bati, code_zone, nom_zone, largeur_voie_minimale_m, retrait_minimal_m, facade_minimale_m, superficie_parcelle_minimale_m2, activites_interdites, date_delivrance, date_expiration, statut)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (cu_id) DO UPDATE SET
           personne_id = EXCLUDED.personne_id, parcelle_id = EXCLUDED.parcelle_id, cu_number = EXCLUDED.cu_number,
           num_dossier = EXCLUDED.num_dossier, date_demande = EXCLUDED.date_demande,
           qualite_demandeur = EXCLUDED.qualite_demandeur, operation_demandee = EXCLUDED.operation_demandee,
           usage_du_bati = EXCLUDED.usage_du_bati, code_zone = EXCLUDED.code_zone, nom_zone = EXCLUDED.nom_zone,
           largeur_voie_minimale_m = EXCLUDED.largeur_voie_minimale_m, retrait_minimal_m = EXCLUDED.retrait_minimal_m,
           facade_minimale_m = EXCLUDED.facade_minimale_m,
           superficie_parcelle_minimale_m2 = EXCLUDED.superficie_parcelle_minimale_m2,
           activites_interdites = EXCLUDED.activites_interdites, date_delivrance = EXCLUDED.date_delivrance,
           date_expiration = EXCLUDED.date_expiration, statut = EXCLUDED.statut;`,
        [row.cu_id, row.personne_id, row.parcelle_id, row.cu_number, row.num_dossier, row.date_demande, row.qualite_demandeur, row.operation_demandee, row.usage_du_bati, row.code_zone, row.nom_zone, row.largeur_voie_minimale_m, row.retrait_minimal_m, row.facade_minimale_m, row.superficie_parcelle_minimale_m2, row.activites_interdites, row.date_delivrance, row.date_expiration, row.statut]
      );
    }

    const localPermits = await db.localQuery('SELECT * FROM permis_construire ORDER BY permis_id;');
    for (let row of localPermits.rows) {
      await cloudUpsert(sPermit, row.permis_id,
        `INSERT INTO permis_construire (permis_id, personne_id, parcelle_id, cu_id, numero_permis, arrondissement, arrete_number, commission_date, nature_travaux, nombre_planchers, etages_hors_sol, etages_sous_sol, usage_bati, nombre_places_parkings, hauteur_construction, building_cost, cout_total_projet, cos, ces, recul_voies_publiques, recul_limites_separatives, title_rec_no, architecte_responsable, architect_onac_no, status, input_database_date, issue_date, expiry_date, geom) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
         ON CONFLICT (permis_id) DO UPDATE SET
           personne_id = EXCLUDED.personne_id, parcelle_id = EXCLUDED.parcelle_id, cu_id = EXCLUDED.cu_id,
           numero_permis = EXCLUDED.numero_permis, arrondissement = EXCLUDED.arrondissement,
           arrete_number = EXCLUDED.arrete_number, commission_date = EXCLUDED.commission_date,
           nature_travaux = EXCLUDED.nature_travaux, nombre_planchers = EXCLUDED.nombre_planchers,
           etages_hors_sol = EXCLUDED.etages_hors_sol, etages_sous_sol = EXCLUDED.etages_sous_sol,
           usage_bati = EXCLUDED.usage_bati, nombre_places_parkings = EXCLUDED.nombre_places_parkings,
           hauteur_construction = EXCLUDED.hauteur_construction, building_cost = EXCLUDED.building_cost,
           cout_total_projet = EXCLUDED.cout_total_projet, cos = EXCLUDED.cos, ces = EXCLUDED.ces,
           recul_voies_publiques = EXCLUDED.recul_voies_publiques,
           recul_limites_separatives = EXCLUDED.recul_limites_separatives, title_rec_no = EXCLUDED.title_rec_no,
           architecte_responsable = EXCLUDED.architecte_responsable, architect_onac_no = EXCLUDED.architect_onac_no,
           status = EXCLUDED.status, input_database_date = EXCLUDED.input_database_date,
           issue_date = EXCLUDED.issue_date, expiry_date = EXCLUDED.expiry_date, geom = EXCLUDED.geom;`,
        [row.permis_id, row.personne_id, row.parcelle_id, row.cu_id, row.numero_permis, row.arrondissement, row.arrete_number, row.commission_date, row.nature_travaux, row.nombre_planchers, row.etages_hors_sol, row.etages_sous_sol, row.usage_bati, row.nombre_places_parkings, row.hauteur_construction, row.building_cost, row.cout_total_projet, row.cos, row.ces, row.recul_voies_publiques, row.recul_limites_separatives, row.title_rec_no, row.architecte_responsable, row.architect_onac_no, row.status, row.input_database_date, row.issue_date, row.expiry_date, row.geom]
      );
    }

    // Keep the cloud auto-number counters in step with the copied IDs
    for (const [t, pk] of [['proprietaire', 'proprietaire_id'], ['personne', 'personne_id'], ['parcelle', 'parcelle_id'], ['certificat_urbanisme', 'cu_id'], ['permis_construire', 'permis_id']]) {
      await db.cloudQuery(`SELECT setval(pg_get_serial_sequence('${t}', '${pk}'), COALESCE(MAX(${pk}), 1)) FROM ${t};`).catch(() => {});
    }

    const failed = sProp.errors.length + sPerson.errors.length + sParcel.errors.length + sCU.errors.length + sPermit.errors.length;
    res.status(200).json({
      message: `Migrated ${sProp.ok} proprietaires, ${sPerson.ok} personnes, ${sParcel.ok} parcelles, ${sCU.ok} certificats d'urbanisme, and ${sPermit.ok} permis de construire to Supabase Cloud (existing rows updated). Failed rows: ${failed}.`,
      errors: { proprietaire: sProp.errors, personne: sPerson.errors, parcelle: sParcel.errors, certificat_urbanisme: sCU.errors, permis_construire: sPermit.errors }
    });
  } catch (err) {
    console.error('Migration error:', err);
    res.status(500).json({ error: 'Migration failed', details: err.message });
  }
});

// Compare both databases: row counts, rows missing on one side, and rows whose geometry differs
app.get('/api/sync-status', async (req, res) => {
  try {
    const tables = [['proprietaire', 'proprietaire_id'], ['personne', 'personne_id'], ['parcelle', 'parcelle_id'], ['certificat_urbanisme', 'cu_id'], ['permis_construire', 'permis_id']];
    const status = {};
    for (const [table, pk] of tables) {
      const hasGeom = table === 'parcelle' || table === 'permis_construire';
      const sql = hasGeom
        ? `SELECT ${pk} AS id, md5(COALESCE(ST_AsEWKT(geom), '')) AS h FROM ${table};`
        : `SELECT ${pk} AS id, '' AS h FROM ${table};`;
      const [l, c] = await Promise.all([db.localQuery(sql), db.cloudQuery(sql)]);
      const lm = new Map(l.rows.map(r => [String(r.id), r.h]));
      const cm = new Map(c.rows.map(r => [String(r.id), r.h]));
      status[table] = {
        local_rows: lm.size,
        cloud_rows: cm.size,
        missing_in_cloud: [...lm.keys()].filter(id => !cm.has(id)),
        missing_in_local: [...cm.keys()].filter(id => !lm.has(id)),
        geometry_differs: [...lm.keys()].filter(id => cm.has(id) && lm.get(id) !== cm.get(id))
      };
    }
    const inSync = Object.values(status).every(s => !s.missing_in_cloud.length && !s.missing_in_local.length && !s.geometry_differs.length);
    res.json({ in_sync: inSync, status });
  } catch (err) {
    console.error('Sync status error:', err);
    res.status(500).json({ error: 'Could not compare databases', details: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running smoothly on http://localhost:${PORT}`);
});
