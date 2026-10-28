
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;
const PUBLIC_DIR = path.join(__dirname, "public");

const requiredEnv = [
  "DATABASE_URL",
  "ADMIN_USER",
  "ADMIN_PASSWORD_HASH",
  "SESSION_SECRET"
];

const missingEnv = requiredEnv.filter(
  key => !process.env[key]
);

if (missingEnv.length) {
  console.error(
    "Missing environment variables:",
    missingEnv.join(", ")
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.set("trust proxy", 1);

app.use(express.json({ limit: "50kb" }));
app.use(express.urlencoded({
  extended: false,
  limit: "50kb"
}));

app.use(session({
  name: "ffx_admin_session",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 8 * 60 * 60 * 1000
  }
}));

// Customer site and admin files must be inside public/
app.use(express.static(PUBLIC_DIR, {
  index: false,
  maxAge: "1h"
}));

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "FFX.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

app.get("/admin.html", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "admin.html"));
});

// Admin authentication middleware
function adminOnly(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }

  return res.status(401).json({
    error: "Admin login required"
  });
}

function cleanText(value, max = 120) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

// Create database tables
async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id BIGSERIAL PRIMARY KEY,
      player_uid TEXT NOT NULL,
      package_name TEXT NOT NULL DEFAULT '',
      amount INTEGER NOT NULL CHECK (amount > 0),
      method TEXT NOT NULL
        CHECK (method IN ('bKash', 'Nagad')),
      trxid TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (
          status IN ('Pending', 'Approved', 'Rejected')
        ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Upgrade an existing orders table if needed
  await pool.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS package_name
    TEXT NOT NULL DEFAULT ''
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      bkash_number TEXT NOT NULL DEFAULT '',
      nagad_number TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    INSERT INTO payment_settings
      (id, bkash_number, nagad_number)
    VALUES (1, '', '')
    ON CONFLICT (id) DO NOTHING
  `);
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "FFX TOPUP BD"
  });
});

// Admin login
app.post("/api/login", async (req, res) => {
  const username = cleanText(req.body?.username, 100);
  const password =
    typeof req.body?.password === "string"
      ? req.body.password
      : "";

  if (!username || !password) {
    return res.status(400).json({
      error: "Username and password are required"
    });
  }

  let passwordMatches = false;

  try {
    passwordMatches = await bcrypt.compare(
      password,
      process.env.ADMIN_PASSWORD_HASH
    );
  } catch (error) {
    console.error("Password verification error:", error.message);
  }

  if (
    username !== process.env.ADMIN_USER ||
    !passwordMatches
  ) {
    return res.status(401).json({
      error: "Invalid username or password"
    });
  }

  req.session.regenerate(error => {
    if (error) {
      return res.status(500).json({
        error: "Could not create admin session"
      });
    }

    req.session.isAdmin = true;
    req.session.adminUser = username;

    req.session.save(saveError => {
      if (saveError) {
        return res.status(500).json({
          error: "Could not save admin session"
        });
      }

      res.json({
        ok: true,
        message: "Login successful"
      });
    });
  });
});

// Check admin session
app.get("/api/session", (req, res) => {
  res.json({
    loggedIn: Boolean(req.session?.isAdmin)
  });
});

// Admin logout
app.post("/api/logout", (req, res) => {
  req.session.destroy(error => {
    res.clearCookie("ffx_admin_session");

    if (error) {
      return res.status(500).json({
        error: "Logout failed"
      });
    }

    res.json({ ok: true });
  });
});

// Public: customers can read payment numbers
app.get("/api/payment-settings", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT bkash_number, nagad_number
      FROM payment_settings
      WHERE id = 1
    `);

    res.set("Cache-Control", "no-store");

    res.json(
      result.rows[0] || {
        bkash_number: "",
        nagad_number: ""
      }
    );
  } catch (error) {
    console.error("Payment settings read error:", error);

    res.status(500).json({
      error: "Could not load payment settings"
    });
  }
});

// Admin: update payment numbers
app.put(
  "/api/payment-settings",
  adminOnly,
  async (req, res) => {
    const bkash = cleanText(
      req.body?.bkash_number,
      40
    );

    const nagad = cleanText(
      req.body?.nagad_number,
      40
    );

    try {
      const result = await pool.query(`
        UPDATE payment_settings
        SET
          bkash_number = $1,
          nagad_number = $2,
          updated_at = NOW()
        WHERE id = 1
        RETURNING bkash_number, nagad_number
      `, [bkash, nagad]);

      res.json({
        ok: true,
        settings: result.rows[0]
      });
    } catch (error) {
      console.error("Payment settings save error:", error);

      res.status(500).json({
        error: "Could not save payment settings"
      });
    }
  }
);

