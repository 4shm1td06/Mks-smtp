import express from "express";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// ✅ Fix CORS properly (for Vercel)
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
    return res.status(200).end();
  }

  next();
});

// --- Supabase ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- Nodemailer ---
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: Number(process.env.SMTP_PORT || 465) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const otpStore = new Map();
const pendingApprovals = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [email, record] of otpStore.entries()) {
    if (record.expiresAt < now) otpStore.delete(email);
  }
}, 60000);

async function sendOtpEmail(email, otp) {
  await transporter.sendMail({
    from: `"JECRC ERP" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Your OTP for Registration",
    html: `<div style="font-family:sans-serif;">
      <h3>Your OTP is: <strong>${otp}</strong></h3>
      <p>This OTP is valid for 5 minutes.</p>
    </div>`,
  });
}

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

async function sendApprovalSuccessEmail(email) {
  await transporter.sendMail({
    from: `"JECRC ERP System" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Your ERP Access Request Has Been Approved 🎉",
    html: `
      <div style="font-family:sans-serif;">
        <h2>Welcome to JU MakerSpace ERP</h2>
        <p>Your authentication request has been approved.</p>
        <a href="https://makerspace-portal.vercel.app"
           style="background:#2563eb;color:white;padding:10px 15px;text-decoration:none;border-radius:6px;">Go to ERP</a>
      </div>
    `,
  });
}

async function sendRejectionEmail(email) {
  await transporter.sendMail({
    from: `"JECRC ERP System" <${process.env.SMTP_USER}>`,
    to: email,
    subject: "Your ERP Registration Request Has Been Rejected",
    html: `<p>We regret to inform you that your registration request was rejected.</p>`,
  });
}

// --- Registration ---
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
      return res.json({ otpSent: true });
    } else {
      const approvalId = uuidv4();
      pendingApprovals.set(approvalId, { email, password });
      await sendApprovalEmail(email, approvalId);
      return res.json({ requiresApproval: true });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to process registration request." });
  }
});

// --- Verify OTP ---
app.post("/api/verify-otp", async (req, res) => {
  const { email, otp, password } = req.body;
  const record = otpStore.get(email);
  if (!record) return res.status(400).json({ error: "OTP not found or expired" });
  if (Date.now() > record.expiresAt)
    return res.status(400).json({ error: "OTP expired" });
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
    console.error(err);
    res.status(500).json({ error: "Error verifying OTP" });
  }
});

// --- Admin approval ---
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
      res.send(`<h3>✅ ${email} approved successfully!</h3>`);
    } catch (e) {
      res.send("<h3>⚠️ Error approving user.</h3>");
    }
  } else {
    await sendRejectionEmail(email);
    pendingApprovals.delete(id);
    res.send(`<h3>❌ ${email} registration rejected.</h3>`);
  }
});

// ✅ Export for Vercel
export default app;
