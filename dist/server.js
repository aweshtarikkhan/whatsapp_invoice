"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const qrcode_1 = __importDefault(require("qrcode"));
const baileys_1 = require("./baileys");
const db_1 = require("./db");
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '10mb' }));
// Start WhatsApp on boot
(0, baileys_1.connectToWhatsApp)();
app.get('/api/status', (req, res) => {
    res.json((0, baileys_1.getStatus)());
});
app.get('/api/qr', async (req, res) => {
    const status = (0, baileys_1.getStatus)();
    if (status.status === 'open') {
        return res.json({ status: 'connected' });
    }
    if (status.qr) {
        try {
            const dataUrl = await qrcode_1.default.toDataURL(status.qr);
            return res.json({ status: 'qr', qr: dataUrl, raw: status.qr });
        }
        catch (e) {
            return res.status(500).json({ error: 'Failed to generate QR' });
        }
    }
    res.json({ status: status.status });
});
app.post('/api/message/send', async (req, res) => {
    const { phone, text, org_id } = req.body;
    if (!phone || !text) {
        return res.status(400).json({ error: 'Phone and text are required' });
    }
    const sock = (0, baileys_1.getSocket)();
    const status = (0, baileys_1.getStatus)();
    if (!sock || status.status !== 'open') {
        return res.status(503).json({ error: 'WhatsApp is not connected' });
    }
    const cleanPhone = phone.replace(/\D/g, '');
    const jid = `${cleanPhone}@s.whatsapp.net`;
    try {
        const [result] = await sock.onWhatsApp(jid);
        if (!result?.exists) {
            return res.status(400).json({ error: 'Phone number not registered on WhatsApp' });
        }
        const sentMsg = await sock.sendMessage(jid, { text });
        // Save to DB
        const msgId = sentMsg?.key.id || '';
        const chatId = await (0, db_1.upsertChat)(cleanPhone, text, org_id);
        if (chatId) {
            await (0, db_1.insertMessage)(chatId, cleanPhone, 'outgoing', text, msgId, org_id);
        }
        return res.json({ success: true, messageId: msgId });
    }
    catch (e) {
        console.error("Error sending message:", e);
        return res.status(500).json({ error: e.message || 'Failed to send message' });
    }
});
const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
    console.log(`WhatsApp Service running on port ${PORT}`);
});