// Customer submits an order
app.post("/api/orders", async (req, res) => {
  const uid = cleanText(
    req.body?.player_uid || req.body?.uid,
    40
  );

  const packageName = cleanText(
    req.body?.package_name ||
    req.body?.packageName ||
    req.body?.package,
    120
  );

  const amount = Number(req.body?.amount);

  const rawMethod = cleanText(
    req.body?.method || req.body?.payment_method,
    20
  ).toLowerCase();

  const method =
    rawMethod === "bkash"
      ? "bKash"
      : rawMethod === "nagad"
        ? "Nagad"
        : "";

  const trxid = cleanText(
    req.body?.trxid ||
    req.body?.trxId ||
    req.body?.transaction_id,
    100
  );

  if (!uid || !/^[A-Za-z0-9_-]+$/.test(uid)) {
    return res.status(400).json({
      error: "Enter a valid Player UID"
    });
  }

  if (
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    amount > 1000000
  ) {
    return res.status(400).json({
      error: "Enter a valid package amount"
    });
  }

  if (!method) {
    return res.status(400).json({
      error: "Select bKash or Nagad"
    });
  }

  if (trxid.length < 4) {
    return res.status(400).json({
      error: "Enter a valid TrxID"
    });
  }

  try {
    const result = await pool.query(`
      INSERT INTO orders (
        player_uid,
        package_name,
        amount,
        method,
        trxid
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING
        id,
        player_uid,
        package_name,
        amount,
        method,
        trxid,
        status,
        created_at
    `, [
      uid,
      packageName,
      amount,
      method,
      trxid
    ]);

    res.status(201).json({
      ok: true,
      message:
        "Order submitted. Payment will be checked by admin.",
      order: result.rows[0]
    });
  } catch (error) {
    console.error("Order create error:", error);

    res.status(500).json({
      error: "Could not submit order"
    });
  }
});

// Admin: view and search orders
app.get("/api/orders", adminOnly, async (req, res) => {
  const search = cleanText(req.query.search, 120);

  try {
    const result = await pool.query(`
      SELECT
        id,
        player_uid,
        package_name,
        amount,
        method,
        trxid,
        status,
        created_at
      FROM orders
      WHERE (
        $1 = ''
        OR player_uid ILIKE '%' || $1 || '%'
        OR trxid ILIKE '%' || $1 || '%'
        OR id::text = $1
      )
      ORDER BY created_at DESC
      LIMIT 200
    `, [search]);

    res.json(result.rows);
  } catch (error) {
    console.error("Orders read error:", error);

    res.status(500).json({
      error: "Could not load orders"
    });
  }
});

// Admin dashboard statistics
app.get("/api/dashboard", adminOnly, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE status = 'Pending'
        )::int AS pending,
        COUNT(*) FILTER (
          WHERE status = 'Approved'
        )::int AS approved,
        COUNT(*) FILTER (
          WHERE status = 'Rejected'
        )::int AS rejected
      FROM orders
    `);

    res.json(result.rows[0]);
  } catch (error) {
    console.error("Dashboard error:", error);

    res.status(500).json({
      error: "Could not load dashboard"
    });
  }
});

// Admin approves or rejects a pending order
app.post(
  "/api/orders/:id/status",
  adminOnly,
  async (req, res) => {
    const id = req.params.id;
    const status = req.body?.status;

    if (
      !/^\d+$/.test(id) ||
      !["Approved", "Rejected"].includes(status)
    ) {
      return res.status(400).json({
        error: "Invalid order ID or status"
      });
    }

    try {
      const result = await pool.query(`
        UPDATE orders
        SET status = $1
        WHERE id = $2 AND status = 'Pending'
        RETURNING id, status
      `, [status, id]);

      if (!result.rowCount) {
        return res.status(404).json({
          error: "Pending order not found"
        });
      }

      res.json({
        ok: true,
        order: result.rows[0]
      });
    } catch (error) {
      console.error("Order status update error:", error);

      res.status(500).json({
        error: "Could not update order status"
      });
    }
  }
);

// Unknown route
app.use((req, res) => {
  res.status(404).json({
    error: "Not found"
  });
});

// Start only after database initialization succeeds
initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(
        `FFX TOPUP BD listening on port ${PORT}`
      );
    });
  })
  .catch(error => {
    console.error(
      "Database initialization failed:",
      error
    );
    process.exit(1);
  });
