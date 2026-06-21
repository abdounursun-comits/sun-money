require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const POSTBACK_SECRET = process.env.POSTBACK_SECRET;

if (!JWT_SECRET || !ADMIN_SECRET || !POSTBACK_SECRET) {
  console.error("❌ Missing env secrets");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ================= INIT DB =================
async function initDB() {
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

  console.log("✅ DB READY");
}
initDB();

// ================= AUTH =================
function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
}

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No admin token" });

  jwt.verify(token, ADMIN_SECRET, (err) => {
    if (err) return res.status(403).json({ error: "Invalid admin token" });
    next();
  });
}

// ================= PAGES =================
app.get("/", (req, res) => res.redirect("/auth"));
app.get("/auth", (req, res) => res.sendFile(path.join(__dirname, "auth.html")));
app.get("/dashboard", (req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/withdraw", (req, res) => res.sendFile(path.join(__dirname, "withdraw.html")));
app.get("/offers", (req, res) => res.sendFile(path.join(__dirname, "offers.html")));

// ================= REGISTER =================
app.post("/register", async (req, res) => {
  const { username, email, password, referral } = req.body;

  const hash = await bcrypt.hash(password, 10);
  const code = Math.random().toString(36).substring(2, 8);

  await pool.query(
    `INSERT INTO users(username,email,password,referral_code,referred_by)
     VALUES($1,$2,$3,$4,$5)`,
    [username, email, hash, code, referral || null]
  );

  res.json({ success: true });
});

// ================= LOGIN =================
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const r = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
  if (!r.rows.length) return res.status(400).json({ error: "User not found" });

  const user = r.rows[0];

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(400).json({ error: "Wrong password" });

  const token = jwt.sign(
    { id: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ success: true, token, user });
});

// ================= ADMIN LOGIN =================
app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;

  if (username === "sunadmin" && password === "sun2026") {
    const token = jwt.sign({ admin: true }, ADMIN_SECRET, { expiresIn: "7d" });
    return res.json({ success: true, token });
  }

  res.status(401).json({ error: "Invalid admin login" });
});

// ================= OFFERS (USER) =================
app.get("/api/offers", async (req, res) => {
  const result = await pool.query(
    "SELECT id,title,url,reward FROM offers WHERE active=true ORDER BY id DESC"
  );

  res.json(result.rows);
});

// ================= ADMIN OFFERS (CLEAN ONLY ONCE) =================

// GET ALL OFFERS
app.get("/admin/offers", adminAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM offers ORDER BY id DESC");
  res.json(result.rows);
});

// CREATE OFFER
app.post("/admin/offers", adminAuth, async (req, res) => {
  const { title, url, reward } = req.body;

  const result = await pool.query(
    "INSERT INTO offers(title,url,reward) VALUES($1,$2,$3) RETURNING *",
    [title, url, reward || 0.2]
  );

  res.json(result.rows[0]);
});

// ENABLE / DISABLE
app.post("/admin/offers/:id/enable", adminAuth, async (req, res) => {
  await pool.query("UPDATE offers SET active=true WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

app.post("/admin/offers/:id/disable", adminAuth, async (req, res) => {
  await pool.query("UPDATE offers SET active=false WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// DELETE OFFER
app.delete("/admin/offers/:id", adminAuth, async (req, res) => {
  await pool.query("DELETE FROM offers WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});

// ================= CLICK TRACKING =================
app.get("/click/:offerId", async (req, res) => {
  const { offerId } = req.params;
  const { email } = req.query;

  const ip = req.ip;

  const offer = await pool.query(
    "SELECT * FROM offers WHERE id=$1 AND active=true",
    [offerId]
  );

  if (!offer.rows.length) return res.status(404).send("Offer not found");

  const click = await pool.query(
    "INSERT INTO clicks(offer_id,email,ip) VALUES($1,$2,$3) RETURNING id",
    [offerId, email || "", ip]
  );

  let url = offer.rows[0].url;
  const clickId = click.rows[0].id;

  url += url.includes("?")
    ? `&click_id=${clickId}`
    : `?click_id=${clickId}`;

  res.redirect(url);
});

// ================= POSTBACK =================
app.get("/postback", async (req, res) => {
  const { click_id, secret } = req.query;

  if (secret !== POSTBACK_SECRET) {
    return res.status(403).send("INVALID");
  }

  const click = await pool.query("SELECT * FROM clicks WHERE id=$1", [click_id]);
  if (!click.rows.length) return res.status(404).send("NOT FOUND");

  const c = click.rows[0];

  if (c.converted) return res.send("DUPLICATE");

  const offer = await pool.query("SELECT reward FROM offers WHERE id=$1", [c.offer_id]);
  const reward = Number(offer.rows[0].reward);

  await pool.query("UPDATE clicks SET converted=true,payout=$1 WHERE id=$2", [
    reward,
    click_id
  ]);

  await pool.query("UPDATE users SET balance=balance+$1 WHERE email=$2", [
    reward,
    c.email
  ]);

  res.send("OK");
});

// ================= ADMIN USERS =================
app.get("/admin/users", adminAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT id,username,email,balance,created_at FROM users ORDER BY id DESC"
  );

  res.json(result.rows);
});

// ================= START =================
app.listen(PORT, () => {
  console.log("🚀 SERVER RUNNING ON", PORT);
});