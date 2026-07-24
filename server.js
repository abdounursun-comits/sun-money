require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const app = express();

const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const POSTBACK_SECRET = process.env.POSTBACK_SECRET;

if (!JWT_SECRET || !ADMIN_SECRET || !POSTBACK_SECRET) {
    console.log("❌ Missing environment secrets");
    process.exit(1);
}


const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});


app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));


// ================= DATABASE =================

async function initDB(){

    await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        balance NUMERIC DEFAULT 0,
        pending_withdrawal NUMERIC DEFAULT 0,
        referral_code TEXT,
        referred_by TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `);


    await pool.query(`
    CREATE TABLE IF NOT EXISTS offers(
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        reward NUMERIC DEFAULT 0.20,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `);


    await pool.query(`
    CREATE TABLE IF NOT EXISTS clicks(
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
    CREATE TABLE IF NOT EXISTS withdrawals(
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
    CREATE TABLE IF NOT EXISTS notifications(
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    `);


    console.log("✅ DATABASE READY");
}


initDB();



// ================= AUTH =================


function auth(req,res,next){

    const token =
    req.headers.authorization?.split(" ")[1];


    if(!token){
        return res.status(401).json({
            error:"No token"
        });
    }


    jwt.verify(token,JWT_SECRET,(err,user)=>{

        if(err){
            return res.status(403).json({
                error:"Invalid token"
            });
        }


        req.user=user;
        next();

    });

}



function adminAuth(req, res, next) {
    const token = req.headers.authorization?.split(" ")[1];

    console.log("ADMIN TOKEN:", token);

    if (!token) {
        return res.status(401).json({ error: "No admin token" });
    }

    jwt.verify(token, ADMIN_SECRET, (err, decoded) => {
        if (err) {
            console.log("JWT ERROR:", err.message);
            return res.status(403).json({ error: "Invalid admin token" });
        }

        console.log("ADMIN VERIFIED:", decoded);

        next();
    });
}




// ================= PAGES =================


app.get("/",(req,res)=>{
    res.redirect("/auth");
});


app.get("/auth",(req,res)=>{
    res.sendFile(
        path.join(__dirname,"auth.html")
    );
});


app.get("/dashboard",(req,res)=>{
    res.sendFile(
        path.join(__dirname,"dashboard.html")
    );
});


app.get("/withdraw",(req,res)=>{
    res.sendFile(
        path.join(__dirname,"withdraw.html")
    );
});


app.get("/offers",(req,res)=>{
    res.sendFile(
        path.join(__dirname,"offers.html")
    );
});





// ================= REGISTER =================


app.post("/register",async(req,res)=>{

try{

const {
username,
email,
password,
referral
}=req.body;



const check =
await pool.query(
"SELECT id FROM users WHERE email=$1",
[email]
);



if(check.rows.length){

return res.status(400).json({
error:"Email already exists"
});

}



const hash =
await bcrypt.hash(password,10);



const code =
Math.random()
.toString(36)
.substring(2,8);



await pool.query(
`
INSERT INTO users
(username,email,password,referral_code,referred_by)
VALUES($1,$2,$3,$4,$5)
`,
[
username,
email,
hash,
code,
referral || null
]
);



res.json({
success:true
});



}catch(err){

console.log(err);

res.status(500).json({
error:"Registration failed"
});

}

});





// ================= LOGIN =================


app.post("/login",async(req,res)=>{


try{


const {
email,
password
}=req.body;



const result =
await pool.query(
"SELECT * FROM users WHERE email=$1",
[email]
);



if(!result.rows.length){

return res.status(400).json({
error:"User not found"
});

}



const user=result.rows[0];



const valid =
await bcrypt.compare(
password,
user.password
);



if(!valid){

return res.status(400).json({
error:"Wrong password"
});

}



const token =
jwt.sign(
{
id:user.id,
email:user.email
},
JWT_SECRET,
{
expiresIn:"7d"
}
);



res.json({
success:true,
token,
user
});



}catch(err){

console.log(err);

res.status(500).json({
error:"Login failed"
});

}


});





// ================= ADMIN LOGIN =================


app.post("/admin/login",(req,res)=>{


const {
username,
password
}=req.body;



if(
username==="sunadmin" &&
password==="sun2026"
){

const token =
jwt.sign(
{
admin:true
},
ADMIN_SECRET,
{
expiresIn:"7d"
}
);


return res.json({
success:true,
token
});

}



res.status(401).json({
error:"Invalid admin login"
});


});
// ================= USER OFFERS =================

app.get("/api/offers", async (req, res) => {
  try {

    const result = await pool.query(
      "SELECT id,title,url,reward FROM offers WHERE active=true ORDER BY id DESC"
    );

    res.json(result.rows);

  } catch(error) {

    console.error("OFFERS ERROR:", error);

    res.status(500).json({
      error:"Failed to load offers"
    });

  }
});





// ================= ADMIN OFFERS =================


// Get all offers

app.get("/admin/offers",adminAuth,async(req,res)=>{

const result = await pool.query(
"SELECT * FROM offers ORDER BY id DESC"
);

res.json(result.rows);

});




// Create offer

app.post(
    "/admin/offers",
    adminAuth,
    async (req, res) => {

        try {

            const {
                title,
                url,
                reward
            } = req.body;

            if (!title || !url) {

                return res.status(400).json({
                    error: "Title and URL are required"
                });

            }

            const existingOffer = await pool.query(
                `
                SELECT id
                FROM offers
                WHERE url=$1
                `,
                [url.trim()]
            );

            if (existingOffer.rows.length) {

                return res.status(409).json({
                    error: "This offer URL already exists"
                });

            }

            const result = await pool.query(
                `
                INSERT INTO offers
                (title,url,reward)
                VALUES($1,$2,$3)
                RETURNING *
                `,
                [
                    title.trim(),
                    url.trim(),
                    reward || 0.20
                ]
            );

            res.json(result.rows[0]);

        } catch (error) {

            console.error("OFFER CREATION ERROR:", error);

            res.status(500).json({
                error: "Offer creation failed"
            });

        }

    }
);




// Enable offer

app.post(
"/admin/offers/:id/enable",
adminAuth,
async(req,res)=>{


await pool.query(
`
UPDATE offers
SET active=true
WHERE id=$1
`,
[
req.params.id
]
);


res.json({
success:true
});


});





// Disable offer

app.post(
"/admin/offers/:id/disable",
adminAuth,
async(req,res)=>{


await pool.query(
`
UPDATE offers
SET active=false
WHERE id=$1
`,
[
req.params.id
]
);


res.json({
success:true
});


});





// Delete offer

app.delete(
"/admin/offers/:id",
adminAuth,
async(req,res)=>{


await pool.query(
`
DELETE FROM offers
WHERE id=$1
`,
[
req.params.id
]
);



res.json({
success:true
});


});







// ================= CLICK TRACKING =================

app.get("/click/:offerId", async (req, res) => {

    try {

        const { offerId } = req.params;

        const { email } = req.query;

        const ip = req.ip;

        if (!email) {
            return res.status(400).send("USER EMAIL REQUIRED");
        }

        const offerResult = await pool.query(
            `
            SELECT *
            FROM offers
            WHERE id=$1
            AND active=true
            `,
            [offerId]
        );

        if (!offerResult.rows.length) {
            return res.status(404).send("OFFER NOT FOUND");
        }

        const clickResult = await pool.query(
            `
            INSERT INTO clicks
            (offer_id,email,ip)
            VALUES($1,$2,$3)
            RETURNING id
            `,
            [
                offerId,
                email,
                ip
            ]
        );

        const clickId = clickResult.rows[0].id;

        let url = offerResult.rows[0].url;

        if (url.includes("?")) {

            url += `&sun_click_id=${clickId}`;

        } else {

            url += `?sun_click_id=${clickId}`;

        }

        console.log(
            `🖱️ CLICK: ${clickId} | ${email} | Offer ${offerId}`
        );

        res.redirect(url);

    } catch (error) {

        console.error("CLICK ERROR:", error);

        res.status(500).send("CLICK ERROR");

    }

});





app.get("/postback", async (req, res) => {

    const client = await pool.connect();

    try {

        const {
            sun_click_id,
            secret
        } = req.query;

        // Check secret
        if (secret !== POSTBACK_SECRET) {
            return res.status(403).send("INVALID SECRET");
        }

        if (!sun_click_id) {
            return res.status(400).send("MISSING CLICK ID");
        }

        await client.query("BEGIN");

        // Find click
        const clickResult = await client.query(
            `
            SELECT *
            FROM clicks
            WHERE id=$1
            FOR UPDATE
            `,
            [sun_click_id]
        );

        if (!clickResult.rows.length) {

            await client.query("ROLLBACK");

            return res.status(404).send("CLICK NOT FOUND");
        }

        const click = clickResult.rows[0];

        // Prevent duplicate conversion
        if (click.converted === true) {

            await client.query("ROLLBACK");

            return res.send("DUPLICATE");
        }

        // Find offer reward
        const offerResult = await client.query(
            `
            SELECT reward
            FROM offers
            WHERE id=$1
            `,
            [click.offer_id]
        );

        if (!offerResult.rows.length) {

            await client.query("ROLLBACK");

            return res.status(404).send("OFFER NOT FOUND");
        }

        const reward = Number(offerResult.rows[0].reward);

        // Check user
        const userResult = await client.query(
            `
            SELECT id
            FROM users
            WHERE email=$1
            `,
            [click.email]
        );

        if (!userResult.rows.length) {

            await client.query("ROLLBACK");

            return res.status(404).send("USER NOT FOUND");
        }

        // Mark conversion
        await client.query(
            `
            UPDATE clicks
            SET converted=true,
                payout=$1
            WHERE id=$2
            `,
            [reward, sun_click_id]
        );

        // Add money to user
        await client.query(
            `
            UPDATE users
            SET balance = balance + $1
            WHERE email=$2
            `,
            [reward, click.email]
        );

        await client.query("COMMIT");

        console.log(
            `✅ Conversion: Click ${sun_click_id} | User ${click.email} | Reward $${reward}`
        );

        res.send("OK");

    } catch (error) {

        await client.query("ROLLBACK");

        console.error("POSTBACK ERROR:", error);

        res.status(500).send("POSTBACK ERROR");

    } finally {

        client.release();

    }

});
// ================= USER DASHBOARD =================

app.get("/user/dashboard", auth, async(req,res)=>{

try{

    const user = await pool.query(
    `
    SELECT 
        id,
        username,
        email,
        balance,
        pending_withdrawal
    FROM users
    WHERE id=$1
    `,
    [
        req.user.id
    ]);


    if(!user.rows.length){

        return res.status(404).json({
            error:"User not found"
        });

    }



    const clicks = await pool.query(
    `
    SELECT COUNT(*) 
    FROM clicks
    WHERE email=$1
    `,
    [
        req.user.email
    ]);



    const withdrawals = await pool.query(
    `
    SELECT *
    FROM withdrawals
    WHERE email=$1
    ORDER BY created_at DESC
    `,
    [
        req.user.email
    ]);



    // GET USER NOTIFICATIONS

    const notifications = await pool.query(
    `
    SELECT 
        id,
        message,
        created_at
    FROM notifications
    WHERE user_id=$1
    ORDER BY created_at DESC
    `,
    [
        req.user.id
    ]);




    res.json({

        user:user.rows[0],

        clicks:clicks.rows[0].count,

        withdrawals:withdrawals.rows,

        notifications:notifications.rows

    });



}catch(err){

    console.log(err);

    res.status(500).json({
        error:"Dashboard error"
    });

}

});





// ================= ADMIN SEND NOTIFICATION =================


app.post(
    "/admin/notify",
    adminAuth,
    async (req, res) => {

        try {

            const {
                user_id,
                message
            } = req.body;

            if (!user_id || !message || !message.trim()) {

                return res.status(400).json({
                    error: "User ID and message required"
                });

            }

            const user = await pool.query(
                `
                SELECT id
                FROM users
                WHERE id=$1
                `,
                [user_id]
            );

            if (!user.rows.length) {

                return res.status(404).json({
                    error: "User not found"
                });

            }

            await pool.query(
                `
                INSERT INTO notifications
                (user_id, message)
                VALUES($1, $2)
                `,
                [
                    user_id,
                    message.trim()
                ]
            );

            res.json({
                success: true,
                message: "Notification sent"
            });

        } catch (error) {

            console.error("NOTIFICATION ERROR:", error);

            res.status(500).json({
                error: "Notification failed"
            });

        }

    }
);




// ================= GET USER NOTIFICATIONS ONLY =================


app.get("/notifications", auth, async(req,res)=>{


try{


const result = await pool.query(
`
SELECT 
id,
message,
created_at
FROM notifications
WHERE user_id=$1
ORDER BY created_at DESC
`,
[
req.user.id
]);



res.json(result.rows);



}catch(err){


console.log(err);


res.status(500).json({

error:"Failed loading notifications"

});


}


});








// ================= WITHDRAW REQUEST =================


app.post("/withdraw", auth, async (req, res) => {

    const client = await pool.connect();

    try {

        const {
            method,
            account,
            amount
        } = req.body;

        const withdrawAmount = Number(amount);

        if (!method || !account || !withdrawAmount) {

            return res.status(400).json({
                error: "All fields are required"
            });

        }

        if (withdrawAmount < 10) {

            return res.status(400).json({
                error: "Minimum withdrawal is $10"
            });

        }

        await client.query("BEGIN");

        const userResult = await client.query(
            `
            SELECT balance, pending_withdrawal, email
            FROM users
            WHERE id=$1
            FOR UPDATE
            `,
            [req.user.id]
        );

        if (!userResult.rows.length) {

            await client.query("ROLLBACK");

            return res.status(404).json({
                error: "User not found"
            });
        }

        const user = userResult.rows[0];

        const balance = Number(user.balance);

        const pending = Number(user.pending_withdrawal);

        const available = balance - pending;

        if (available < withdrawAmount) {

            await client.query("ROLLBACK");

            return res.status(400).json({
                error: "Insufficient available balance"
            });
        }

        await client.query(
            `
            UPDATE users
            SET pending_withdrawal =
            pending_withdrawal + $1
            WHERE id=$2
            `,
            [
                withdrawAmount,
                req.user.id
            ]
        );

        await client.query(
            `
            INSERT INTO withdrawals
            (email, method, account, amount, status)
            VALUES($1,$2,$3,$4,'Pending')
            `,
            [
                user.email,
                method,
                account,
                withdrawAmount
            ]
        );

        await client.query("COMMIT");

        res.json({
            success: true,
            message: "Withdrawal pending"
        });

    } catch (error) {

        await client.query("ROLLBACK");

        console.error("WITHDRAW ERROR:", error);

        res.status(500).json({
            error: "Withdrawal failed"
        });

    } finally {

        client.release();

    }

});










app.get("/admin/dashboard", adminAuth, async(req,res)=>{

try{


const users =
await pool.query(
"SELECT COUNT(*) FROM users"
);


const offers =
await pool.query(
"SELECT COUNT(*) FROM offers"
);


const clicks =
await pool.query(
"SELECT COUNT(*) FROM clicks"
);


const withdrawals =
await pool.query(
"SELECT COUNT(*) FROM withdrawals"
);


const balance = await pool.query(
    `
    SELECT COALESCE(SUM(balance),0) AS total_balance
    FROM users
    `
);

res.json({

    users: users.rows[0].count,

    offers: offers.rows[0].count,

    clicks: clicks.rows[0].count,

    withdrawals: withdrawals.rows[0].count,

    totalBalance: balance.rows[0].total_balance

});


}catch(err){

console.log(err);

res.status(500).json({
error:"Admin dashboard error"
});

}


});







// ================= ADMIN USERS =================



app.get(
"/admin/users/search",
adminAuth,
async(req,res)=>{


const {
q
}=req.query;



const result =
await pool.query(
`
SELECT 
id,
username,
email,
balance,
created_at
FROM users
WHERE username ILIKE $1
OR email ILIKE $1
ORDER BY id DESC
`,
[
`%${q}%`
]
);



res.json(
result.rows
);


});







app.get(
"/admin/user/:id",
adminAuth,
async(req,res)=>{


const result =
await pool.query(
`
SELECT 
id,
username,
email,
balance,
created_at
FROM users
WHERE id=$1
`,
[
req.params.id
]
);



if(!result.rows.length){

return res.status(404).json({
error:"User not found"
});

}



res.json(
result.rows[0]
);


});







app.delete(
    "/admin/users/:id",
    adminAuth,
    async (req, res) => {

        const client = await pool.connect();

        try {

            await client.query("BEGIN");

            const user = await client.query(
                `
                SELECT email
                FROM users
                WHERE id=$1
                `,
                [req.params.id]
            );

            if (!user.rows.length) {

                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: "User not found"
                });
            }

            const email = user.rows[0].email;

            await client.query(
                `DELETE FROM notifications WHERE user_id=$1`,
                [req.params.id]
            );

            await client.query(
                `DELETE FROM clicks WHERE email=$1`,
                [email]
            );

            await client.query(
                `DELETE FROM withdrawals WHERE email=$1`,
                [email]
            );

            await client.query(
                `DELETE FROM users WHERE id=$1`,
                [req.params.id]
            );

            await client.query("COMMIT");

            res.json({
                success: true
            });

        } catch (error) {

            await client.query("ROLLBACK");

            console.error(error);

            res.status(500).json({
                error: "Failed to delete user"
            });

        } finally {

            client.release();

        }

    }
);







app.post(
    "/admin/user/balance",
    adminAuth,
    async (req, res) => {

        try {

            const { id, balance } = req.body;

            const newBalance = Number(balance);

            if (!Number.isFinite(newBalance) || newBalance < 0) {

                return res.status(400).json({
                    error: "Invalid balance"
                });

            }

            const result = await pool.query(
                `
                UPDATE users
                SET balance=$1
                WHERE id=$2
                RETURNING id, balance
                `,
                [
                    newBalance,
                    id
                ]
            );

            if (!result.rows.length) {

                return res.status(404).json({
                    error: "User not found"
                });

            }

            res.json({
                success: true,
                user: result.rows[0]
            });

        } catch (error) {

            console.error("BALANCE UPDATE ERROR:", error);

            res.status(500).json({
                error: "Failed to update balance"
            });

        }

    }
);







app.post(
    "/admin/user/reset-balance",
    adminAuth,
    async (req, res) => {

        const client = await pool.connect();

        try {

            const { id } = req.body;

            await client.query("BEGIN");

            const user = await client.query(
                `
                SELECT email
                FROM users
                WHERE id=$1
                FOR UPDATE
                `,
                [id]
            );

            if (!user.rows.length) {

                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: "User not found"
                });

            }

            const email = user.rows[0].email;

            await client.query(
                `
                UPDATE users
                SET balance=0,
                    pending_withdrawal=0
                WHERE id=$1
                `,
                [id]
            );

            await client.query(
                `
                UPDATE withdrawals
                SET status='Rejected'
                WHERE email=$1
                AND status='Pending'
                `,
                [email]
            );

            await client.query("COMMIT");

            res.json({
                success: true
            });

        } catch (error) {

            await client.query("ROLLBACK");

            console.error("RESET BALANCE ERROR:", error);

            res.status(500).json({
                error: "Failed to reset balance"
            });

        } finally {

            client.release();

        }

    }
);







// ================= WITHDRAW ADMIN =================



app.get(
"/admin/withdraw/:id",
adminAuth,
async(req,res)=>{


const result =
await pool.query(
`
SELECT *
FROM withdrawals
WHERE id=$1
`,
[
req.params.id
]
);



if(!result.rows.length){

return res.status(404).json({
error:"Withdrawal not found"
});

}



res.json(
result.rows[0]
);


});







app.post(
    "/admin/withdraw/approve",
    adminAuth,
    async (req, res) => {

        const client = await pool.connect();

        try {

            const { id } = req.body;

            await client.query("BEGIN");

            const withdrawal = await client.query(
                `
                SELECT *
                FROM withdrawals
                WHERE id=$1
                AND status='Pending'
                FOR UPDATE
                `,
                [id]
            );

            if (!withdrawal.rows.length) {

                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: "Pending withdrawal not found"
                });

            }

            const wd = withdrawal.rows[0];

            const user = await client.query(
                `
                SELECT balance, pending_withdrawal
                FROM users
                WHERE email=$1
                FOR UPDATE
                `,
                [wd.email]
            );

            if (!user.rows.length) {

                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: "User not found"
                });

            }

            const balance = Number(user.rows[0].balance);
            const pending = Number(user.rows[0].pending_withdrawal);
            const amount = Number(wd.amount);

            if (balance < amount || pending < amount) {

                await client.query("ROLLBACK");

                return res.status(400).json({
                    error: "Insufficient balance or pending amount"
                });

            }

            await client.query(
                `
                UPDATE users
                SET
                    balance = balance - $1,
                    pending_withdrawal =
                    pending_withdrawal - $1
                WHERE email=$2
                `,
                [
                    amount,
                    wd.email
                ]
            );

            await client.query(
                `
                UPDATE withdrawals
                SET status='Approved'
                WHERE id=$1
                `,
                [id]
            );

            await client.query("COMMIT");

            res.json({
                success: true
            });

        } catch (error) {

            await client.query("ROLLBACK");

            console.error("APPROVE WITHDRAWAL ERROR:", error);

            res.status(500).json({
                error: "Approval failed"
            });

        } finally {

            client.release();

        }

    }
);







app.post(
    "/admin/withdraw/reject",
    adminAuth,
    async (req, res) => {

        const client = await pool.connect();

        try {

            const { id } = req.body;

            await client.query("BEGIN");

            const withdrawal = await client.query(
                `
                SELECT *
                FROM withdrawals
                WHERE id=$1
                AND status='Pending'
                FOR UPDATE
                `,
                [id]
            );

            if (!withdrawal.rows.length) {

                await client.query("ROLLBACK");

                return res.status(404).json({
                    error: "Pending withdrawal not found"
                });

            }

            const wd = withdrawal.rows[0];

            await client.query(
                `
                UPDATE users
                SET pending_withdrawal =
                    pending_withdrawal - $1
                WHERE email=$2
                `,
                [
                    wd.amount,
                    wd.email
                ]
            );

            await client.query(
                `
                UPDATE withdrawals
                SET status='Rejected'
                WHERE id=$1
                `,
                [id]
            );

            await client.query("COMMIT");

            res.json({
                success: true
            });

        } catch (error) {

            await client.query("ROLLBACK");

            console.error("REJECT WITHDRAWAL ERROR:", error);

            res.status(500).json({
                error: "Rejection failed"
            });

        } finally {

            client.release();

        }

    }
);







// ================= CLICK STATS =================



app.get(
"/admin/click-stats",
adminAuth,
async(req,res)=>{


const total =
await pool.query(
"SELECT COUNT(*) FROM clicks"
);



const conversions =
await pool.query(
`
SELECT COUNT(*)
FROM clicks
WHERE converted=true
`
);



res.json({

totalClicks:
total.rows[0].count,

conversions:
conversions.rows[0].count

});


});







// ================= OFFER STATS =================



app.get(
"/admin/offer-stats/:id",
adminAuth,
async(req,res)=>{


const clicks =
await pool.query(
`
SELECT COUNT(*)
FROM clicks
WHERE offer_id=$1
`,
[
req.params.id
]
);



const conversions =
await pool.query(
`
SELECT COUNT(*)
FROM clicks
WHERE offer_id=$1
AND converted=true
`,
[
req.params.id
]
);



res.json({

clicks:
clicks.rows[0].count,

conversions:
conversions.rows[0].count

});


});




app.get("/admin/stats", adminAuth, async (req, res) => {

    try {

        const users = await pool.query(
            "SELECT COUNT(*) AS total_users FROM users"
        );

        const clicks = await pool.query(
            "SELECT COUNT(*) AS total_clicks FROM clicks"
        );

        const balance = await pool.query(
            `
            SELECT COALESCE(SUM(balance), 0) AS total_balance
            FROM users
            `
        );

        res.json({

            users: users.rows[0].total_users,

            clicks: clicks.rows[0].total_clicks,

            balance: balance.rows[0].total_balance

        });

    } catch (error) {

        console.error("STATS ERROR:", error);

        res.status(500).json({
            error: "Stats error"
        });

    }

});
app.get("/admin/withdrawals", adminAuth, async(req,res)=>{
  try{

    const result = await pool.query(
      "SELECT * FROM withdrawals ORDER BY id DESC"
    );

    res.json(result.rows);

  }catch(error){

    console.error(error);

    res.status(500).json({
      error:"Failed to load withdrawals"
    });

  }
});
app.get("/admin/users", adminAuth, async (req,res)=>{
  try{

    const result = await pool.query(
      "SELECT id, username, email, balance, created_at FROM users ORDER BY id DESC"
    );

    res.json(result.rows);

  }catch(error){

    console.error(error);

    res.status(500).json({
      error:"Failed to get users"
    });

  }
});
app.get("/sm-control-8291", adminAuth, (req,res)=>{

res.sendFile(
path.join(
__dirname,
"sm-control-8291.html"
)
);

});
// ================= CLEAR CLICKS =================



app.delete(
"/admin/clear-clicks",
adminAuth,
async(req,res)=>{


await pool.query(
"DELETE FROM clicks"
);



res.json({
success:true
});


});


// ================= OFFERWALL.ME =================




// Open Offerwall.me for logged-in user
app.get("/offerwall", auth, (req, res) => {

    const userId = req.user.id;
    const apiKey = process.env.OFFERWALL_API_KEY;

    if (!apiKey) {
        return res.status(500).json({
            error: "Offerwall API key not configured"
        });
    }

    const offerwallUrl =
        `https://offerwall.me/offerwall/${apiKey}/${userId}`;

    res.json({
        success: true,
        url: offerwallUrl
    });

});


// Offerwall.me Postback
app.post("/postback/offerwallme", async (req, res) => {

    const client = await pool.connect();

    try {

        const {
            subId,
            transId,
            reward,
            offer_name,
            offer_type,
            payout,
            userIp,
            country,
            status,
            debug,
            signature
        } = req.body;


        // Required parameters
        if (!subId || !transId || !reward || !signature) {

            return res.status(400).send(
                "ERROR: Missing parameters"
            );

        }


        const secret =
            process.env.OFFERWALL_SECRET_KEY;


        if (!secret) {

            console.error(
                "OFFERWALL_SECRET_KEY is missing"
            );

            return res.status(500).send(
                "ERROR: Secret key not configured"
            );

        }


        // Create expected MD5 signature
        const expectedSignature = crypto
            .createHash("md5")
            .update(
                `${subId}${transId}${reward}${secret}`
            )
            .digest("hex");


        // Secure signature comparison
        if (
            expectedSignature.length !== signature.length ||
            !crypto.timingSafeEqual(
                Buffer.from(expectedSignature),
                Buffer.from(signature)
            )
        ) {

            return res.status(403).send(
                "ERROR: Signature doesn't match"
            );

        }


        // Prevent duplicate transaction
        const existingTransaction =
            await client.query(
                `
                SELECT id
                FROM offerwall_transactions
                WHERE transaction_id=$1
                `,
                [transId]
            );


        if (existingTransaction.rows.length > 0) {

            return res.send("ok");

        }


        // Find user
        const userResult =
            await client.query(
                `
                SELECT id
                FROM users
                WHERE id=$1
                `,
                [subId]
            );


        if (!userResult.rows.length) {

            return res.status(404).send(
                "ERROR: User not found"
            );

        }


        // Convert reward
        let rewardAmount =
            Number.parseFloat(reward);


        if (!Number.isFinite(rewardAmount)) {

            return res.status(400).send(
                "ERROR: Invalid reward"
            );

        }


        // Status 2 = chargeback
        if (String(status) === "2") {

            rewardAmount =
                -Math.abs(rewardAmount);

        }


        // Begin database transaction
        await client.query("BEGIN");


        // Add reward to user balance
        await client.query(
            `
            UPDATE users
            SET balance = balance + $1
            WHERE id=$2
            `,
            [
                rewardAmount,
                subId
            ]
        );


        // Save transaction
        await client.query(
            `
            INSERT INTO offerwall_transactions
            (
                user_id,
                transaction_id,
                offer_name,
                offer_type,
                reward,
                payout,
                user_ip,
                country,
                status,
                debug
            )
            VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            `,
            [
                subId,
                transId,
                offer_name || null,
                offer_type || null,
                rewardAmount,
                payout || 0,
                userIp || null,
                country || null,
                status || null,
                debug || null
            ]
        );


        await client.query("COMMIT");


        console.log(
            `✅ Offerwall conversion | User: ${subId} | Reward: ${rewardAmount}`
        );


        return res.send("ok");


    } catch (error) {

        await client.query("ROLLBACK");

        console.error(
            "Offerwall.me postback error:",
            error
        );

        return res.status(500).send(
            "ERROR"
        );

    } finally {

        client.release();

    }

});





// ================= START SERVER =================



app.listen(PORT,()=>{

console.log(
"🚀 SERVER RUNNING ON PORT",
PORT
);

});