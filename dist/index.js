"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const whatsapp_1 = require("./whatsapp");
const supabase_1 = require("./supabase");
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '10mb' }));
const PORT = process.env.PORT || 3001;
// Health check for aaPanel
app.get("/", (req, res) => {
    res.status(200).send("WhatsApp Microservice is running!");
});
app.get("/api/session/:org_id/qr", async (req, res) => {
    const orgId = req.params.org_id;
    try {
        const status = await (0, whatsapp_1.getSessionStatus)(orgId);
        if (status === "connected") {
            return res.status(200).json({ status: "connected", qr: null });
        }
        if (!whatsapp_1.qrCodes[orgId]) {
            await (0, whatsapp_1.startWhatsAppSession)(orgId);
        }
        // Wait a brief moment for QR generation if just started
        let retries = 5;
        while (!whatsapp_1.qrCodes[orgId] && retries > 0) {
            await new Promise((r) => setTimeout(r, 1000));
            retries--;
        }
        if (whatsapp_1.qrCodes[orgId]) {
            return res.status(200).json({ status: "authenticating", qr: whatsapp_1.qrCodes[orgId] });
        }
        else {
            return res.status(202).json({ status: "starting", qr: null });
        }
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});
app.get("/api/session/:org_id/status", async (req, res) => {
    const orgId = req.params.org_id;
    try {
        const status = await (0, whatsapp_1.getSessionStatus)(orgId);
        res.status(200).json({ status });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.post("/api/session/:org_id/logout", async (req, res) => {
    const orgId = req.params.org_id;
    try {
        await (0, whatsapp_1.logoutSession)(orgId);
        res.status(200).json({ success: true });
    }
    catch (err) {
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
        const { data: deductResult, error: deductError } = await supabase_1.supabase.rpc("deduct_whatsapp_quota", {
            p_org_id: org_id
        });
        if (deductError) {
            console.error(`Quota deduction failed for ${org_id}:`, deductError);
            return res.status(403).json({ error: deductError.message || "Failed to deduct quota" });
        }
        // 2. Send message via Baileys
        const result = await (0, whatsapp_1.sendMessage)(org_id, phone, text || "", documentUrl, fileName, documentBase64);
        res.status(200).json({ success: true, result });
    }
    catch (err) {
        console.error(`Send message error for ${org_id}:`, err);
        res.status(500).json({ error: err.message });
    }
});
app.listen(PORT, () => {
    console.log(`WhatsApp Microservice running on port ${PORT}`);
});
