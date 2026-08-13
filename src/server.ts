import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import qrcode from 'qrcode';
import { connectToWhatsApp, getSocket, getStatus } from './baileys';
import { upsertChat, insertMessage } from './db';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Start WhatsApp on boot
connectToWhatsApp();

app.get('/api/status', (req, res) => {
    res.json(getStatus());
});

app.get('/api/qr', async (req, res) => {
    const status = getStatus();
    if (status.status === 'open') {
        return res.json({ status: 'connected' });
    }
    if (status.qr) {
        try {
            const dataUrl = await qrcode.toDataURL(status.qr);
            return res.json({ status: 'qr', qr: dataUrl, raw: status.qr });
        } catch (e) {
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

    const sock = getSocket();
    const status = getStatus();

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
        const chatId = await upsertChat(cleanPhone, text, org_id);
        if (chatId) {
            await insertMessage(chatId, cleanPhone, 'outgoing', text, msgId, org_id);
        }

        return res.json({ success: true, messageId: msgId });
    } catch (e: any) {
        console.error("Error sending message:", e);
        return res.status(500).json({ error: e.message || 'Failed to send message' });
    }
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
    console.log(`WhatsApp Service running on port ${PORT}`);
});
