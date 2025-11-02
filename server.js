import express from "express";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ✅ Vercel-friendly CORS
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
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
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: smtpPort,
  secure: smtpPort === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// --- Temporary Stores (for OTP & Approvals) ---
const otpStore = new Map();
const pendingApprovals = new Map();

// --- Cleanup expired OTPs every 60s ---
setInterval(() => {
  const now = Date.now();
  for (const [email, record] of otpStore.entries()) {
    if (record.expiresAt < now) otpStore.delete(email);
  }
}, 60 * 1000);

// --- Email Utilities ---
async function sendOtpEmail(email, otp) {
  await transporter.sendMail({
   from: `"JU MKS ERP System" <${process.env.SMTP_USER}>`,
to: email,
subject: "Your One-Time Password (OTP) for Registration",
html: `
  <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f4f6f8; padding: 25px;">
    <div style="max-width: 520px; margin: 0 auto; background-color: #ffffff; border-radius: 10px; box-shadow: 0 3px 10px rgba(0,0,0,0.08); padding: 30px;">
      
      <!-- Logo Header -->
      <div style="text-align: center; margin-bottom: 15px;">
        <img src="https://jecrcuniversity.edu.in/wp-content/uploads/2023/02/JUMAKERSPACE-1.webp" 
             alt="JU Logo" width="80" height="80" style="border-radius: 8px; margin-bottom: 10px;">
        <h2 style="color: #003366; margin: 0;">JU MKS ERP System</h2>
      </div>

      <hr style="border: none; border-top: 2px solid #003366; width: 60px; margin: 20px auto;">

      <p style="font-size: 16px; color: #333;">Dear User,</p>
      <p style="font-size: 15px; color: #333;">
        Thank you for registering with the <strong>JU MKS ERP System</strong>.<br>
        Please use the One-Time Password (OTP) below to verify your email address:
      </p>

      <div style="text-align: center; margin: 25px 0;">
        <span style="display: inline-block; background-color: #003366; color: #ffffff; padding: 12px 30px; border-radius: 6px; font-size: 26px; font-weight: bold; letter-spacing: 2px;">
          ${otp}
        </span>
      </div>

      <p style="font-size: 14px; color: #555;">
        This OTP is valid for <strong>5 minutes</strong>.  
        Please do not share it with anyone to ensure your account’s security.
      </p>

      <p style="font-size: 14px; color: #555;">If you did not request this verification, please ignore this email.</p>

      <br>
      <p style="font-size: 13px; color: #888; text-align: center;">
        — JU MKS ERP Support Team <br>
        <a href="mailto:erp.makerspace@gmail.com" style="color:#003366; text-decoration:none;">erp.makerspace@gmail.com</a>
      </p>
    </div>
  </div>
`,
  });
}


async function sendApprovalEmail(email, approvalId) {
  const baseUrl = process.env.API_BASE_URL || "https://mks-smtp.vercel.app";
  const approveLink = `${baseUrl}/api/approve/${approvalId}?action=approve`;
  const rejectLink = `${baseUrl}/api/approve/${approvalId}?action=reject`;

  await transporter.sendMail({
    from: `"JU MKS ERP System" <${process.env.SMTP_USER}>`,
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

async function sendApprovalSuccessEmail(email) {
  await transporter.sendMail({
    from: `"JU MKS ERP System" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Your ERP Access Request Has Been Approved 🎉",
    html: `
      <div style="font-family:sans-serif;">
        <h2>Welcome to JU MakerSpace ERP</h2>
        <p>Your authentication request has been <strong>approved</strong> by the admin.</p>
        <p>You can now access the ERP using your credentials.</p>
        <p>
          <a href="https://makerspace-portal.vercel.app" 
             style="background:#2563eb;color:white;padding:10px 15px;text-decoration:none;border-radius:6px;display:inline-block;">
             Go to JU MKS ERP
          </a>
        </p>
      </div>
    `,
  });
}

async function sendRejectionEmail(email) {
  await transporter.sendMail({
    from: `"JECRC ERP System" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Your ERP Registration Request Has Been Rejected",
    html: `
      <div style="font-family:sans-serif;">
        <h2>JU Maker-Space ERP Registration Update</h2>
        <p>Your authentication request has been <strong>rejected</strong> by the admin.</p>
        <p>If you believe this was a mistake, please contact the ERP support team.</p>
      </div>
    `,
  });
}

// --- Request Registration ---
app.post("/api/request-registration", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  try {
    if (email.endsWith("@jecrcu.edu.in")) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 5 * 60 * 1000;
      otpStore.set(email, { otp, expiresAt });
      await sendOtpEmail(email, otp);
      console.log(`OTP generated for ${email}: ${otp}`);
      return res.json({ otpSent: true });
    } else {
      const approvalId = uuidv4();
      pendingApprovals.set(approvalId, { email, password });
      await sendApprovalEmail(email, approvalId);
      console.log(`Pending approval created: ${approvalId} for ${email}`);
      return res.json({ requiresApproval: true });
    }
  } catch (error) {
    console.error("Error in /request-registration:", error);
    res.status(500).json({ error: "Failed to process registration request." });
  }
});

// --- Verify OTP ---
app.post("/api/verify-otp", async (req, res) => {
  const { email, otp, password } = req.body;
  const record = otpStore.get(email);

  if (!email || !otp || !password)
    return res.status(400).json({ error: "Email, OTP, and password required" });

  if (!record) return res.status(400).json({ error: "OTP not found or expired" });
  if (Date.now() > record.expiresAt) {
    otpStore.delete(email);
    return res.status(400).json({ error: "OTP expired" });
  }
  if (record.otp !== otp) return res.status(400).json({ error: "Invalid OTP" });

  try {
    const { error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) throw error;

    otpStore.delete(email);
    res.json({ success: true });
  } catch (err) {
    console.error("Supabase error:", err);
    res.status(500).json({ error: "Server error during OTP verification" });
  }
});

// --- Admin Approval Links ---
app.get("/api/approve/:id", async (req, res) => {
  const { id } = req.params;
  const { action } = req.query;
  const pending = pendingApprovals.get(id);
  if (!pending) return res.send("<h3>Invalid or expired approval link.</h3>");

  const { email, password } = pending;

  if (action === "approve") {
    try {
      const { error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error) throw error;

      await sendApprovalSuccessEmail(email);
      pendingApprovals.delete(id);
      return res.send(`<h3>✅ ${email} approved successfully!</h3>`);
    } catch (err) {
      console.error(err);
      return res.send("<h3>⚠️ Error approving user.</h3>");
    }
  } else {
    await sendRejectionEmail(email);
    pendingApprovals.delete(id);
    return res.send(`<h3>❌ ${email} registration rejected.</h3>`);
  }
});

// ✅ Export for Vercel serverless
export default app;

// ✅ Local dev (optional)
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 7049;
  app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
}
