require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function fix() {
  try {
    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS referral_code TEXT;
    `);

    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS referred_by TEXT;
    `);

    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS pending_withdrawal NUMERIC DEFAULT 0;
    `);

    await pool.query(`
      ALTER TABLE clicks
      ADD COLUMN IF NOT EXISTS converted BOOLEAN DEFAULT FALSE;
    `);

    await pool.query(`
      ALTER TABLE clicks
      ADD COLUMN IF NOT EXISTS payout NUMERIC DEFAULT 0;
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Database fixed");
    process.exit();
  } catch (err) {
    console.error(err);
  }
}

fix();