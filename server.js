// server.js - KaribuBnB M-Pesa + Firestore backend
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const dotenv = require("dotenv");
const admin = require("firebase-admin");
const cors = require("cors");

dotenv.config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

// PORT Render provides via environment variable
const PORT = process.env.PORT || 5000;

// Initialize Firebase Admin using service account JSON passed via env var
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("FIREBASE_SERVICE_ACCOUNT env var missing. Provide JSON string.");
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// M-Pesa config from env
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY;
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET;
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE; // Paybill/Till
const MPESA_PASSKEY = process.env.MPESA_PASSKEY;
const CALLBACK_BASE = process.env.CALLBACK_BASE_URL; // e.g. https://your-service.onrender.com

if (!MPESA_CONSUMER_KEY || !MPESA_CONSUMER_SECRET || !MPESA_SHORTCODE || !MPESA_PASSKEY || !CALLBACK_BASE) {
  console.error("One or more M-Pesa env vars missing (MPESA_CONSUMER_KEY...).");
  process.exit(1);
}

// Use sandbox endpoints by default (change to production URLs if needed)
const OAUTH_URL = process.env.MPESA_ENV === "production"
  ? "https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"
  : "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";

const STK_URL = process.env.MPESA_ENV === "production"
  ? "https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest"
  : "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";

async function getMpesaToken() {
  const auth = Buffer.from(`${MPESA_CONSUMER_KEY}:${MPESA_CONSUMER_SECRET}`).toString("base64");
  const res = await axios.get(OAUTH_URL, { headers: { Authorization: `Basic ${auth}` } });
  return res.data.access_token;
}

function getTimestamp() {
  const now = new Date();
  const yyyy = now.getFullYear().toString();
  const mm = (now.getMonth() + 1).toString().padStart(2, "0");
  const dd = now.getDate().toString().padStart(2, "0");
  const hh = now.getHours().toString().padStart(2, "0");
  const mi = now.getMinutes().toString().padStart(2, "0");
  const ss = now.getSeconds().toString().padStart(2, "0");
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}`;
}

function makePassword(shortCode, passkey, timestamp) {
  const toEncode = `${shortCode}${passkey}${timestamp}`;
  return Buffer.from(toEncode).toString("base64");
}

// Normalize phone number to 2547XXXXXXXX format
function normalizePhone(phone) {
  phone = phone.replace(/\s+/g, "");
  if (phone.startsWith("0")) return "254" + phone.slice(1);
  if (phone.startsWith("+")) return phone.replace("+", "");
  if (phone.startsWith("254")) return phone;
  return phone; // as-is
}

// Endpoint to initiate STK Push
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount = process.env.MPESA_AMOUNT || "500" , accountRef = "KaribuBnB" } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: "phone required" });

    const normalized = normalizePhone(phone);
    const token = await getMpesaToken();
    const timestamp = getTimestamp();
    const password = makePassword(MPESA_SHORTCODE, MPESA_PASSKEY, timestamp);

    const payload = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: normalized,
      PartyB: MPESA_SHORTCODE,
      PhoneNumber: normalized,
      CallBackURL: `${CALLBACK_BASE}/callback`,
      AccountReference: accountRef,
      TransactionDesc: "Subscription Payment"
    };

    const response = await axios.post(STK_URL, payload, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    return res.json({ success: true, data: response.data });
  } catch (err) {
    console.error("STK Error", err.response ? err.response.data : err.message);
    return res.status(500).json({ success: false, message: err.message, data: err.response ? err.response.data : null });
  }
});

// Callback endpoint Safaricom will invoke
app.post("/callback", async (req, res) => {
  try {
    // Daraja sends callback JSON in req.body. Structure: Body.stkCallback
    const body = req.body;
    console.log("M-Pesa callback received:", JSON.stringify(body, null, 2));

    const stk = body?.Body?.stkCallback;
    if (!stk) {
      // respond success to avoid retries
      return res.json({ resultCode: 0, resultDesc: "No STK data" });
    }

    const resultCode = stk.ResultCode;
    const merchantRequestID = stk.MerchantRequestID;
    const checkoutRequestID = stk.CheckoutRequestID;

    if (resultCode === 0) {
      // payment success
      const meta = stk.CallbackMetadata?.Item || [];
      // Find phone number and Mpesa receipt
      const phoneItem = meta.find(i => i.Name === "PhoneNumber") || meta.find(i => i.Name === "MSISDN");
      const amountItem = meta.find(i => i.Name === "Amount");
      const mpesaReceipt = meta.find(i => i.Name === "MpesaReceiptNumber");

      const phone = phoneItem ? String(phoneItem.Value) : null;
      const amount = amountItem ? amountItem.Value : null;
      const receipt = mpesaReceipt ? mpesaReceipt.Value : null;

      console.log("Payment success for phone:", phone, "amount:", amount, "receipt:", receipt);

      const normalized = normalizePhone(phone || "");
      // Find host doc by phone field
      const snap = await db.collection("hosts").where("phone", "==", normalized).get();

      if (!snap.empty) {
        const hostDoc = snap.docs[0];
        const hostRef = hostDoc.ref;
        const now = new Date();
        const expiry = new Date(now);
        expiry.setMonth(expiry.getMonth() + 1); // extend by 1 month

        await hostRef.update({
          subscriptionActive: true,
          subscriptionExpiry: expiry.toISOString(),
          lastPayment: {
            amount,
            receipt,
            paidAt: admin.firestore.FieldValue.serverTimestamp()
          }
        });

        console.log("Updated host subscription for", normalized);
      } else {
        console.warn("No host found with phone:", normalized);
      }
    } else {
      console.log("Payment failed or cancelled, ResultCode:", resultCode, stk.ResultDesc);
    }

    // respond OK to Safaricom
    return res.json({ resultCode: 0, resultDesc: "Accepted" });
  } catch (err) {
    console.error("Callback processing error:", err);
    return res.json({ resultCode: 1, resultDesc: "Error" });
  }
});

app.get("/", (req, res) => res.send("KaribuBnB backend running"));

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
