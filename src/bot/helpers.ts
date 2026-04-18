import { Api, GrammyError } from "grammy";
import { query } from "../shared/db.js";
import { hasBouncerPass } from "../shared/enjin.js";

// Full "muted" permission set — no sending, no admin-lite actions.
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

// "Unmuted" — restore the default posting permissions.
const UNMUTE_PERMISSIONS = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_photos: true,
  can_send_voice_notes: true,
  can_send_other_messages: true,
};

// Chats we've confirmed are basic groups (not supergroups). Telegram's
// restrictChatMember only works in supergroups, so after the first 400 we
// remember the chat and silent-skip future mute/unmute attempts. Resets on
// process restart — worst case is one extra warn line per chat per boot.
// Cleared automatically when a chat upgrades (new migrate_to_chat_id means
// a new chatId that isn't in the set).
const basicGroups = new Set<string>();

/** Detect the specific "only for supergroups" 400 so we can silent-skip it. */
function isBasicGroupError(err: unknown): boolean {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    typeof err.description === "string" &&
    err.description.includes("only for supergroups")
  );
}

/**
 * Apply mute permissions to a user. Returns true if Telegram accepted the
 * call, false if the chat is a basic group (silent-skip) or another handled
 * condition. Real errors (permission denied, network, etc.) are logged but
 * still return false so callers can fall back to delete-on-send.
 */
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

/**
 * Remove mute permissions from a user. Same error-handling semantics as
 * safeMute — basic groups are silent-skipped (we don't double-log the
 * "not a supergroup" warning since it was already surfaced on mute).
 */
export async function safeUnmute(
  api: Api,
  chatId: number | string,
  userId: number | string,
): Promise<boolean> {
  const chatKey = chatId.toString();
  if (basicGroups.has(chatKey)) return false;

  try {
    await api.restrictChatMember(Number(chatId), Number(userId), UNMUTE_PERMISSIONS);
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

// Escape characters that have special meaning in Telegram's HTML parse mode.
// Only `<`, `>`, `&` need escaping — the HTML parse mode is far more forgiving
// than Markdown v1, which requires escaping `_`, `*`, `[`, `]`, `(`, `)`, `` ` ``.
// Use this on any user-provided string (first_name, username) injected into a
// message sent with `parse_mode: "HTML"`. Real production incident: a user
// named "Cryptan_19" joined and the `_` broke Markdown parsing mid-message,
// rejecting the entire welcome message with a 400 from Telegram.
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function getOrCreateGroup(telegramId: string, title: string) {
  const result = await query(
    `INSERT INTO groups (telegram_id, title)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET title = $2
     RETURNING *`,
    [telegramId, title],
  );
  return result.rows[0];
}

export async function getOrCreateUser(telegramId: string,username?: string,firstName?: string,) {
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

//check if a user holds the bouncer pass by telegram id
// Inherits the tri-state semantics of hasBouncerPass:
//   true  — user has linked a wallet that holds the pass
//   false — user has no wallet, or wallet definitively lacks the pass
//   null  — couldn't determine right now (Enjin API error). Callers must NOT
//           treat null as false for destructive decisions (leaving groups,
//           refusing commands with no retry path, etc.).
export async function checkBouncerAccess(telegramId: string): Promise<boolean | null> {
  if (!process.env.BOUNCER_COLLECTION_ID) return true; // early access disabled

  const user = await query(
    `SELECT wallet_address FROM users WHERE telegram_id = $1`,
    [telegramId],
  );

  if (!user.rows[0]?.wallet_address) return false; // definitive no — no wallet to check
  return hasBouncerPass(user.rows[0].wallet_address);
}