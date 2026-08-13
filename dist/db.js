"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDefaultOrgId = getDefaultOrgId;
exports.upsertChat = upsertChat;
exports.insertMessage = insertMessage;
exports.saveSessionData = saveSessionData;
exports.getSessionData = getSessionData;
exports.removeSessionData = removeSessionData;
const pg_1 = require("pg");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const db = new pg_1.Client({
    connectionString: process.env.DATABASE_URL
});
db.connect().catch(e => console.error("DB connection error:", e));
async function getDefaultOrgId() {
    try {
        const res = await db.query('SELECT id FROM public.organizations LIMIT 1');
        return res.rows[0]?.id || null;
    }
    catch (e) {
        console.error(e);
        return null;
    }
}
async function upsertChat(phone, text, orgId) {
    if (!orgId)
        orgId = await getDefaultOrgId();
    if (!orgId)
        return null;
    try {
        const check = await db.query('SELECT id FROM public.whatsapp_chats WHERE phone_number = $1 AND org_id = $2', [phone, orgId]);
        if (check.rows.length > 0) {
            const chatId = check.rows[0].id;
            await db.query('UPDATE public.whatsapp_chats SET last_message_text = $1, last_message_at = NOW(), updated_at = NOW() WHERE id = $2', [text, chatId]);
            return chatId;
        }
        else {
            const res = await db.query('INSERT INTO public.whatsapp_chats (org_id, phone_number, last_message_text, last_message_at) VALUES ($1, $2, $3, NOW()) RETURNING id', [orgId, phone, text]);
            return res.rows[0].id;
        }
    }
    catch (e) {
        console.error("Error upserting chat:", e);
        return null;
    }
}
async function insertMessage(chatId, phone, direction, text, messageId, orgId) {
    if (!orgId)
        orgId = await getDefaultOrgId();
    if (!orgId)
        return;
    try {
        await db.query('INSERT INTO public.whatsapp_messages (org_id, chat_id, phone_number, direction, message_text, message_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING', [orgId, chatId, phone, direction, text, messageId]);
    }
    catch (e) {
        console.error("Error inserting message:", e);
    }
}
async function saveSessionData(sessionId, data, orgId) {
    if (!orgId)
        orgId = await getDefaultOrgId();
    if (!orgId)
        return;
    try {
        const check = await db.query('SELECT id FROM public.whatsapp_sessions WHERE session_id = $1 AND org_id = $2', [sessionId, orgId]);
        if (check.rows.length > 0) {
            await db.query('UPDATE public.whatsapp_sessions SET session_data = $1, updated_at = NOW() WHERE session_id = $2 AND org_id = $3', [data, sessionId, orgId]);
        }
        else {
            await db.query('INSERT INTO public.whatsapp_sessions (org_id, session_id, session_data) VALUES ($1, $2, $3)', [orgId, sessionId, data]);
        }
    }
    catch (e) {
        console.error("Error saving session:", e);
    }
}
async function getSessionData(sessionId, orgId) {
    if (!orgId)
        orgId = await getDefaultOrgId();
    if (!orgId)
        return null;
    try {
        const res = await db.query('SELECT session_data FROM public.whatsapp_sessions WHERE session_id = $1 AND org_id = $2', [sessionId, orgId]);
        return res.rows[0]?.session_data || null;
    }
    catch (e) {
        console.error("Error getting session:", e);
        return null;
    }
}
async function removeSessionData(sessionId, orgId) {
    if (!orgId)
        orgId = await getDefaultOrgId();
    if (!orgId)
        return;
    try {
        await db.query('DELETE FROM public.whatsapp_sessions WHERE session_id = $1 AND org_id = $2', [sessionId, orgId]);
    }
    catch (e) {
        console.error("Error removing session:", e);
    }
}
