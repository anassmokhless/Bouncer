import { Router, Request, Response } from "express";
import { Api } from "grammy";
import { query } from "../../shared/db.js";
import { checkNftOwnership, collectionExists, tokenExists } from "../../shared/enjin.js";
import { requireLogin, requireGroupAdmin, requireBouncerPass } from "../middleware.js";
import { isUserNotParticipantError, releasePendingMembers } from "../../bot/helpers.js";
import { mutationLimiter, readLimiter } from "../rate-limits.js";

const api = new Api(process.env.BOT_TOKEN!);

const router = Router();
router.use(requireLogin);

// In-memory state for background recheck jobs (keyed by groupId), so the POST
// returns 202 immediately and the client polls a status endpoint. One per group.
type RecheckJob = {
  groupId: string;
  total: number;
  checked: number;
  kicked: number;
  status: "running" | "done" | "error";
  error?: string;
  startedAt: number;
  finishedAt?: number;
};
const rechecksInProgress = new Map<string, RecheckJob>();
const JOB_RETENTION_MS = 5 * 60 * 1000; // keep finished jobs 5 min for late polls

// Drop finished jobs past the retention window.
function pruneRechecksInProgress() {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [key, job] of rechecksInProgress) {
    if (job.status !== "running" && job.finishedAt !== undefined && job.finishedAt < cutoff) {
      rechecksInProgress.delete(key);
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param("id", (req, res, next, value) => {
  if (!UUID_RE.test(value)) {
    res.status(404).send("Not found");
    return;
  }
  next();
});
router.param("ruleId", (req, res, next, value) => {
  if (!UUID_RE.test(value)) {
    res.status(404).send("Not found");
    return;
  }
  next();
});

// Groups list
router.get("/", readLimiter, async (req: Request, res: Response) => {
  const user = req.session.user!;

  const result = await query(
    `SELECT g.*,
       (SELECT COUNT(*) FROM members m WHERE m.group_id = g.id AND m.status = 'VERIFIED') AS verified_count,
       (SELECT COUNT(*) FROM nft_rules r WHERE r.group_id = g.id AND r.is_active = true) AS rule_count
     FROM groups g
     JOIN group_admins ga ON ga.group_id = g.id
     JOIN users u ON u.id = ga.user_id
     WHERE u.telegram_id = $1
     ORDER BY g.created_at DESC`,
    [user.telegramId],
  );

  // ?accessError=... banner from requireBouncerPass.
  const accessError = typeof req.query.accessError === "string" ? req.query.accessError : null;

  res.render("dashboard", { user, groups: result.rows, accessError });
});

// Group detail
router.get("/:id", readLimiter, requireGroupAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const groupId = req.params.id as string;

  const groupResult = await query(`SELECT * FROM groups WHERE id = $1`, [groupId]);
  if (groupResult.rows.length === 0) {
    res.status(404).send("Group not found");
    return;
  }

  const rules = await query(
    `SELECT * FROM nft_rules WHERE group_id = $1 AND is_active = true ORDER BY created_at`,
    [groupId],
  );

  const statsResult = await query(
    `SELECT status, COUNT(*)::int AS count FROM members WHERE group_id = $1 GROUP BY status`,
    [groupId],
  );
  const stats: Record<string, number> = {};
  for (const row of statsResult.rows) stats[row.status] = row.count;

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = 25;
  const search = ((req.query.search as string) || "").trim();
  const offset = (page - 1) * pageSize;

  const countParams: string[] = [groupId];
  let countWhere = `WHERE m.group_id = $1`;
  if (search) {
    countParams.push(`%${search}%`);
    // ILIKE on a NULL wallet_address is NULL (falsy), so no coalesce needed.
    countWhere += ` AND (u.username ILIKE $2 OR u.first_name ILIKE $2 OR u.wallet_address ILIKE $2)`;
  }

  const totalResult = await query(
    `SELECT COUNT(*) FROM members m JOIN users u ON u.id = m.user_id ${countWhere}`,
    countParams,
  );
  const totalMembers = parseInt(totalResult.rows[0].count);
  const totalPages = Math.max(1, Math.ceil(totalMembers / pageSize));

  const memberParams: (string | number)[] = search
    ? [groupId, `%${search}%`, pageSize, offset]
    : [groupId, pageSize, offset];
  const memberWhere = search
    ? `WHERE m.group_id = $1 AND (u.username ILIKE $2 OR u.first_name ILIKE $2 OR u.wallet_address ILIKE $2)`
    : `WHERE m.group_id = $1`;
  const memberLimit = search ? `LIMIT $3 OFFSET $4` : `LIMIT $2 OFFSET $3`;

  // Whitelisted ORDER BY — never interpolate the sort param into SQL directly.
  // Status sorts by a custom order (PENDING first); created_at DESC is the
  // tie-breaker for stable pagination; wallet/last_checked use NULLS LAST.
  const SORT_OPTIONS: Record<string, string> = {
    "user-asc": "COALESCE(u.first_name, u.username, '') ASC, m.created_at DESC",
    "user-desc": "COALESCE(u.first_name, u.username, '') DESC, m.created_at DESC",
    "wallet-asc": "u.wallet_address ASC NULLS LAST, m.created_at DESC",
    "wallet-desc": "u.wallet_address DESC NULLS LAST, m.created_at DESC",
    "status-asc": "CASE m.status WHEN 'PENDING' THEN 1 WHEN 'VERIFIED' THEN 2 WHEN 'KICKED' THEN 3 WHEN 'LEFT' THEN 4 ELSE 5 END ASC, m.created_at DESC",
    "status-desc": "CASE m.status WHEN 'PENDING' THEN 1 WHEN 'VERIFIED' THEN 2 WHEN 'KICKED' THEN 3 WHEN 'LEFT' THEN 4 ELSE 5 END DESC, m.created_at DESC",
    "checked-asc": "m.last_checked ASC NULLS LAST, m.created_at DESC",
    "checked-desc": "m.last_checked DESC NULLS LAST, m.created_at DESC",
    "joined-asc": "m.created_at ASC",
    "joined-desc": "m.created_at DESC",
  };
  const sortKey = typeof req.query.sort === "string" ? req.query.sort : "joined-desc";
  const orderBy = SORT_OPTIONS[sortKey] ?? SORT_OPTIONS["joined-desc"];

  const members = await query(
    `SELECT m.*, u.telegram_id AS user_telegram_id, u.username, u.first_name, u.wallet_address
     FROM members m JOIN users u ON u.id = m.user_id
     ${memberWhere} ORDER BY ${orderBy} ${memberLimit}`,
    memberParams,
  );

  // ?ruleError=... banner from a failed /rules POST.
  const ruleError = typeof req.query.ruleError === "string" ? req.query.ruleError : null;
  const accessError = typeof req.query.accessError === "string" ? req.query.accessError : null;

  // Fall back to 'joined-desc' for an unknown sort key.
  const validatedSort = SORT_OPTIONS[sortKey] ? sortKey : "joined-desc";

  res.render("group", {
    user, group: groupResult.rows[0], rules: rules.rows, members: members.rows,
    page, totalPages, totalMembers, search, stats, ruleError, accessError,
    sort: validatedSort,
  });
});

// Manual re-check, backgrounded: return 202 and run the loop async (it can take
// minutes on large groups). One running job per group — a second click gets 409.
router.post("/:id/recheck", mutationLimiter, requireGroupAdmin, requireBouncerPass, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const groupId = req.params.id as string;

  pruneRechecksInProgress();

  const existing = rechecksInProgress.get(groupId);
  if (existing && existing.status === "running") {
    res.status(409).json({ error: "A re-check is already running for this group.", status: existing });
    return;
  }

  // Claim the slot synchronously, before the first await — otherwise a
  // double-click races past the 409 guard and starts two ban loops. Every early
  // exit past here must release the slot (a leaked "running" job 409s till restart).
  const job: RecheckJob = {
    groupId,
    total: 0,
    checked: 0,
    kicked: 0,
    status: "running",
    startedAt: Date.now(),
  };
  rechecksInProgress.set(groupId, job);

  let groupTelegramId!: string;
  let rules!: Awaited<ReturnType<typeof query>>;
  let walleted!: Array<{ id: string; wallet_address: string; user_id: string; user_telegram_id: string }>;
  try {
    const groupResult = await query(`SELECT telegram_id FROM groups WHERE id = $1`, [groupId]);
    if (groupResult.rows.length === 0) {
      rechecksInProgress.delete(groupId);
      res.status(404).json({ error: "Group not found" });
      return;
    }
    groupTelegramId = groupResult.rows[0].telegram_id;

    rules = await query(
      `SELECT * FROM nft_rules WHERE group_id = $1 AND is_active = true`,
      [groupId],
    );

    // With no active rules the loop below never sets stillHolds, so every member
    // would fall into the kick branch — reject instead. (The UI disables the
    // button too; this is the backstop for direct POSTs.)
    if (rules.rows.length === 0) {
      rechecksInProgress.delete(groupId);
      res.status(400).json({ error: "This group has no active rules — nothing to re-check." });
      return;
    }

    const members = await query(
      `SELECT m.id, u.wallet_address, u.id AS user_id, u.telegram_id AS user_telegram_id
       FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.group_id = $1 AND m.status = 'VERIFIED'`,
      [groupId],
    );
    walleted = members.rows.filter((m: { wallet_address: string | null }) => m.wallet_address);
  } catch (err) {
    rechecksInProgress.delete(groupId); // release the claimed slot on any query error
    throw err;
  }

  const BATCH_SIZE = 5;
  job.total = walleted.length;

  // Capture what the background task needs — req/res aren't valid outside the handler.
  const triggeredBy = user.telegramId;

  // Fire-and-forget; errors land in the job record for the status endpoint.
  (async () => {
    try {
      for (let i = 0; i < walleted.length; i += BATCH_SIZE) {
        const batch = walleted.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (member: { id: string; wallet_address: string; user_id: string; user_telegram_id: string }) => {
          job.checked++;

          let stillHolds = false;
          let apiError = false;
          for (const rule of rules.rows) {
            const result = await checkNftOwnership(member.wallet_address, rule.collection_id, rule.token_id, rule.min_balance);
            if (result === null) {
              apiError = true;
              break;
            }
            if (result) {
              stillHolds = true;
              break;
            }
          }

          if (apiError) return;

          if (!stillHolds) {
            let kickSuccess = false;
            try {
              await api.banChatMember(parseInt(groupTelegramId), parseInt(member.user_telegram_id), {
                until_date: Math.floor(Date.now() / 1000) + 40,
              });
              kickSuccess = true;
            } catch (err) {
              if (isUserNotParticipantError(err)) {
                // Already left — reconcile to LEFT (guarded), no kick audit.
                await query(`UPDATE members SET status = 'LEFT' WHERE id = $1 AND status = 'VERIFIED'`, [member.id]);
                console.log(`[DASHBOARD] ${member.user_telegram_id} already left — marked LEFT, skipping kick`);
                return;
              }
              console.error(`[DASHBOARD] Failed to kick ${member.user_telegram_id}:`, err);
            }

            if (kickSuccess) {
              await query(`UPDATE members SET status = 'KICKED', last_checked = now() WHERE id = $1 AND status = 'VERIFIED'`, [member.id]);
              await query(
                `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
                [groupId, member.user_id, "USER_KICKED_MANUAL", JSON.stringify({ triggeredBy })],
              );
              job.kicked++;
            }
          } else {
            await query(`UPDATE members SET last_checked = now() WHERE id = $1 AND status = 'VERIFIED'`, [member.id]);
          }
        }));
      }

      job.status = "done";
      job.finishedAt = Date.now();
    } catch (err) {
      console.error(`[DASHBOARD] Recheck job for group ${groupId} failed:`, err);
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
    }
  })();

  res.status(202).json({ status: "started", total: job.total });
});

// Recheck status — polled by the client to track background job progress.
router.get("/:id/recheck/status", requireGroupAdmin, async (req: Request, res: Response) => {
  const groupId = req.params.id as string;

  pruneRechecksInProgress();

  const job = rechecksInProgress.get(groupId);
  if (!job) {
    res.json({ status: "idle" });
    return;
  }

  res.json({
    status: job.status,
    total: job.total,
    checked: job.checked,
    kicked: job.kicked,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  });
});

// Add rule
router.post("/:id/rules", mutationLimiter, requireGroupAdmin, requireBouncerPass, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const groupId = req.params.id as string;

  const { collectionId, tokenId, minBalance, checkInterval } = req.body;

  // Redirect back with ?ruleError=... for the view's banner.
  const redirectWithError = (msg: string) => {
    res.redirect(`/dashboard/${groupId}?ruleError=${encodeURIComponent(msg)}`);
  };

  if (!collectionId) {
    redirectWithError("Collection ID is required.");
    return;
  }

  // Collection/token IDs are numeric.
  if (!/^\d+$/.test(collectionId)) {
    redirectWithError("Collection ID must be numeric.");
    return;
  }
  if (tokenId && !/^\d+$/.test(tokenId)) {
    redirectWithError("Token ID must be numeric.");
    return;
  }

  // Confirm the collection (and token) exist on Enjin — catches typo'd IDs.
  const collectionOk = await collectionExists(collectionId);
  if (collectionOk === false) {
    redirectWithError(`Collection ${collectionId} was not found on the Enjin blockchain. Double-check the ID.`);
    return;
  }
  if (collectionOk === null) {
    redirectWithError("Couldn't validate the collection right now. Please try again in a moment.");
    return;
  }
  if (tokenId) {
    const tokenOk = await tokenExists(collectionId, tokenId);
    if (tokenOk === false) {
      redirectWithError(`Token ${tokenId} was not found in collection ${collectionId}. Double-check the ID.`);
      return;
    }
    if (tokenOk === null) {
      redirectWithError("Couldn't validate the token right now. Please try again in a moment.");
      return;
    }
  }

  const intervalHours = Math.min(Math.max(parseInt(checkInterval) || 1, 1), 720);
  const intervalSeconds = intervalHours * 3600;

  // Strict positive integer, capped at int4 max (the form's min="1" is
  // client-side only). Reject rather than let parseInt coerce a wrong threshold.
  let minBalanceValue = 1;
  const minBalanceRaw = String(minBalance ?? "").trim();
  if (minBalanceRaw !== "") {
    const parsed = /^\d+$/.test(minBalanceRaw) ? parseInt(minBalanceRaw) : NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2147483647) {
      redirectWithError("Min balance must be a whole number of at least 1.");
      return;
    }
    minBalanceValue = parsed;
  }

  await query(
    `INSERT INTO nft_rules (group_id, collection_id, token_id, min_balance, check_interval_seconds) VALUES ($1, $2, $3, $4, $5)`,
    [groupId, collectionId, tokenId || null, minBalanceValue, intervalSeconds],
  );

  // Audit log
  await query(
    `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
    [groupId, user.id, "RULE_ADDED", JSON.stringify({ collectionId, tokenId: tokenId || null, minBalance: minBalanceValue, checkIntervalHours: intervalHours })],
  );

  res.redirect(`/dashboard/${groupId}`);
});

// Delete rule
router.post("/:id/rules/:ruleId/delete", mutationLimiter, requireGroupAdmin, requireBouncerPass, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const { id: groupId, ruleId } = req.params;

  await query(
    `UPDATE nft_rules SET is_active = false WHERE id = $1 AND group_id = $2`,
    [ruleId, groupId],
  );

  // Audit log
  await query(
    `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
    [groupId, user.id, "RULE_REMOVED", JSON.stringify({ ruleId })],
  );

  // Release stuck PENDING members if that was the last rule (no-op otherwise).
  // No cache callback — that cache lives in the bot process, not here.
  const groupRow = await query(`SELECT telegram_id FROM groups WHERE id = $1`, [groupId]);
  if (groupRow.rows.length > 0) {
    await releasePendingMembers(api, groupRow.rows[0].telegram_id);
  }

  res.redirect(`/dashboard/${groupId}`);
});

export default router;