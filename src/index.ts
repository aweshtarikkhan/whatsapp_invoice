import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import {
  getSessionStatus,
  startWhatsAppSession,
  qrCodes,
  logoutSession,
  sendMessage
} from "./whatsapp";
import { supabase } from "./supabase";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3001;

// Health check for aaPanel
app.get("/", (req, res) => {
  res.status(200).send("WhatsApp Microservice is running!");
});

app.get("/api/session/:org_id/qr", async (req, res) => {
  const orgId = req.params.org_id;
  try {
    const status = await getSessionStatus(orgId);
    if (status === "connected") {
      return res.status(200).json({ status: "connected", qr: null });
    }

    if (!qrCodes[orgId]) {
      await startWhatsAppSession(orgId);
    }

    // Wait a brief moment for QR generation if just started
    let retries = 5;
    while (!qrCodes[orgId] && retries > 0) {
      await new Promise((r) => setTimeout(r, 1000));
      retries--;
    }

    if (qrCodes[orgId]) {
      return res.status(200).json({ status: "authenticating", qr: qrCodes[orgId] });
    } else {
      return res.status(202).json({ status: "starting", qr: null });
    }
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/session/:org_id/status", async (req, res) => {
  const orgId = req.params.org_id;
  try {
    const status = await getSessionStatus(orgId);
    res.status(200).json({ status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/session/:org_id/logout", async (req, res) => {
  const orgId = req.params.org_id;
  try {
    await logoutSession(orgId);
    res.status(200).json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/message/send", async (req, res) => {
  const { org_id, phone, text, documentUrl, fileName, documentBase64 } = req.body;
  console.log("Received send request:", { org_id, phone, textLen: text?.length, hasDocUrl: !!documentUrl, hasBase64: !!documentBase64, fileName });
  
  if (!org_id || !phone || (!text && !documentUrl && !documentBase64)) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // 1. Verify and deduct quota
    const { data: deductResult, error: deductError } = await supabase.rpc("deduct_whatsapp_quota", {
      p_org_id: org_id
    });

    if (deductError) {
      console.error(`Quota deduction failed for ${org_id}:`, deductError);
      return res.status(403).json({ error: deductError.message || "Failed to deduct quota" });
    }

    // 2. Send message via Baileys
    const result = await sendMessage(org_id, phone, text || "", documentUrl, fileName, documentBase64);
    res.status(200).json({ success: true, result });
  } catch (err: any) {
    console.error(`Send message error for ${org_id}:`, err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`WhatsApp Microservice running on port ${PORT}`);
});
