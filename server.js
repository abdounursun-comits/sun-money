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
app.get("/db-test", async (req, res) => {
  const result = await pool.query("SELECT NOW()");
  res.json(result.rows[0]);
});
// ================= DB INIT =================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT,
      email TEXT UNIQUE,
      password TEXT,
      balance NUMERIC DEFAULT 0,
      referral_code TEXT,
      referred_by TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS offers (
      id SERIAL PRIMARY KEY,
      title TEXT,
      url TEXT,
      reward NUMERIC DEFAULT 0.20,
      active BOOLEAN DEFAULT TRUE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      message TEXT,
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clicks (
      id SERIAL PRIMARY KEY,
      offer_id INTEGER,
      ip TEXT,
      email TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("✅ DB ready");
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

// ================= ADMIN =================
function adminAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });

  jwt.verify(token, ADMIN_SECRET, (err) => {
    if (err) return res.status(403).json({ error: "Invalid admin" });
    next();
  });
}

app.get("/", (req, res) => {
  res.redirect("/auth");
});

app.get("/auth", (req, res) => {
  res.sendFile(path.join(__dirname, "auth.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard.html"));
});

app.get("/withdraw", (req, res) => {
  res.sendFile(path.join(__dirname, "withdraw.html"));
});
// ================= REGISTER (WITH REF) =================
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

app.post("/admin/login", (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.json({
        success: false,
        error: "Missing credentials"
      });
    }

    if (username === "sunadmin" && password === "sun2026") {

      const token = jwt.sign(
        { admin: true },
        ADMIN_SECRET,
        { expiresIn: "7d" }
      );

      return res.json({
        success: true,
        token
      });
    }

    return res.json({
      success: false,
      error: "Invalid admin credentials"
    });

  } catch (err) {
    console.error("ADMIN LOGIN ERROR:", err);

    return res.status(500).json({
      success: false,
      error: "Server error"
    });
  }
});
// ================= LOGIN =================
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const r = await pool.query(
    "SELECT * FROM users WHERE email=$1",
    [email]
  );

  if (!r.rows.length) {
    return res.status(400).json({
      success: false,
      error: "User not found"
    });
  }

  const user = r.rows[0];

  const ok = await bcrypt.compare(password, user.password);

  if (!ok) {
    return res.status(400).json({
      success: false,
      error: "Wrong password"
    });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      balance: user.balance
    }
  });
});

