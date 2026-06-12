
require("dotenv").config();

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const path = require("path");
const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors());
app.use(express.json());

// 👇 1. CREATE DB FIRST
const db = new sqlite3.Database("./sunmoney.db", (err) => {
    if (err) {
        console.error("❌ SQLite NOT connected:", err.message);
    } else {
        console.log("✅ SQLite database connected");
    }
});
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "auth.html"));
});

// ===================== DB INIT =====================
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

    db.run(`
        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// ===================== MIDDLEWARE =====================
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

function adminAuth(req, res, next) {
    const header = req.headers["authorization"];
    if (!header) return res.status(401).json({ error: "No token" });

    const token = header.split(" ")[1];
    jwt.verify(token, ADMIN_SECRET, (err, admin) => {
        if (err) return res.status(403).json({ error: "Invalid admin token" });
        req.admin = admin;
        next();
    });
}

// ===================== AUTH =====================
app.post("/register", async (req, res) => {
    const { username, email, mobile, password } = req.body;

    const hash = await bcrypt.hash(password, 10);

    db.run(
        "INSERT INTO users (username, email, mobile, password, balance) VALUES (?, ?, ?, ?, 0)",
        [username, email, mobile, hash],
        function (err) {
            if (err) return res.status(400).json({ error: "User exists or invalid data" });
            res.json({ success: true });
        }
    );
});

app.post("/login", (req, res) => {
    const { email, password } = req.body;

    db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
        if (err || !user) return res.status(400).json({ error: "User not found" });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: "Invalid password" });

        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: "7d" });

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                balance: user.balance
            }
        });
    });
});

// ===================== USER =====================
app.get("/balance", auth, (req, res) => {
    db.get("SELECT balance FROM users WHERE id = ?", [req.user.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ balance: row.balance });
    });
});

app.get("/offers", (req, res) => {
    db.all("SELECT * FROM offers", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.get("/click/:offerId", (req, res) => {
    const { offerId } = req.params;
    const email = req.query.email;

    db.get("SELECT * FROM offers WHERE id = ?", [offerId], (err, offer) => {
        if (err || !offer) return res.status(404).send("Offer not found");

        const redirectUrl = `${offer.url}${offer.url.includes("?") ? "&" : "?"}subid=${email}`;
        res.redirect(redirectUrl);
    });
});

// ===================== POSTBACK =====================
app.get("/postback", (req, res) => {
    const { subid, secret } = req.query;

    if (secret !== POSTBACK_SECRET) {
        return res.status(403).send("Invalid secret");
    }

    db.run(
        "UPDATE users SET balance = balance + 0.20 WHERE email = ?",
        [subid],
        function (err) {
            if (err) return res.status(500).send("Error");
            res.send("OK");
        }
    );
});

// ===================== WITHDRAW =====================
app.post("/withdraw", auth, (req, res) => {
    const { method, account, amount } = req.body;

    db.get("SELECT balance, email FROM users WHERE id = ?", [req.user.id], (err, user) => {
        if (err || !user) return res.status(400).json({ error: "User not found" });

        if (user.balance < amount) {
            return res.status(400).json({ error: "Insufficient balance" });
        }

        db.run(
            "INSERT INTO withdrawals (email, method, account, amount, status) VALUES (?, ?, ?, ?, 'Pending')",
            [user.email, method, account, amount],
            () => {
                res.json({ success: true, message: "Withdrawal request submitted" });
            }
        );
    });
});

// ===================== NOTIFICATIONS =====================
app.get("/notifications/:userId", auth, (req, res) => {
    db.all(
        "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC",
        [req.params.userId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// ===================== ADMIN =====================
app.post("/admin/login", (req, res) => {
    const { username, password } = req.body;

    if (username !== "sunadmin" || password !== "SunMoney2026!") {
        return res.status(403).json({ error: "Invalid admin credentials" });
    }

    const token = jwt.sign({ role: "admin" }, ADMIN_SECRET, { expiresIn: "7d" });

    res.json({ success: true, token });
});

app.get("/admin/stats", adminAuth, (req, res) => {
    db.get("SELECT COUNT(*) as users FROM users", [], (err, usersRow) => {
        db.get("SELECT COUNT(*) as pending FROM withdrawals WHERE status='Pending'", [], (err2, pendingRow) => {
            db.get("SELECT COUNT(*) as paid FROM withdrawals WHERE status='Approved'", [], (err3, paidRow) => {
                db.get("SELECT SUM(balance) as balance FROM users", [], (err4, balRow) => {
                    res.json({
                        users: usersRow.users,
                        pending: pendingRow.pending,
                        paid: paidRow.paid,
                        balance: balRow.balance || 0
                    });
                });
            });
        });
    });
});

app.get("/admin/users", adminAuth, (req, res) => {
    db.all("SELECT id, username, email, mobile, balance FROM users", [], (err, rows) => {
        res.json(rows);
    });
});

app.get("/admin/withdrawals", adminAuth, (req, res) => {
    db.all("SELECT * FROM withdrawals", [], (err, rows) => {
        res.json(rows);
    });
});

app.post("/admin/approve/:id", adminAuth, (req, res) => {
    db.get("SELECT * FROM withdrawals WHERE id = ?", [req.params.id], (err, w) => {
        if (!w) return res.status(404).json({ error: "Not found" });

        db.run("UPDATE withdrawals SET status='Approved' WHERE id=?", [req.params.id]);

        db.run("UPDATE users SET balance = balance - ? WHERE email = ?", [w.amount, w.email]);

        res.json({ success: true });
    });
});

app.post("/admin/reject/:id", adminAuth, (req, res) => {
    db.run("UPDATE withdrawals SET status='Rejected' WHERE id=?", [req.params.id], () => {
        res.json({ success: true });
    });
});

app.post("/admin/offers", adminAuth, (req, res) => {
    const { title, description, url, reward } = req.body;

    db.run(
        "INSERT INTO offers (title, description, url, reward) VALUES (?, ?, ?, ?)",
        [title, description, url, reward],
        () => {
            res.json({ success: true });
        }
    );
});

app.delete("/admin/offers/:id", adminAuth, (req, res) => {
    db.run("DELETE FROM offers WHERE id = ?", [req.params.id], () => {
        res.json({ success: true });
    });
});

app.post("/admin/notify", adminAuth, (req, res) => {
    const { user_id, message } = req.body;

    db.run(
        "INSERT INTO notifications (user_id, message) VALUES (?, ?)",
        [user_id, message],
        () => {
            res.json({ success: true });
        }
    );
});

// ===================== START =====================
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});