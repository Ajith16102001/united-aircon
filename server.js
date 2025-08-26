const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const path = require('path');
const mysql = require('mysql2/promise');

const app = express();

// ===== MySQL Pool =====
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'unitedaircon',
  database: 'ac_store',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// ===== Middlewares =====
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: 'super-secret-session',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 6 } // 6 hours
  })
);

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// ===== Helpers =====
function ensureAuth(req, res, next) {
  if (req.session.user) return next();
  return res.status(401).json({ requiresLogin: true });
}
function getCart(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}

// ------------------ SIGNUP ------------------
app.post('/signup', async (req, res) => {
  try {
    const { name, email, username, password } = req.body;
    if (!name || !email || !username || !password)
      return res.status(400).json({ error: 'All fields required' });

    const [existing] = await pool.query(
      `SELECT id FROM users WHERE username=? OR email=?`,
      [username, email]
    );
    if (existing.length) return res.status(400).json({ error: 'Username or Email exists' });

    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO users (name,email,username,password) VALUES (?,?,?,?)`,
      [name, email, username, hash]
    );

    res.json({ user: { userId: result.insertId, name, email, username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ------------------ LOGIN ------------------
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'All fields required' });

    const [rows] = await pool.query(`SELECT * FROM users WHERE username=?`, [username]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'Invalid username or password' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });

    req.session.user = { id: user.id, name: user.name, email: user.email, username: user.username };
    res.json({ user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});


// --- Bookings ---
app.get("/api/bookings", async (_req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM bookings ORDER BY created_at DESC`);
    res.json(rows);
  } catch (e) {
    console.error("Get bookings error:", e);
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
});

app.post("/api/bookings", async (req, res) => {
  const { name, phone, service, address } = req.body || {};
  if (!name || !phone || !service || !address) return res.status(400).json({ message: "Missing fields" });
  try {
    const [r] = await pool.query(
      `INSERT INTO bookings (name, phone, service, address) VALUES (?,?,?,?)`,
      [name, phone, service, address]
    );
    res.json({ message: "Booking saved", bookingId: r.insertId });
  } catch (e) {
    console.error("Create booking error:", e);
    res.status(500).json({ message: "Failed to create booking" });
  }
});

// ------------------ SAVE SHIPPING ------------------
app.post('/save-shipping', ensureAuth, (req, res) => {
  const { shipping, cart } = req.body;
  if (!shipping || !cart || !cart.length) return res.status(400).json({ error: 'Shipping or cart missing' });

  req.session.shipping = shipping;
  req.session.cart = cart;

  // Create temporary orderId to use for payment/summary
  const orderId = Date.now();
  req.session.lastOrderId = orderId;

  res.json({ orderId });
});

// ------------------ SAVE PAYMENT ------------------
app.post('/save-payment', ensureAuth, async (req, res) => {
  const { paymentMethod, extraCharge } = req.body;
  const cart = req.session.cart;
  const shipping = req.session.shipping;
  const user = req.session.user;

  if (!cart || !cart.length) return res.status(400).json({ error: 'Cart empty' });
  if (!shipping) return res.status(400).json({ error: 'Shipping info missing' });

  const total = cart.reduce((s, it) => s + Number(it.price) * Number(it.qty), 0);
  const paymentStatus = paymentMethod === 'cod' ? 'PENDING' : 'PAID';

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Insert order
    const [orderResult] = await conn.query(
      `INSERT INTO orders 
      (user_id, shipping_name, shipping_phone, shipping_address1, shipping_city, shipping_state, shipping_zip, payment_method, payment_status, total_amount)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        user.id,
        shipping.name,
        shipping.phone,
        shipping.address,
        shipping.city,
        shipping.state,
        shipping.pincode,
        paymentMethod,
        paymentStatus,
        Number((total + (extraCharge || 0)).toFixed(2))
      ]
    );

    const orderId = orderResult.insertId;

    // Insert order items
    for (const it of cart) {
      await conn.query(
        `INSERT INTO order_items (order_id, product_name, quantity, unit_price, line_total)
        VALUES (?,?,?,?,?)`,
        [
          orderId,
          it.name,
          it.qty,
          Number(it.price),
          Number((it.qty * it.price).toFixed(2))
        ]
      );
    }

    await conn.commit();

    // Store last order info in session for summary
    req.session.lastOrderId = orderId;
    req.session.paymentInfo = { method: paymentMethod, extraCharge: extraCharge || 0 };
    req.session.cart = []; // clear cart

    res.json({ orderId });
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: 'Payment saving failed' });
  } finally {
    conn.release();
  }
});

// ------------------ SUMMARY API ------------------
app.get('/api/orders/:id', ensureAuth, async (req, res) => {
  const orderId = req.params.id;
  try {
    const [orders] = await pool.query(`SELECT * FROM orders WHERE id=?`, [orderId]);
    if (!orders.length) return res.status(404).json({ error: 'Order not found' });

    const order = orders[0];
    const [items] = await pool.query(`SELECT * FROM order_items WHERE order_id=?`, [orderId]);

    res.json({
      orderId: order.id,
      date: order.created_at || new Date(),
      customer: { name: req.session.user.name, email: req.session.user.email },
      shipping: {
        name: order.shipping_name,
        phone: order.shipping_phone,
        address: order.shipping_address1,
        city: order.shipping_city,
        state: order.shipping_state,
        pincode: order.shipping_zip
      },
      payment: {
        method: order.payment_method,
        extraCharge: order.payment_status === 'PENDING' ? 10 : 0
      },
      items,
      totals: {
        subtotal: items.reduce((s, it) => s + it.line_total, 0),
        shipping: 200,
        tax: items.reduce((s, it) => s + it.line_total, 0) * 0.18,
        grand: items.reduce((s, it) => s + it.line_total, 0) * 1.18 + 200
      },
      status: order.payment_status
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});


// ------------------ START SERVER ------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