// ================= OFFERS PAGE =================
app.get("/offers", (req, res) => {
  res.sendFile(path.join(__dirname, "offers.html"));
});
app.get("/balance", auth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT balance FROM users WHERE id=$1",
      [req.user.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      balance: result.rows[0].balance
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
app.get("/notifications/:userId", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notifications
       WHERE user_id=$1
       ORDER BY created_at DESC`,
      [req.params.userId]
    );

    res.json(result.rows);

  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});
// ================= GET ACTIVE OFFERS API =================
app.get("/api/offers", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, url, reward
       FROM offers
       WHERE active = true
       ORDER BY id DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Offers error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= ADMIN CREATE OFFER =================
app.post("/admin/offers", adminAuth, async (req, res) => {
  try {
    const { title, url, reward } = req.body;

    if (!title || !url) {
      return res.status(400).json({
        error: "Title and URL required"
      });
    }

    const result = await pool.query(
      `INSERT INTO offers(title, url, reward)
       VALUES($1,$2,$3)
       RETURNING *`,
      [title, url, reward || 0.20]
    );

    res.json({
      success: true,
      offer: result.rows[0]
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= ADMIN VIEW ALL OFFERS =================
app.get("/admin/offers", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM offers
       ORDER BY id DESC`
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= ADMIN DISABLE OFFER =================
app.post("/admin/offers/:id/disable", adminAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE offers
       SET active = false
       WHERE id = $1`,
      [req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= ADMIN ENABLE OFFER =================
app.post("/admin/offers/:id/enable", adminAuth, async (req, res) => {
  try {
    await pool.query(
      `UPDATE offers
       SET active = true
       WHERE id = $1`,
      [req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= ADMIN DELETE OFFER =================
app.delete("/admin/offers/:id", adminAuth, async (req, res) => {
  try {
    await pool.query(
      `DELETE FROM offers
       WHERE id = $1`,
      [req.params.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= CLICK TRACKING (ANTI FRAUD) =================
app.get("/click/:offerId", async (req, res) => {
  try {
    const offerId = req.params.offerId;
    const email = req.query.email || "";
    const ip =
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      req.ip;

    const offer = await pool.query(
      "SELECT * FROM offers WHERE id=$1 AND active=true",
      [offerId]
    );

    if (!offer.rows.length) {
      return res.status(404).send("Offer not found");
    }

    const click = await pool.query(
      `INSERT INTO clicks(offer_id,email,ip)
       VALUES($1,$2,$3)
       RETURNING id`,
      [offerId, email, ip]
    );

    const clickId = click.rows[0].id;

    let url = offer.rows[0].url;

    if (url.includes("?")) {
      url += `&click_id=${clickId}`;
    } else {
      url += `?click_id=${clickId}`;
    }

    res.redirect(url);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});
app.get('/admin/clicks', async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM clicks
     ORDER BY created_at DESC`
  );

  let html = `
  <h1>Offer Clicks</h1>
  <table border="1">
  <tr>
    <th>ID</th>
    <th>Offer</th>
    <th>Email</th>
    <th>IP</th>
    <th>Date</th>
  </tr>
  `;

  result.rows.forEach(row => {
    html += `
    <tr>
      <td>${row.id}</td>
      <td>${row.offer_id}</td>
      <td>${row.email || 'Guest'}</td>
      <td>${row.ip}</td>
      <td>${row.created_at}</td>
    </tr>
    `;
  });

  html += '</table>';

  res.send(html);
});

// ================= POSTBACK (SAFE) =================
app.get("/postback", async (req, res) => {
  try {
    const { click_id, secret } = req.query;

    if (secret !== POSTBACK_SECRET) {
      return res.status(403).send("INVALID SECRET");
    }

    const click = await pool.query(
      "SELECT * FROM clicks WHERE id=$1",
      [click_id]
    );

    if (!click.rows.length) {
      return res.status(404).send("CLICK NOT FOUND");
    }

    const c = click.rows[0];

    if (c.converted) {
      return res.send("DUPLICATE");
    }

    const offer = await pool.query(
      "SELECT reward FROM offers WHERE id=$1",
      [c.offer_id]
    );

    const reward = Number(offer.rows[0].reward);

    // mark conversion first
    await pool.query(
      "UPDATE clicks SET converted=true, payout=$1 WHERE id=$2",
      [reward, click_id]
    );

    // DIRECT USER CREDIT (THIS IS YOUR MODEL)
    await pool.query(
      "UPDATE users SET balance = balance + $1 WHERE email=$2",
      [reward, c.email]
    );

    console.log(`✅ USER PAID: ${c.email} +${reward}`);

    res.send("OK");

  } catch (err) {
    console.error(err);
    res.status(500).send("ERROR");
  }
});
// ================= WITHDRAW (SAFE) =================
app.post("/withdraw", auth, async (req, res) => {
  const { method, account, amount } = req.body;

  const value = Number(amount);

  if (!value || value <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  if (value < 10) {
    return res.status(400).json({ error: "Minimum withdraw is $10" });
  }

  // STEP 1: check balance
  const user = await pool.query(
    "SELECT balance, pending_withdrawal FROM users WHERE id=$1",
    [req.user.id]
  );

  if (!user.rows.length) {
    return res.status(404).json({ error: "User not found" });
  }

  const u = user.rows[0];

  const available = Number(u.balance) - Number(u.pending_withdrawal);

  if (value > available) {
    return res.status(400).json({ error: "Insufficient available balance" });
  }

  // STEP 2: LOCK MONEY (pending system)
  await pool.query(
    `UPDATE users
     SET pending_withdrawal = pending_withdrawal + $1
     WHERE id=$2`,
    [value, req.user.id]
  );

  // STEP 3: create withdrawal request
  await pool.query(
    `INSERT INTO withdrawals(email, method, account, amount, status)
     VALUES($1,$2,$3,$4,'Pending')`,
    [req.user.email, method, account, value]
  );

  res.json({ success: true, message: "Withdrawal pending admin approval" });
});
app.post("/admin/withdraw/approve", adminAuth, async (req, res) => {
  const { id } = req.body;

  const w = await pool.query("SELECT * FROM withdrawals WHERE id=$1", [id]);
  if (!w.rows.length) return res.status(404).send("Not found");

  const wd = w.rows[0];

  await pool.query(
    `UPDATE users
     SET balance = balance - $1,
         pending_withdrawal = pending_withdrawal - $1
     WHERE email=$2`,
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
  if (!w.rows.length) return res.status(404).send("Not found");

  const wd = w.rows[0];

  await pool.query(
    `UPDATE users
     SET pending_withdrawal = pending_withdrawal - $1
     WHERE email=$2`,
    [wd.amount, wd.email]
  );

  await pool.query(
    "UPDATE withdrawals SET status='Rejected' WHERE id=$1",
    [id]
  );

  res.json({ success: true });
});
app.get("/admin/withdrawals", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM withdrawals ORDER BY created_at DESC"
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// ================= ADMIN STATS =================
app.get("/admin/stats", adminAuth, async (req, res) => {
  const users = await pool.query("SELECT COUNT(*) FROM users");
  const clicks = await pool.query("SELECT COUNT(*) FROM clicks");
  const balance = await pool.query("SELECT SUM(balance) FROM users");

  res.json({
    users: users.rows[0].count,
    clicks: clicks.rows[0].count,
    balance: balance.rows[0].sum || 0
  });
});

app.get("/admin/users", adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, email, balance, created_at FROM users ORDER BY id DESC"
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
app.get("/test-users", async (req, res) => {
  const result = await pool.query("SELECT * FROM users");
  res.json(result.rows);
});
app.get("/admin/dashboard", adminAuth, async (req, res) => {

  const users = await pool.query(
    "SELECT COUNT(*) FROM users"
  );

  const offers = await pool.query(
    "SELECT COUNT(*) FROM offers"
  );

  const withdrawals = await pool.query(
    "SELECT COUNT(*) FROM withdrawals"
  );

  const clicks = await pool.query(
    "SELECT COUNT(*) FROM clicks"
  );

  const balance = await pool.query(
    "SELECT COALESCE(SUM(balance),0) total FROM users"
  );

  res.json({
    users: users.rows[0].count,
    offers: offers.rows[0].count,
    withdrawals: withdrawals.rows[0].count,
    clicks: clicks.rows[0].count,
    balance: balance.rows[0].total
  });
});
// Update user balance
app.post("/admin/user/balance", adminAuth, async (req, res) => {
  const { id, balance } = req.body;

  await pool.query(
    "UPDATE users SET balance=$1 WHERE id=$2",
    [balance, id]
  );

  res.json({ success: true });
});

// Delete user
async function editBalance(id){
  const newBalance = prompt("Enter new balance:");
  if(!newBalance) return;

  await fetch(API+"/admin/user/balance",{
    method:"POST",
    headers:{
      "Content-Type":"application/json",
      Authorization:"Bearer "+token
    },
    body:JSON.stringify({id, balance:newBalance})
  });

  location.reload();
}

async function deleteUser(id){
  if(!confirm("Delete this user?")) return;

  await fetch(API+"/admin/users/"+id,{
    method:"DELETE",
    headers:{
      Authorization:"Bearer "+token
    }
  });

  location.reload();
}

// Admin clicks API
app.get("/admin/api/clicks", adminAuth, async (req, res) => {
  const result = await pool.query(`
    SELECT *
    FROM clicks
    ORDER BY created_at DESC
  `);

  res.json(result.rows);
});
// ================= START =================
app.listen(PORT, () => {
  console.log("🚀 CPA SYSTEM V2 RUNNING ON", PORT);
});