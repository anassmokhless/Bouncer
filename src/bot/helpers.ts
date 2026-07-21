import { Api, API_CONSTANTS, GrammyError } from "grammy";
import { query } from "../shared/db.js";
import { hasBouncerPass } from "../shared/enjin.js";

// Telegram's service account for anonymous admins. Only genuine admins get
// substituted with it, so it doubles as admin proof where sender_chat is absent.
export const GROUP_ANONYMOUS_BOT_ID = 1087968824;

// Everything off: full mute.
const MUTE_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};

// Basic groups (not supergroups) where restrictChatMember returns 400. Cached
// so we skip further mute/unmute attempts; resets on restart.
const basicGroups = new Set<string>();

// Telegram's "only for supergroups" 400.
function isBasicGroupError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    typeof err.description === "string" &&
    err.description.includes("only for supergroups")
  );
}

// Telegram's 400 for a user who has already left the chat.
export function isUserNotParticipantError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    typeof err.description === "string" &&
    err.description.includes("USER_NOT_PARTICIPANT")
  );
}

// Mute a user. Returns false (never throws) on basic groups or any error, so
// callers can fall back to delete-on-send.
export async function safeMute(
  api: Api,
  chatId: number | string,
  userId: number | string,
): Promise<boolean> {
  const chatKey = chatId.toString();
  if (basicGroups.has(chatKey)) return false;

  try {
    await api.restrictChatMember(Number(chatId), Number(userId), MUTE_PERMISSIONS);
    return true;
  } catch (err) {
    if (isBasicGroupError(err)) {
      basicGroups.add(chatKey);
      console.warn(
        `[BOT] Cannot mute in basic group ${chatKey} — not a supergroup. ` +
          `Falling back to delete-on-send.`,
      );
      return false;
    }
    console.error("[BOT] Failed to mute member:", err);
    return false;
  }
}

// Unmute a user. Same false-on-error contract as safeMute.
export async function safeUnmute(
  api: Api,
  chatId: number | string,
  userId: number | string,
): Promise<boolean> {
  const chatKey = chatId.toString();
  if (basicGroups.has(chatKey)) return false;

  try {
    // All-true is the API's "lift restrictions" call: the member drops back to
    // plain-member and follows the group's live defaults. Don't replay
    // chat.permissions — a false field there would pin them muted forever.
    await api.restrictChatMember(Number(chatId), Number(userId), API_CONSTANTS.ALL_CHAT_PERMISSIONS);
    return true;
  } catch (err) {
    if (isBasicGroupError(err)) {
      basicGroups.add(chatKey);
      return false;
    }
    console.error("[BOT] Failed to unmute member:", err);
    return false;
  }
}

// Flip every PENDING member of a now rule-less group back to VERIFIED and unmute.
// No-op while any rule is still active. onReleased fires per released member.
export async function releasePendingMembers(
  api: Api,
  groupTelegramId: string,
  onReleased?: (groupTelegramId: string, userTelegramId: string) => void,
): Promise<number> {
  const released = await query(
    `UPDATE members m SET status = 'VERIFIED', verification_deadline = NULL
     FROM groups g, users u
     WHERE g.id = m.group_id AND u.id = m.user_id
       AND g.telegram_id = $1 AND m.status = 'PENDING'
       AND NOT EXISTS (SELECT 1 FROM nft_rules r WHERE r.group_id = m.group_id AND r.is_active = true)
     RETURNING u.telegram_id AS user_telegram_id`,
    [groupTelegramId],
  );

  for (const row of released.rows) {
    await safeUnmute(api, groupTelegramId, row.user_telegram_id);
    onReleased?.(groupTelegramId, row.user_telegram_id);
  }
  if (released.rows.length > 0) {
    console.log(`[BOT] Released ${released.rows.length} pending member(s) in now rule-less group ${groupTelegramId}`);
  }
  return released.rows.length;
}

// Escape <, >, & for messages sent with parse_mode: "HTML". Use on any user
// string (first_name, username).
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function getOrCreateGroup(telegramId: string, title: string) {
  const result = await query(
    `INSERT INTO groups (telegram_id, title)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET title = $2, is_active = true
     RETURNING *`,
    [telegramId, title],
  );
  return result.rows[0];
}

export async function getOrCreateUser(telegramId: string, username?: string, firstName?: string) {
  const result = await query(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = COALESCE($2, users.username),
       first_name = COALESCE($3, users.first_name)
     RETURNING *`,
    [telegramId, username || null, firstName || null],
  );
  return result.rows[0];
}

// Tri-state (from hasBouncerPass): true = holds the pass, false = no wallet or
// lacks it, null = Enjin API error. Callers must not treat null as false for
// destructive decisions (leaving groups, refusing commands).
export async function checkBouncerAccess(telegramId: string): Promise<boolean | null> {
  if (!process.env.BOUNCER_COLLECTION_ID) return true; // early access disabled

  const user = await query(
    `SELECT wallet_address FROM users WHERE telegram_id = $1`,
    [telegramId],
  );

  if (!user.rows[0]?.wallet_address) return false; // definitive no — no wallet to check
  return hasBouncerPass(user.rows[0].wallet_address);
}