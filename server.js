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

// Updated SQL Query matching the exact latest schema & column modifications
const getBuildingPermitQuery = () => `
  SELECT
      -- 1. PERSONNE : DEMANDEUR
      p_app.personne_id AS demandeur_id,
      p_app.nom_complet AS demandeur_nom,
      p_app.nui AS demandeur_nui,
      p_app.telephone AS demandeur_telephone,
      p_app.email AS demandeur_email,
      p_app.adresse AS demandeur_adresse,
      p_app.sexe AS demandeur_sexe,
      p_app.cni AS demandeur_cni,
      p_app.nationalite AS demandeur_nationalite,

      -- 2. PARCELLE
      pa.parcelle_id,
    pa.plot_no,
    pa.arrondissement,
    pa.quartier,
    pa.lieu_dit,
    pa.cadastral_area,
    pa.titre_foncier,
    pa.lotissement,
    pa.servitudes,
    pa.num_tit_foncier_mère AS num_tit_foncier_mere,
    pa.num_lot,
    pa.co_owners,
    pa.prop_cert_no,
    pa.prop_cert_date,
      ST_AsGeoJSON(ST_Transform(pa.geom, 4326))::json AS parcel_geom,
      pa.superficie_calculee AS parcel_calculated_area,

      -- 3. CERTIFICAT D'URBANISME
      cu.cu_id,
      cu.cu_number,
      cu.num_dossier AS cu_num_dossier,
      cu.date_demande,
      cu.qualite_demandeur,
      cu.operation_demandee,
      cu.usage_du_bati AS cu_usage_bati,
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

      -- 4. PERMIS DE CONSTRUIRE
      bp.permis_id,
      bp.numero_permis,
      bp.arrete_number,
      bp.technical_file_no,
      bp.commission_date,
      bp.nature_travaux,
      bp.nombre_planchers,
      bp.etages_hors_sol,
      bp.etages_sous_sol,
      bp.usage_bati,
      bp.nombre_places_parkings,
      bp.hauteur_construction,
      bp.superficie_terrain,
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

      -- 5. GEOMETRIE COMBINEE (parcelle + batiment)
      ST_AsGeoJSON(ST_Transform(ST_Collect(pa.geom, bp.geom), 4326))::json AS parcel_and_building_geom,

      -- 6. VERIFICATIONS SPATIALES
      ST_Intersects(bp.geom, pa.geom) AS building_intersects_parcel,
      ST_Contains(pa.geom, bp.geom) AS building_fully_contained_in_parcel,

      CASE
          WHEN cu.retrait_minimal_m IS NOT NULL
              THEN bp.recul_voies_publiques >= cu.retrait_minimal_m
          ELSE TRUE
      END AS setback_ok

  FROM permis_construire bp
  LEFT JOIN personne p_app ON bp.demandeur_id = p_app.personne_id
  LEFT JOIN parcelle pa ON bp.parcelle_id = pa.parcelle_id
  LEFT JOIN personne p_own ON pa.proprietaire_id = p_own.personne_id
  LEFT JOIN certificat_urbanisme cu ON bp.cu_id = cu.cu_id;
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

    // TABLE: PERSONNE
    await db.cloudQuery(`
      CREATE TABLE IF NOT EXISTS personne (
        personne_id SERIAL PRIMARY KEY,
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

    // TABLE: PARCELLE
    await db.cloudQuery(`
      CREATE TABLE IF NOT EXISTS parcelle (
        parcelle_id SERIAL PRIMARY KEY,
        geom GEOMETRY(Polygon, 32632) NOT NULL,
        superficie_calculee NUMERIC GENERATED ALWAYS AS (ST_Area(geom)) STORED,
        proprietaire_id INTEGER REFERENCES personne(personne_id) ON DELETE SET NULL,
        plot_no VARCHAR(50) UNIQUE NOT NULL,
        arrondissement VARCHAR(30),
        quartier VARCHAR(50),
        lieu_dit VARCHAR(80),
        cadastral_area VARCHAR(50),
        titre_foncier VARCHAR(30) UNIQUE,
        lotissement VARCHAR(10),
        servitudes VARCHAR(10),
        num_tit_foncier_mere VARCHAR(30),
        num_lot VARCHAR(255),
        co_owners VARCHAR(255),
        prop_cert_no VARCHAR(50),
        prop_cert_date DATE
      );
    `);

    // TABLE: CERTIFICAT D'URBANISME
    await db.cloudQuery(`
      CREATE TABLE IF NOT EXISTS certificat_urbanisme (
        cu_id SERIAL PRIMARY KEY,
        demandeur_id INTEGER REFERENCES personne(personne_id) ON DELETE CASCADE,
        parcelle_id INTEGER REFERENCES parcelle(parcelle_id) ON DELETE CASCADE,
        cu_number VARCHAR(60) UNIQUE NOT NULL,
        num_dossier VARCHAR(30),
        date_demande DATE,
        qualite_demandeur VARCHAR(20),
        operation_demandee VARCHAR(40),
        usage_du_bati VARCHAR(30),
        code_zone VARCHAR(10) NOT NULL,
        nom_zone VARCHAR(150) NOT NULL,
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

    // TABLE: PERMIS DE CONSTRUIRE
    await db.cloudQuery(`
      CREATE TABLE IF NOT EXISTS permis_construire (
        permis_id SERIAL PRIMARY KEY,
        geom GEOMETRY(Polygon, 32632) NOT NULL,
        superficie_calculee NUMERIC GENERATED ALWAYS AS (ST_Area(geom)) STORED,
        demandeur_id INTEGER REFERENCES personne(personne_id) ON DELETE CASCADE,
        parcelle_id INTEGER REFERENCES parcelle(parcelle_id) ON DELETE CASCADE,
        cu_id INTEGER REFERENCES certificat_urbanisme(cu_id) ON DELETE SET NULL,
        numero_permis VARCHAR(60) UNIQUE,
        arrete_number VARCHAR(60),
        technical_file_no VARCHAR(30),
        commission_date DATE,
        nature_travaux VARCHAR(40),
        nombre_planchers VARCHAR(30),
        etages_hors_sol VARCHAR(30),
        etages_sous_sol VARCHAR(30),
        usage_bati VARCHAR(30),
        nombre_places_parkings VARCHAR(20),
        hauteur_construction NUMERIC(5,2),
        superficie_terrain NUMERIC(12,2),
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
        expiry_date DATE
      );
    `);

    res.status(200).json({ message: 'All Supabase tables and PostGIS schemas created successfully!' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create tables', details: err.message });
  }
});

// Sync handler function updated to new tables & columns
const pushLocalDataHandler = async (req, res) => {
  try {
    const localPersons = await db.localQuery('SELECT * FROM personne;');
    for (let row of localPersons.rows) {
      await db.cloudQuery(
        `INSERT INTO personne (personne_id, nom_complet, nui, telephone, email, adresse, sexe, cni, nationalite) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
         ON CONFLICT (personne_id) DO UPDATE SET
           nom_complet = EXCLUDED.nom_complet, nui = EXCLUDED.nui, telephone = EXCLUDED.telephone, 
           email = EXCLUDED.email, adresse = EXCLUDED.adresse, sexe = EXCLUDED.sexe, 
           cni = EXCLUDED.cni, nationalite = EXCLUDED.nationalite;`,
        [row.personne_id, row.nom_complet, row.nui, row.telephone, row.email, row.adresse, row.sexe, row.cni, row.nationalite]
      );
    }

    const localParcels = await db.localQuery('SELECT * FROM parcelle;');
    for (let row of localParcels.rows) {
      await db.cloudQuery(
        `INSERT INTO parcelle (parcelle_id, geom, proprietaire_id, plot_no, arrondissement, quartier, lieu_dit, cadastral_area, titre_foncier, lotissement, servitudes, num_tit_foncier_mere, num_lot, co_owners, prop_cert_no, prop_cert_date) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) 
         ON CONFLICT (parcelle_id) DO UPDATE SET
           geom = EXCLUDED.geom, proprietaire_id = EXCLUDED.proprietaire_id, plot_no = EXCLUDED.plot_no, 
           arrondissement = EXCLUDED.arrondissement, quartier = EXCLUDED.quartier, lieu_dit = EXCLUDED.lieu_dit, 
           cadastral_area = EXCLUDED.cadastral_area, titre_foncier = EXCLUDED.titre_foncier, 
           lotissement = EXCLUDED.lotissement, servitudes = EXCLUDED.servitudes, 
           num_tit_foncier_mere = EXCLUDED.num_tit_foncier_mere, num_lot = EXCLUDED.num_lot, 
           co_owners = EXCLUDED.co_owners, prop_cert_no = EXCLUDED.prop_cert_no, prop_cert_date = EXCLUDED.prop_cert_date;`,
        [row.parcelle_id, row.geom, row.proprietaire_id, row.plot_no, row.arrondissement, row.quartier, row.lieu_dit, row.cadastral_area, row.titre_foncier, row.lotissement, row.servitudes, row.num_tit_foncier_mere || row.num_Tit_Foncier_Mère, row.num_lot, row.co_owners, row.prop_cert_no, row.prop_cert_date]
      );
    }

    const localCU = await db.localQuery('SELECT * FROM certificat_urbanisme;');
    for (let row of localCU.rows) {
      await db.cloudQuery(
        `INSERT INTO certificat_urbanisme (cu_id, demandeur_id, parcelle_id, cu_number, num_dossier, date_demande, qualite_demandeur, operation_demandee, usage_du_bati, code_zone, nom_zone, largeur_voie_minimale_m, retrait_minimal_m, facade_minimale_m, superficie_parcelle_minimale_m2, activites_interdites, date_delivrance, date_expiration, statut)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (cu_id) DO UPDATE SET
           demandeur_id = EXCLUDED.demandeur_id, parcelle_id = EXCLUDED.parcelle_id, cu_number = EXCLUDED.cu_number, 
           num_dossier = EXCLUDED.num_dossier, date_demande = EXCLUDED.date_demande, qualite_demandeur = EXCLUDED.qualite_demandeur, 
           operation_demandee = EXCLUDED.operation_demandee, usage_du_bati = EXCLUDED.usage_du_bati, 
           code_zone = EXCLUDED.code_zone, nom_zone = EXCLUDED.nom_zone, largeur_voie_minimale_m = EXCLUDED.largeur_voie_minimale_m, 
           retrait_minimal_m = EXCLUDED.retrait_minimal_m, facade_minimale_m = EXCLUDED.facade_minimale_m, 
           superficie_parcelle_minimale_m2 = EXCLUDED.superficie_parcelle_minimale_m2, activites_interdites = EXCLUDED.activites_interdites, 
           date_delivrance = EXCLUDED.date_delivrance, date_expiration = EXCLUDED.date_expiration, statut = EXCLUDED.statut;`,
        [row.cu_id, row.demandeur_id, row.parcelle_id, row.cu_number, row.num_dossier || row.num_Dossier, row.date_demande, row.qualite_demandeur, row.operation_demandee, row.usage_du_bati || row.usage_du_Bati, row.code_zone, row.nom_zone, row.largeur_voie_minimale_m, row.retrait_minimal_m, row.facade_minimale_m, row.superficie_parcelle_minimale_m2, row.activites_interdites, row.date_delivrance, row.date_expiration, row.statut]
      );
    }

    const localPermits = await db.localQuery('SELECT * FROM permis_construire;');
    for (let row of localPermits.rows) {
      await db.cloudQuery(
        `INSERT INTO permis_construire (permis_id, geom, demandeur_id, parcelle_id, cu_id, numero_permis, arrete_number, technical_file_no, commission_date, nature_travaux, nombre_planchers, etages_hors_sol, etages_sous_sol, usage_bati, nombre_places_parkings, hauteur_construction, superficie_terrain, building_cost, cout_total_projet, cos, ces, recul_voies_publiques, recul_limites_separatives, title_rec_no, architecte_responsable, architect_onac_no, status, input_database_date, issue_date, expiry_date) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30) 
         ON CONFLICT (permis_id) DO UPDATE SET
           geom = EXCLUDED.geom, demandeur_id = EXCLUDED.demandeur_id, parcelle_id = EXCLUDED.parcelle_id, cu_id = EXCLUDED.cu_id, 
           numero_permis = EXCLUDED.numero_permis, arrete_number = EXCLUDED.arrete_number, technical_file_no = EXCLUDED.technical_file_no, 
           commission_date = EXCLUDED.commission_date, nature_travaux = EXCLUDED.nature_travaux, nombre_planchers = EXCLUDED.nombre_planchers, 
           etages_hors_sol = EXCLUDED.etages_hors_sol, etages_sous_sol = EXCLUDED.etages_sous_sol, usage_bati = EXCLUDED.usage_bati, 
           nombre_places_parkings = EXCLUDED.nombre_places_parkings, hauteur_construction = EXCLUDED.hauteur_construction, 
           superficie_terrain = EXCLUDED.superficie_terrain, building_cost = EXCLUDED.building_cost, cout_total_projet = EXCLUDED.cout_total_projet, 
           cos = EXCLUDED.cos, ces = EXCLUDED.ces, recul_voies_publiques = EXCLUDED.recul_voies_publiques, 
           recul_limites_separatives = EXCLUDED.recul_limites_separatives, title_rec_no = EXCLUDED.title_rec_no, 
           architecte_responsable = EXCLUDED.architecte_responsable, architect_onac_no = EXCLUDED.architect_onac_no, 
           status = EXCLUDED.status, input_database_date = EXCLUDED.input_database_date, issue_date = EXCLUDED.issue_date, 
           expiry_date = EXCLUDED.expiry_date;`,
        [row.permis_id, row.geom, row.demandeur_id, row.parcelle_id, row.cu_id, row.numero_permis, row.arrete_number, row.technical_file_no, row.commission_date, row.nature_travaux, row.nombre_planchers, row.etages_hors_sol, row.etages_sous_sol, row.usage_bati, row.nombre_places_parkings, row.hauteur_construction, row.superficie_terrain, row.building_cost, row.cout_total_projet, row.cos, row.ces, row.recul_voies_publiques, row.recul_limites_separatives, row.title_rec_no, row.architecte_responsable, row.architect_onac_no, row.status, row.input_database_date, row.issue_date, row.expiry_date]
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
