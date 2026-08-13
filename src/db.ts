import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const db = new Client({
  connectionString: process.env.DATABASE_URL
});

db.connect().catch(e => console.error("DB connection error:", e));

export async function getDefaultOrgId(): Promise<string | null> {
  try {
    const res = await db.query('SELECT id FROM public.organizations LIMIT 1');
    return res.rows[0]?.id || null;
  } catch (e) {
    console.error(e);
    return null;
  }
}

export async function upsertChat(phone: string, text: string, orgId?: string | null): Promise<string | null> {
  if (!orgId) orgId = await getDefaultOrgId();
  if (!orgId) return null;

  try {
    const check = await db.query('SELECT id FROM public.whatsapp_chats WHERE phone_number = $1 AND org_id = $2', [phone, orgId]);
    if (check.rows.length > 0) {
      const chatId = check.rows[0].id;
      await db.query(
        'UPDATE public.whatsapp_chats SET last_message_text = $1, last_message_at = NOW(), updated_at = NOW() WHERE id = $2',
        [text, chatId]
      );
      return chatId;
    } else {
      const res = await db.query(
        'INSERT INTO public.whatsapp_chats (org_id, phone_number, last_message_text, last_message_at) VALUES ($1, $2, $3, NOW()) RETURNING id',
        [orgId, phone, text]
      );
      return res.rows[0].id;
    }
  } catch (e) {
    console.error("Error upserting chat:", e);
    return null;
  }
}

export async function insertMessage(chatId: string, phone: string, direction: 'incoming'|'outgoing', text: string, messageId: string, orgId?: string | null) {
  if (!orgId) orgId = await getDefaultOrgId();
  if (!orgId) return;

  try {
    await db.query(
      'INSERT INTO public.whatsapp_messages (org_id, chat_id, phone_number, direction, message_text, message_id) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING',
      [orgId, chatId, phone, direction, text, messageId]
    );
  } catch (e) {
    console.error("Error inserting message:", e);
  }
}

export async function saveSessionData(sessionId: string, data: any, orgId?: string | null) {
  if (!orgId) orgId = await getDefaultOrgId();
  if (!orgId) return;
  try {
    const check = await db.query('SELECT id FROM public.whatsapp_sessions WHERE session_id = $1 AND org_id = $2', [sessionId, orgId]);
    if (check.rows.length > 0) {
      await db.query('UPDATE public.whatsapp_sessions SET session_data = $1, updated_at = NOW() WHERE session_id = $2 AND org_id = $3', [data, sessionId, orgId]);
    } else {
      await db.query('INSERT INTO public.whatsapp_sessions (org_id, session_id, session_data) VALUES ($1, $2, $3)', [orgId, sessionId, data]);
    }
  } catch (e) {
    console.error("Error saving session:", e);
  }
}

export async function getSessionData(sessionId: string, orgId?: string | null): Promise<any | null> {
  if (!orgId) orgId = await getDefaultOrgId();
  if (!orgId) return null;
  try {
    const res = await db.query('SELECT session_data FROM public.whatsapp_sessions WHERE session_id = $1 AND org_id = $2', [sessionId, orgId]);
    return res.rows[0]?.session_data || null;
  } catch (e) {
    console.error("Error getting session:", e);
    return null;
  }
}

export async function removeSessionData(sessionId: string, orgId?: string | null) {
  if (!orgId) orgId = await getDefaultOrgId();
  if (!orgId) return;
  try {
    await db.query('DELETE FROM public.whatsapp_sessions WHERE session_id = $1 AND org_id = $2', [sessionId, orgId]);
  } catch (e) {
    console.error("Error removing session:", e);
  }
}
