require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function fixDB() {
  try {

    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS pending_withdrawal NUMERIC DEFAULT 0;
    `);

    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);

    await pool.query(`
      ALTER TABLE clicks
      ADD COLUMN IF NOT EXISTS converted BOOLEAN DEFAULT FALSE;
    `);

    await pool.query(`
      ALTER TABLE clicks
      ADD COLUMN IF NOT EXISTS payout NUMERIC DEFAULT 0;
    `);

    console.log("✅ Database updated successfully");

  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await pool.end();
  }
}

fixDB();