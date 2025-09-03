// server.js
// Run: node server.js
// Requires: npm i express mysql2 cors express-session bcrypt morgan

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const path = require("path");
const mysql = require("mysql2/promise");
const cors = require("cors");
const morgan = require("morgan");

const app = express();

/* ====== CONFIG ====== */
const PORT = process.env.PORT || 5000;
const DB_HOST = process.env.DB_HOST || "localhost";
const DB_USER = process.env.DB_USER || "root";
const DB_PASS = process.env.DB_PASS || "unitedaircon";
const DB_NAME = process.env.DB_NAME || "ac_store";

/* ====== DB POOL ====== */
const pool = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

/* ====== MIDDLEWARES ====== */
app.use(morgan("dev"));
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: "super-secret-session",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 6 },
  })
);

/* ====== STATIC FRONTEND ====== */
app.use(express.static(path.join(__dirname, "public")));

/* ====== HELPERS ====== */
function ensureAuth(req, res, next) {
  if (req.session.user) return next();
  return res.status(401).json({ requiresLogin: true });
}

/* ====== USER AUTH ====== */
app.post("/signup", async (req, res) => {
  try {
    const { name, email, username, password } = req.body || {};
    if (!name || !email || !username || !password)
      return res.status(400).json({ error: "All fields required" });

    const [existing] = await pool.query(
      `SELECT id FROM users WHERE username=? OR email=?`,
      [username, email]
    );
    if (existing.length)
      return res.status(400).json({ error: "Username or Email exists" });

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO users (name,email,username,password) VALUES (?,?,?,?)`,
      [name, email, username, hash]
    );

    res.json({ user: { id: result.insertId, name, email, username } });
  } catch (err) {
    console.error("Signup error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const [rows] = await pool.query(`SELECT * FROM users WHERE username=?`, [
      username,
    ]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "Invalid login" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Incorrect password" });

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      username: user.username,
    };
    res.json({ user: req.session.user });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ====== ADMIN LOGIN ====== */
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const [rows] = await pool.query(
      `SELECT * FROM admin_users WHERE username = ? AND password = ?`,
      [username, password]
    );
    if (!rows.length)
      return res.status(401).json({ message: "Invalid credentials" });
    req.session.admin = { id: rows[0].id, username: rows[0].username };
    res.json({ message: "Login successful", admin: rows[0].username });
  } catch (e) {
    console.error("Admin login error:", e);
    res.status(500).json({ message: "Failed to login" });
  }
});

/* ====== PRODUCTS CRUD ====== */
app.get("/api/admin/products", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM products ORDER BY id DESC");
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/admin/products", async (req, res) => {
  const { name, price, brand, ton, img } = req.body;
  if (!name || !price)
    return res.status(400).json({ error: "Name and Price are required" });

  try {
    const [result] = await pool.query(
      "INSERT INTO products (name, price, brand, ton, img) VALUES (?, ?, ?, ?, ?)",
      [name, price, brand, ton, img]
    );
    res.json({ success: true, id: result.insertId, message: "✅ Product added" });
  } catch (err) {
    console.error("Error inserting product:", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.put("/api/admin/products/:id", async (req, res) => {
  const { id } = req.params;
  const { name, price, brand, ton, img } = req.body;
  try {
    await pool.query(
      "UPDATE products SET name=?, price=?, brand=?, ton=?, img=? WHERE id=?",
      [name, price, brand, ton, img, id]
    );
    res.json({ message: "✅ Product updated" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/api/admin/products/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM products WHERE id=?", [req.params.id]);
    res.json({ message: "🗑 Product deleted" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// Create a new order with items
app.post("/api/orders", async (req, res) => {
  const { user_id, items } = req.body; // items = [{product_id, quantity, unit_price}]

  if (!user_id || !items || !items.length) {
    return res.status(400).json({ error: "User and items are required" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Calculate total
    const total_amount = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);

    // Insert order
    const [orderResult] = await conn.query(
      "INSERT INTO orders (user_id, total_amount, status) VALUES (?, ?, ?)",
      [user_id, total_amount, "Pending"]
    );
    const orderId = orderResult.insertId;

    // Insert each order item
    for (const item of items) {
      const [product] = await conn.query("SELECT name FROM products WHERE id=?", [item.product_id]);
      const product_name = product[0].name;

      await conn.query(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, line_total) 
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          orderId,
          item.product_id,
          product_name,
          item.quantity,
          item.unit_price,
          item.quantity * item.unit_price,
        ]
      );
    }

    await conn.commit();
    res.json({ orderId, message: "✅ Order created successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("Order creation error:", err);
    res.status(500).json({ error: "Failed to create order" });
  } finally {
    conn.release();
  }
});















/* ====== BOOKINGS ====== */
app.post("/api/bookings", async (req, res) => {
  const { name, phone, service, date } = req.body;
  try {
    const [result] = await pool.query(
      "INSERT INTO bookings (name, phone, service, date) VALUES (?,?,?,?)",
      [name, phone, service, date]
    );
    res.json({ success: true, id: result.insertId, message: "✅ Booking added" });
  } catch (err) {
    console.error("Booking insertion error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.get("/api/admin/bookings", async (_req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM bookings ORDER BY id DESC");
    res.json(rows);
  } catch (err) {
    console.error("Fetch bookings error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

/* ====== START SERVER ====== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
