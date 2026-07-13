require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function fixDB() {
  console.log("🔧 Starting DB fix...");

  try {
    // ================= USERS =================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT,
        email TEXT UNIQUE,
        password TEXT,
        balance NUMERIC DEFAULT 0,
        pending_withdrawal NUMERIC DEFAULT 0,
        referral_code TEXT,
        referred_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ================= OFFERS =================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS offers (
        id SERIAL PRIMARY KEY,
        title TEXT,
        url TEXT,
        reward NUMERIC DEFAULT 0.20,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 🔥 FIX: convert INTEGER/0-1 active columns to BOOLEAN safely
    try {
      await pool.query(`
        ALTER TABLE offers
        ALTER COLUMN active TYPE BOOLEAN
        USING CASE WHEN active = 1 THEN TRUE ELSE FALSE END
      `);
      console.log("✔ offers.active fixed to BOOLEAN");
    } catch (err) {
      console.log("ℹ offers.active already BOOLEAN or not needed");
    }

    // Normalize values
    await pool.query(`UPDATE offers SET active = TRUE WHERE active = 1`);
    await pool.query(`UPDATE offers SET active = FALSE WHERE active = 0`);

    // ================= CLICKS =================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS clicks (
        id SERIAL PRIMARY KEY,
        offer_id INTEGER,
        email TEXT,
        ip TEXT,
        converted BOOLEAN DEFAULT FALSE,
        payout NUMERIC DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Fix converted column just in case
    try {
      await pool.query(`
        ALTER TABLE clicks
        ALTER COLUMN converted TYPE BOOLEAN
        USING CASE WHEN converted = 1 THEN TRUE ELSE FALSE END
      `);
      console.log("✔ clicks.converted fixed");
    } catch (err) {
      console.log("ℹ clicks.converted already OK");
    }

    // ================= WITHDRAWALS =================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        email TEXT,
        method TEXT,
        account TEXT,
        amount NUMERIC,
        status TEXT DEFAULT 'Pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // ================= NOTIFICATIONS (IMPORTANT FIX) =================
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("✅ DB FIX COMPLETED SUCCESSFULLY");
  } catch (err) {
    console.error("❌ DB FIX ERROR:", err);
  } finally {
    await pool.end();
  }
}

fixDB();