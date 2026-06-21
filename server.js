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
app.delete("/admin/users/:id", adminAuth, async (req, res) => {
  await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
  res.json({ success: true });
});
app.get("/admin/dashboard", adminAuth, async (req, res) => {
  const users = await pool.query("SELECT COUNT(*) FROM users");
  const offers = await pool.query("SELECT COUNT(*) FROM offers");
  const clicks = await pool.query("SELECT COUNT(*) FROM clicks");
  const withdrawals = await pool.query("SELECT COUNT(*) FROM withdrawals");
  const balance = await pool.query("SELECT COALESCE(SUM(balance),0) FROM users");

  res.json({
    users: users.rows[0].count,
    offers: offers.rows[0].count,
    clicks: clicks.rows[0].count,
    withdrawals: withdrawals.rows[0].count,
    totalBalance: balance.rows[0].coalesce
  });
});
app.get("/admin/user/:id", adminAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT id, username, email, balance, created_at FROM users WHERE id=$1",
    [req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: "User not found" });
  }

  res.json(result.rows[0]);
});
app.post("/admin/user/balance", adminAuth, async (req, res) => {
  const { id, balance } = req.body;

  await pool.query(
    "UPDATE users SET balance=$1 WHERE id=$2",
    [balance, id]
  );

  res.json({ success: true });
});
app.get("/user/dashboard", auth, async (req, res) => {
  const user = await pool.query(
    "SELECT id, username, email, balance, pending_withdrawal FROM users WHERE id=$1",
    [req.user.id]
  );

  const clicks = await pool.query(
    "SELECT COUNT(*) FROM clicks WHERE email=$1",
    [req.user.email]
  );

  const withdrawals = await pool.query(
    "SELECT * FROM withdrawals WHERE email=$1 ORDER BY created_at DESC",
    [req.user.email]
  );

  res.json({
    user: user.rows[0],
    clicks: clicks.rows[0].count,
    withdrawals: withdrawals.rows
  });
});
app.post("/admin/notify", adminAuth, async (req, res) => {
  const { user_id, message } = req.body;

  await pool.query(
    "INSERT INTO notifications(user_id,message) VALUES($1,$2)",
    [user_id, message]
  );

  res.json({ success: true });
});
app.get("/notifications", auth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC",
    [req.user.id]
  );

  res.json(result.rows);
});
app.get("/admin/click-stats", adminAuth, async (req, res) => {
  const total = await pool.query("SELECT COUNT(*) FROM clicks");
  const converted = await pool.query("SELECT COUNT(*) FROM clicks WHERE converted=true");

  res.json({
    totalClicks: total.rows[0].count,
    conversions: converted.rows[0].count
  });
});
app.get("/admin/withdraw/:id", adminAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM withdrawals WHERE id=$1",
    [req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: "Not found" });
  }

  res.json(result.rows[0]);
});
app.post("/admin/user/reset-balance", adminAuth, async (req, res) => {
  const { id } = req.body;

  await pool.query(
    "UPDATE users SET balance=0 WHERE id=$1",
    [id]
  );

  res.json({ success: true });
});
app.delete("/admin/clear-clicks", adminAuth, async (req, res) => {
  await pool.query("DELETE FROM clicks");
  res.json({ success: true });
});
app.post("/admin/withdraw/approve", adminAuth, async (req, res) => {
  const { id } = req.body;

  const w = await pool.query("SELECT * FROM withdrawals WHERE id=$1", [id]);
  if (!w.rows.length) return res.status(404).json({ error: "Not found" });

  const wd = w.rows[0];

  await pool.query(
    "UPDATE users SET balance = balance - $1, pending_withdrawal = pending_withdrawal - $1 WHERE email=$2",
    [wd.amount, wd.email]
  );

  await pool.query(
    "UPDATE withdrawals SET status='Approved' WHERE id=$1",
    [id]
  );

  res.json({ success: true });
});
app.post("/admin/withdraw/reject", adminAuth, async (req, res) => {
  const { id } = req.body;

  const w = await pool.query("SELECT * FROM withdrawals WHERE id=$1", [id]);
  if (!w.rows.length) return res.status(404).json({ error: "Not found" });

  const wd = w.rows[0];

  await pool.query(
    "UPDATE users SET pending_withdrawal = pending_withdrawal - $1 WHERE email=$2",
    [wd.amount, wd.email]
  );

  await pool.query(
    "UPDATE withdrawals SET status='Rejected' WHERE id=$1",
    [id]
  );

  res.json({ success: true });
});
app.get("/admin/users/search", adminAuth, async (req, res) => {
  const { q } = req.query;

  const result = await pool.query(
    `SELECT id, username, email, balance
     FROM users
     WHERE email ILIKE $1 OR username ILIKE $1
     ORDER BY id DESC`,
    [`%${q}%`]
  );

  res.json(result.rows);
});
app.get("/admin/offers/:id", adminAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM offers WHERE id=$1",
    [req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: "Offer not found" });
  }

  res.json(result.rows[0]);
});
app.get("/admin/user-stats/:id", adminAuth, async (req, res) => {
  const user = await pool.query("SELECT email FROM users WHERE id=$1", [req.params.id]);

  if (!user.rows.length) {
    return res.status(404).json({ error: "User not found" });
  }

  const email = user.rows[0].email;

  const clicks = await pool.query("SELECT COUNT(*) FROM clicks WHERE email=$1", [email]);
  const conversions = await pool.query("SELECT COUNT(*) FROM clicks WHERE email=$1 AND converted=true", [email]);

  res.json({
    clicks: clicks.rows[0].count,
    conversions: conversions.rows[0].count
  });
});
app.get("/offers/page", async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM offers
    WHERE active=true
    ORDER BY id DESC
  `);

  let html = "<h1>Available Offers</h1>";

  result.rows.forEach(o => {
    html += `
      <div style="padding:10px;border:1px solid #ccc;margin:10px">
        <h3>${o.title}</h3>
        <p>Reward: $${o.reward}</p>
        <a href="/click/${o.id}?email=test@gmail.com" target="_blank">
          Start Offer
        </a>
      </div>
    `;
  });

  res.send(html);
});
app.get("/api/offers/:id", async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM offers WHERE id=$1",
    [req.params.id]
  );

  if (!result.rows.length) {
    return res.status(404).json({ error: "Offer not found" });
  }

  res.json(result.rows[0]);
});
app.post("/admin/offers/:id/toggle", adminAuth, async (req, res) => {
  await pool.query(
    "UPDATE offers SET active = NOT active WHERE id=$1",
    [req.params.id]
  );

  res.json({ success: true });
});
app.get("/admin/offer-stats/:id", adminAuth, async (req, res) => {
  const clicks = await pool.query(
    "SELECT COUNT(*) FROM clicks WHERE offer_id=$1",
    [req.params.id]
  );

  const conversions = await pool.query(
    "SELECT COUNT(*) FROM clicks WHERE offer_id=$1 AND converted=true",
    [req.params.id]
  );

  res.json({
    clicks: clicks.rows[0].count,
    conversions: conversions.rows[0].count
  });
});



// ================= START =================
app.listen(PORT, () => {
  console.log("🚀 SERVER RUNNING ON", PORT);
});