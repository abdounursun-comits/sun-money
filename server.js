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



function adminAuth(req,res,next){

    const token =
    req.headers.authorization?.split(" ")[1];


    if(!token){
        return res.status(401).json({
            error:"No admin token"
        });
    }


    jwt.verify(token,ADMIN_SECRET,(err)=>{

        if(err){
            return res.status(403).json({
                error:"Invalid admin token"
            });
        }


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

app.get("/api/offers", async (req,res)=>{

try{

const result = await pool.query(
`
SELECT id,title,url,reward
FROM offers
WHERE active=true
ORDER BY id DESC
`
);

res.json(result.rows);


}catch(err){

console.log(err);

res.status(500).json({
error:"Cannot load offers"
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

app.post("/admin/offers",adminAuth,async(req,res)=>{


try{


const {
title,
url,
reward
}=req.body;



const result =
await pool.query(
`
INSERT INTO offers
(title,url,reward)
VALUES($1,$2,$3)
RETURNING *
`,
[
title,
url,
reward || 0.20
]
);



res.json(result.rows[0]);



}catch(err){

console.log(err);

res.status(500).json({
error:"Offer creation failed"
});

}


});





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


app.get(
"/click/:offerId",
async(req,res)=>{


try{


const {
offerId
}=req.params;


const {
email
}=req.query;



const ip=req.ip;



const offer =
await pool.query(
`
SELECT *
FROM offers
WHERE id=$1
AND active=true
`,
[
offerId
]
);



if(!offer.rows.length){

return res.status(404).send(
"Offer not found"
);

}




const click =
await pool.query(
`
INSERT INTO clicks
(offer_id,email,ip)
VALUES($1,$2,$3)
RETURNING id
`,
[
offerId,
email || "",
ip
]
);



let url =
offer.rows[0].url;



const clickId =
click.rows[0].id;



if(url.includes("?")){

url +=
`&click_id=${clickId}`;

}else{

url +=
`?click_id=${clickId}`;

}



res.redirect(url);



}catch(err){

console.log(err);

res.status(500).send(
"Click error"
);

}


});







// ================= POSTBACK =================


app.get(
"/postback",
async(req,res)=>{


try{


const {
click_id,
secret
}=req.query;



if(secret !== POSTBACK_SECRET){

return res.status(403).send(
"INVALID SECRET"
);

}




const click =
await pool.query(
`
SELECT *
FROM clicks
WHERE id=$1
`,
[
click_id
]
);



if(!click.rows.length){

return res.status(404).send(
"CLICK NOT FOUND"
);

}




const c =
click.rows[0];



if(c.converted){

return res.send(
"DUPLICATE"
);

}




const offer =
await pool.query(
`
SELECT reward
FROM offers
WHERE id=$1
`,
[
c.offer_id
]
);



if(!offer.rows.length){

return res.status(404).send(
"OFFER NOT FOUND"
);

}



const reward =
Number(
offer.rows[0].reward
);





await pool.query(
`
UPDATE clicks
SET converted=true,
payout=$1
WHERE id=$2
`,
[
reward,
click_id
]
);





await pool.query(
`
UPDATE users
SET balance=balance+$1
WHERE email=$2
`,
[
reward,
c.email
]
);





res.send(
"OK"
);



}catch(err){

console.log(err);

res.status(500).send(
"POSTBACK ERROR"
);


}


});
// ================= USER DASHBOARD =================


app.get("/user/dashboard", auth, async(req,res)=>{

try{


const user =
await pool.query(
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
]
);



if(!user.rows.length){

return res.status(404).json({
error:"User not found"
});

}



const clicks =
await pool.query(
`
SELECT COUNT(*)
FROM clicks
WHERE email=$1
`,
[
req.user.email
]
);




const withdrawals =
await pool.query(
`
SELECT *
FROM withdrawals
WHERE email=$1
ORDER BY created_at DESC
`,
[
req.user.email
]
);



res.json({

user:user.rows[0],

clicks:clicks.rows[0].count,

withdrawals:withdrawals.rows

});



}catch(err){

console.log(err);

res.status(500).json({
error:"Dashboard error"
});

}


});







// ================= WITHDRAW REQUEST =================


app.post("/withdraw", auth, async(req,res)=>{


try{


const {
method,
account,
amount
}=req.body;



const user =
await pool.query(
`
SELECT balance,pending_withdrawal
FROM users
WHERE id=$1
`,
[
req.user.id
]
);



if(!user.rows.length){

return res.status(404).json({
error:"User not found"
});

}



const balance =
Number(user.rows[0].balance);



const pending =
Number(user.rows[0].pending_withdrawal);



const withdrawAmount =
Number(amount);



if(withdrawAmount < 10){

return res.status(400).json({
error:"Minimum withdrawal is $10"
});

}



if(
balance - pending < withdrawAmount
){

return res.status(400).json({
error:"Insufficient balance"
});

}





await pool.query(
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





await pool.query(
`
INSERT INTO withdrawals
(email,method,account,amount)
VALUES($1,$2,$3,$4)
`,
[
req.user.email,
method,
account,
withdrawAmount
]
);





res.json({
success:true,
message:"Withdrawal pending"
});



}catch(err){

console.log(err);

res.status(500).json({
error:"Withdrawal failed"
});

}


});







// ================= NOTIFICATIONS =================



app.post(
"/admin/notify",
adminAuth,
async(req,res)=>{


try{


const {
user_id,
message
}=req.body;



await pool.query(
`
INSERT INTO notifications
(user_id,message)
VALUES($1,$2)
`,
[
user_id,
message
]
);



res.json({
success:true
});



}catch(err){

console.log(err);

res.status(500).json({
error:"Notification failed"
});

}


});







app.get(
"/notifications",
auth,
async(req,res)=>{


const result =
await pool.query(
`
SELECT *
FROM notifications
WHERE user_id=$1
ORDER BY created_at DESC
`,
[
req.user.id
]
);



res.json(
result.rows
);


});
// ================= ADMIN DASHBOARD =================


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


const balance =
await pool.query(
"SELECT COALESCE(SUM(balance),0) FROM users"
);



res.json({

users: users.rows[0].count,

offers: offers.rows[0].count,

clicks: clicks.rows[0].count,

withdrawals: withdrawals.rows[0].count,

totalBalance: balance.rows[0].coalesce

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
async(req,res)=>{


await pool.query(
`
DELETE FROM users
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







app.post(
"/admin/user/balance",
adminAuth,
async(req,res)=>{


const {
id,
balance
}=req.body;



await pool.query(
`
UPDATE users
SET balance=$1
WHERE id=$2
`,
[
balance,
id
]
);



res.json({
success:true
});


});







app.post(
"/admin/user/reset-balance",
adminAuth,
async(req,res)=>{


const {
id
}=req.body;



await pool.query(
`
UPDATE users
SET balance=0
WHERE id=$1
`,
[
id
]
);



res.json({
success:true
});


});







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
async(req,res)=>{


const {
id
}=req.body;



const withdrawal =
await pool.query(
`
SELECT *
FROM withdrawals
WHERE id=$1
AND status='Pending'
`,
[
id
]
);



if(!withdrawal.rows.length){

return res.status(404).json({
error:"Pending withdrawal not found"
});

}



const wd =
withdrawal.rows[0];




await pool.query(
`
UPDATE users
SET 
balance = balance-$1,
pending_withdrawal = pending_withdrawal-$1
WHERE email=$2
`,
[
wd.amount,
wd.email
]
);




await pool.query(
`
UPDATE withdrawals
SET status='Approved'
WHERE id=$1
`,
[
id
]
);



res.json({
success:true
});


});







app.post(
"/admin/withdraw/reject",
adminAuth,
async(req,res)=>{


const {
id
}=req.body;



const withdrawal =
await pool.query(
`
SELECT *
FROM withdrawals
WHERE id=$1
AND status='Pending'
`,
[
id
]
);



if(!withdrawal.rows.length){

return res.status(404).json({
error:"Pending withdrawal not found"
});

}



const wd =
withdrawal.rows[0];




await pool.query(
`
UPDATE users
SET pending_withdrawal =
pending_withdrawal-$1
WHERE email=$2
`,
[
wd.amount,
wd.email
]
);




await pool.query(
`
UPDATE withdrawals
SET status='Rejected'
WHERE id=$1
`,
[
id
]
);



res.json({
success:true
});


});







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

app.get("/admin/users", adminAuth, async (req, res) => {
  const result = await pool.query(`
    SELECT
      id,
      username,
      email,
      balance,
      created_at
    FROM users
    ORDER BY id DESC
  `);

  res.json(result.rows);
});
app.get("/admin/withdrawals", adminAuth, async (req, res) => {
  const result = await pool.query(`
    SELECT *
    FROM withdrawals
    ORDER BY created_at DESC
  `);

  res.json(result.rows);
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







// ================= START SERVER =================



app.listen(PORT,()=>{

console.log(
"🚀 SERVER RUNNING ON PORT",
PORT
);

});