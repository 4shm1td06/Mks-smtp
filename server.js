// server.js
import express from "express";
import cors from "cors";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ✅ Universal HTTPS-safe CORS middleware (works on Vercel)
app.use((req, res, next) => {
  const allowedOrigins = [
    "https://makerspace-portal.vercel.app",
    "http://localhost:5173",
  ];
  const origin = req.headers.origin;

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");

  if (req.method === "OPTIONS") {
    // Respond to preflight immediately
    return res.sendStatus(200);
  }

  next();
});


// --- Supabase Setup ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- Nodemailer SMTP ---
const smtpPort = Number(process.env.SMTP_PORT || 465);
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465, // true for 465 (TLS), false for 587 (STARTTLS)
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// --- In-memory stores (temporary) ---
const otpStore = new Map(); // email -> { otp, expiresAt }
const pendingApprovals = new Map(); // approvalId -> { email, password }

// small periodic cleanup for expired OTPs
setInterval(() => {
  const now = Date.now();
  for (const [email, record] of otpStore.entries()) {
    if (record.expiresAt && record.expiresAt < now) {
      otpStore.delete(email);
    }
  }
}, 60 * 1000); // every minute

// --- Utility: Send OTP Email ---
async function sendOtpEmail(email, otp) {
  await transporter.sendMail({
    from: `"JECRC ERP" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Your OTP for Registration",
    html: `
      <div style="font-family:sans-serif;">
        <h3>Your OTP is: <strong>${otp}</strong></h3>
        <p>This OTP is valid for 5 minutes.</p>
      </div>
    `,
  });
}

// --- Utility: Send Admin Approval Email ---
async function sendApprovalEmail(email, approvalId) {
  const baseUrl = process.env.API_BASE_URL || "https://mks-smtp.vercel.app";
  const approveLink = `${baseUrl}/api/approve/${approvalId}?action=approve`;
  const rejectLink = `${baseUrl}/api/approve/${approvalId}?action=reject`;

  await transporter.sendMail({
    from: `"JECRC ERP System" <${process.env.SMTP_USER}>`,
    to: "erp.makerspace@gmail.com",
    subject: "New Registration Request Pending Approval",
    html: `
      <div style="font-family:sans-serif;">
        <h2>New Registration Request</h2>
        <p>Email: <strong>${email}</strong></p>
        <p>Click below to approve or reject:</p>
        <p>
          <a href="${approveLink}" style="background:#22c55e;color:white;padding:10px 15px;text-decoration:none;">Approve</a>
          <a href="${rejectLink}" style="background:#ef4444;color:white;padding:10px 15px;text-decoration:none;margin-left:10px;">Reject</a>
        </p>
      </div>
    `,
  });
}

// --- Utility: Send Email to User After Approval ---
async function sendApprovalSuccessEmail(email) {
  await transporter.sendMail({
    from: `"JECRC ERP System" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Your ERP Access Request Has Been Approved 🎉",
    html: `
      <div style="font-family:sans-serif;">
        <h2>Welcome to JU MakerSpace ERP</h2>
        <p>Dear User,</p>
        <p>Your authentication request has been <strong>approved</strong> by the admin.</p>
        <p>You can now access the ERP using the credentials you set during registration.</p>
        <p>
          <a href="https://makerspace-portal.vercel.app" 
             style="background:#2563eb;color:white;padding:10px 15px;
                    text-decoration:none;border-radius:6px;display:inline-block;">
             Go to JU MKS ERP
          </a>
        </p>
        <p>If you face any issues logging in, please contact the ERP support team.</p>
        <br/>
        <p>Best regards,<br/>JECRC ERP Team</p>
      </div>
    `,
  });
}

// --- Utility: Send Email to User After Rejection ---
async function sendRejectionEmail(email) {
  await transporter.sendMail({
    from: `"JECRC ERP System" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Your ERP Registration Request Has Been Rejected",
    html: `
      <div style="font-family:sans-serif;">
        <h2>JU Maker-Space ERP Registration Update</h2>
        <p>Dear User,</p>
        <p>We regret to inform you that your authentication request has been <strong>rejected</strong> by the admin.</p>
        <p>If you believe this was a mistake, please contact the ERP support team for clarification.</p>
        <br/>
        <p>Best regards,<br/>JU Maker-Space ERP Team</p>
      </div>
    `,
  });
}

// --- Request Registration Route ---
app.post("/api/request-registration", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  try {
    if (email.endsWith("@jecrcu.edu.in")) {
      // JECRC user → send OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
      otpStore.set(email, { otp, expiresAt });

      await sendOtpEmail(email, otp);

      console.log(
        `OTP generated for ${email}: ${otp} (expires ${new Date(
          expiresAt
        ).toISOString()})`
      );
      return res.json({ otpSent: true });
    } else {
      // External user → requires approval
      const approvalId = uuidv4();
      pendingApprovals.set(approvalId, { email, password });

      await sendApprovalEmail(email, approvalId);

      console.log(`Pending approval created: ${approvalId} for ${email}`);
      return res.json({ requiresApproval: true });
    }
  } catch (error) {
    console.error("Error in /request-registration:", error);
    return res
      .status(500)
      .json({ error: "Failed to process registration request." });
  }
});

// --- OTP Verification Route ---
app.post("/api/verify-otp", async (req, res) => {
  const { email, otp, password } = req.body;

  if (!email || !otp || !password)
    return res.status(400).json({ error: "Email, OTP, and password required" });

  const record = otpStore.get(email);
  if (!record) return res.status(400).json({ error: "OTP not found or expired" });
  if (Date.now() > record.expiresAt) {
    otpStore.delete(email);
    return res.status(400).json({ error: "OTP expired" });
  }
  if (record.otp !== otp) return res.status(400).json({ error: "Invalid OTP" });

  try {
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) {
      console.error("Supabase createUser error:", error);
      return res.status(500).json({ error: "Failed to create user" });
    }

    otpStore.delete(email);
    console.log("User created in Supabase (admin):", data);
    return res.json({ success: true, message: "User created successfully!" });
  } catch (err) {
    console.error("Error in /verify-otp:", err);
    return res
      .status(500)
      .json({ error: "Server error during OTP verification" });
  }
});

// --- Approval Handler ---
app.get("/api/approve/:id", async (req, res) => {
  const { id } = req.params;
  const { action } = req.query;
  const pending = pendingApprovals.get(id);

  if (!pending) {
    return res.send("<h3>Invalid or expired approval link.</h3>");
  }

  const { email, password } = pending;

  if (action === "approve") {
    try {
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });

      if (error) {
        console.error("Supabase createUser (approval) error:", error);
        return res.send("<h3>⚠️ Failed to create user in Supabase.</h3>");
      }

      // Send confirmation email to user after approval
      await sendApprovalSuccessEmail(email);

      pendingApprovals.delete(id);
      console.log("Approved and created user:", email);
      return res.send(
        `<h3>✅ ${email} approved and registered successfully! A confirmation email has been sent.</h3>`
      );
    } catch (err) {
      console.error("Error creating approved user:", err);
      return res.send("<h3>⚠️ Internal server error while approving user.</h3>");
    }
  } else {
    // Send rejection email to user
    await sendRejectionEmail(email);
    pendingApprovals.delete(id);
    return res.send(`<h3>❌ ${email} registration rejected.</h3>`);
  }
});

// --- Server Start ---
const PORT = process.env.PORT || 7049;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
