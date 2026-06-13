require("dotenv").config();

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ================= DATABASE =================
const db = new sqlite3.Database("./sunmoney.db", (err) => {
    if (err) console.error("DB error:", err.message);
    else console.log("✅ SQLite connected");
});

// ================= HOME =================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "dashboard.html"));
});

// ================= SECURITY KEYS =================
const JWT_SECRET = process.env.JWT_SECRET || "sun_money_secret";
const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || "sun_money_admin_secret";

// ================= DB INIT =================
db.serialize(() => {

    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            email TEXT UNIQUE,
            mobile TEXT,
            password TEXT,
            balance REAL DEFAULT 0
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS offers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            description TEXT,
            url TEXT,
            reward REAL DEFAULT 0.20
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS withdrawals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT,
            method TEXT,
            account TEXT,
            amount REAL,
            status TEXT DEFAULT 'Pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// ================= AUTH MIDDLEWARE =================
function auth(req, res, next) {
    const header = req.headers["authorization"];
    if (!header) return res.status(401).json({ error: "No token" });

    const token = header.split(" ")[1];

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Invalid token" });
        req.user = user;
        next();
    });
}

// ================= BALANCE =================
app.get("/balance", auth, (req, res) => {
    db.get(
        "SELECT balance FROM users WHERE id = ?",
        [req.user.id],
        (err, row) => {

            if (err) {
                return res.status(500).json({ error: err.message });
            }

            if (!row) {
                return res.status(404).json({ error: "User not found" });
            }

            res.json({ balance: row.balance });
        }
    );
});

// ================= OFFERS (FIXED - ONLY ONE ROUTE) =================
app.get("/offers", (req, res) => {
    db.all("SELECT * FROM offers", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ================= CLICK TRACKING =================
app.get("/click/:offerId", (req, res) => {
    const { offerId } = req.params;
    const email = req.query.email || "";

    db.get("SELECT * FROM offers WHERE id = ?", [offerId], (err, offer) => {
        if (err || !offer) return res.status(404).send("Offer not found");

        const redirectUrl =
            offer.url +
            (offer.url.includes("?") ? "&" : "?") +
            "subid=" +
            email;

        res.redirect(redirectUrl);
    });
});

// ================= REGISTER =================
app.post("/register", async (req, res) => {

    const { username, email, mobile, password } = req.body;

    if (!username || !email || !mobile || !password) {
        return res.status(400).json({ error: "All fields required" });
    }

    const hash = await bcrypt.hash(password, 10);

    db.run(
        `INSERT INTO users (username, email, mobile, password, balance)
         VALUES (?, ?, ?, ?, 0)`,
        [username, email, mobile, hash],
        (err) => {
            if (err) {
                return res.status(400).json({ error: "User exists" });
            }
            res.json({ success: true });
        }
    );
});

// ================= LOGIN =================
app.post("/login", (req, res) => {

    const { email, password } = req.body;

    db.get(
        "SELECT * FROM users WHERE email = ?",
        [email],
        async (err, user) => {

            if (err || !user) {
                return res.status(400).json({ error: "User not found" });
            }

            const match = await bcrypt.compare(password, user.password);

            if (!match) {
                return res.status(400).json({ error: "Wrong password" });
            }

            const token = jwt.sign(
                { id: user.id, email: user.email },
                JWT_SECRET,
                { expiresIn: "7d" }
            );

            res.json({ token, user });
        }
    );
});

// ================= POSTBACK =================
app.get("/postback", (req, res) => {

    const subid = req.query.var;
    const payout = parseFloat(req.query.amount || 0);

    if (!subid || !payout) {
        return res.status(400).send("INVALID");
    }

    db.run(
        "UPDATE users SET balance = balance + ? WHERE email = ?",
        [payout, subid],
        (err) => {
            if (err) return res.status(500).send("ERROR");
            res.send("OK");
        }
    );
});

// ================= WITHDRAW =================
app.post("/withdraw", auth, (req, res) => {

    const { method, account, amount } = req.body;

    db.get(
        "SELECT balance, email FROM users WHERE id = ?",
        [req.user.id],
        (err, user) => {

            if (err || !user) {
                return res.status(400).json({ error: "User not found" });
            }

            if (user.balance < amount) {
                return res.status(400).json({ error: "Insufficient balance" });
            }

            db.run(
                "INSERT INTO withdrawals (email, method, account, amount) VALUES (?, ?, ?, ?)",
                [user.email, method, account, amount],
                () => {
                    res.json({ success: true });
                }
            );
        }
    );
});

// ===================== ADMIN =====================
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
app.get("/admin", (req, res) => {
    res.sendFile(path.join(__dirname, "admin.html"));
});
// Admin Login
app.post("/admin/login", (req, res) => {

    const { username, password } = req.body;

    const ADMIN_USERNAME =
        process.env.ADMIN_USERNAME || "sunadmin";

    const ADMIN_PASSWORD =
        process.env.ADMIN_PASSWORD || "SunMoney2026!";

    if (
        username !== ADMIN_USERNAME ||
        password !== ADMIN_PASSWORD
    ) {
        return res.status(403).json({
            success: false,
            error: "Invalid admin credentials"
        });
    }

    const token = jwt.sign(
        { role: "admin" },
        ADMIN_SECRET,
        { expiresIn: "7d" }
    );

    res.json({
        success: true,
        token
    });
});

// Admin Middleware
function adminAuth(req, res, next) {

    const header = req.headers.authorization;

    if (!header) {
        return res.status(401).json({
            error: "No token"
        });
    }

    const token = header.split(" ")[1];

    jwt.verify(
        token,
        ADMIN_SECRET,
        (err, admin) => {

            if (err) {
                return res.status(403).json({
                    error: "Invalid admin token"
                });
            }

            req.admin = admin;
            next();
        }
    );
}

// Admin Stats
app.get("/admin/stats", adminAuth, (req, res) => {

    db.get(
        "SELECT COUNT(*) as users FROM users",
        [],
        (err, row) => {

            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json({
                totalUsers: row.users
            });
        }
    );
});

// Admin Users
app.get("/admin/users", adminAuth, (req, res) => {

    db.all(
        "SELECT id, username, email, mobile, balance FROM users",
        [],
        (err, rows) => {

            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json(rows);
        }
    );
});

// Admin Withdrawals
app.get("/admin/withdrawals", adminAuth, (req, res) => {

    db.all(
        "SELECT * FROM withdrawals ORDER BY id DESC",
        [],
        (err, rows) => {

            if (err) {
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json(rows);
        }
    );
});

// Approve Withdrawal
app.post("/admin/approve/:id", adminAuth, (req, res) => {

    db.run(
        "UPDATE withdrawals SET status='Approved' WHERE id=?",
        [req.params.id],
        function(err){

            if(err){
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json({
                success:true,
                message:"Withdrawal approved"
            });
        }
    );
});

// Reject Withdrawal
app.post("/admin/reject/:id", adminAuth, (req, res) => {

    db.run(
        "UPDATE withdrawals SET status='Rejected' WHERE id=?",
        [req.params.id],
        function(err){

            if(err){
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json({
                success:true,
                message:"Withdrawal rejected"
            });
        }
    );
});

// Send Notification
app.post("/admin/notify", adminAuth, (req, res) => {

    const { user_id, message } = req.body;

    db.run(
        "INSERT INTO notifications (user_id, message) VALUES (?, ?)",
        [user_id, message],
        function(err){

            if(err){
                return res.status(500).json({
                    error: err.message
                });
            }

            res.json({
                success:true
            });
        }
    );
});
// ================= START =================
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});