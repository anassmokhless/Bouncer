import { Router, Request, Response } from "express";
import { Api } from "grammy";
import { query } from "../../shared/db.js";
import { checkNftOwnership } from "../../shared/enjin.js";
import { requireLogin, requireGroupAdmin } from "../middleware.js";

const api = new Api(process.env.BOT_TOKEN!);

const router = Router();
router.use(requireLogin);

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
router.get("/", async (req: Request, res: Response) => {
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

  res.render("dashboard", { user, groups: result.rows });
});

// Group detail
router.get("/:id", requireGroupAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const groupId = req.params.id;

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

  const countParams: (string | string)[] = [groupId];
  let countWhere = `WHERE m.group_id = $1`;
  if (search) {
    countParams.push(`%${search}%`);
    countWhere += ` AND (u.username ILIKE $2 OR u.first_name ILIKE $2)`;
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
    ? `WHERE m.group_id = $1 AND (u.username ILIKE $2 OR u.first_name ILIKE $2)`
    : `WHERE m.group_id = $1`;
  const memberLimit = search ? `LIMIT $3 OFFSET $4` : `LIMIT $2 OFFSET $3`;

  const members = await query(
    `SELECT m.*, u.telegram_id AS user_telegram_id, u.username, u.first_name, u.wallet_address
     FROM members m JOIN users u ON u.id = m.user_id
     ${memberWhere} ORDER BY m.created_at DESC ${memberLimit}`,
    memberParams,
  );

  res.render("group", {
    user, group: groupResult.rows[0], rules: rules.rows, members: members.rows,
    page, totalPages, totalMembers, search, stats,
  });
});

// Manual re-check
router.post("/:id/recheck", requireGroupAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const groupId = req.params.id;

  const groupResult = await query(`SELECT telegram_id FROM groups WHERE id = $1`, [groupId]);
  if (groupResult.rows.length === 0) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const groupTelegramId = groupResult.rows[0].telegram_id;

  const rules = await query(
    `SELECT * FROM nft_rules WHERE group_id = $1 AND is_active = true`,
    [groupId],
  );

  const members = await query(
    `SELECT m.id, u.wallet_address, u.id AS user_id, u.telegram_id AS user_telegram_id
     FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 AND m.status = 'VERIFIED'`,
    [groupId],
  );

  let checked = 0;
  let kicked = 0;

  const BATCH_SIZE = 5;
  const walleted = members.rows.filter((m: { wallet_address: string | null }) => m.wallet_address);

  for (let i = 0; i < walleted.length; i += BATCH_SIZE) {
    const batch = walleted.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(batch.map(async (member: { id: string; wallet_address: string; user_id: string; user_telegram_id: string }) => {
      checked++;

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
          console.error(`[DASHBOARD] Failed to kick ${member.user_telegram_id}:`, err);
        }

        if (kickSuccess) {
          await query(`UPDATE members SET status = 'KICKED', last_checked = now() WHERE id = $1 AND status = 'VERIFIED'`, [member.id]);
          await query(
            `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
            [groupId, member.user_id, "USER_KICKED_MANUAL", JSON.stringify({ triggeredBy: user.telegramId })],
          );
          kicked++;
        }
      } else {
        await query(`UPDATE members SET last_checked = now() WHERE id = $1 AND status = 'VERIFIED'`, [member.id]);
      }
    }));
  }

  res.json({ checked, kicked });
});

// Add rule
router.post("/:id/rules", requireGroupAdmin, async (req: Request, res: Response) => {
  const user = req.session.user!;
  const groupId = req.params.id;

  const { collectionId, tokenId, minBalance, checkInterval } = req.body;

  if (!collectionId) {
    res.status(400).json({ error: "Collection ID is required" });
    return;
  }

  const intervalHours = parseInt(checkInterval) || 1;
  const intervalSeconds = Math.max(intervalHours, 1) * 3600;

  await query(
    `INSERT INTO nft_rules (group_id, collection_id, token_id, min_balance, check_interval_seconds) VALUES ($1, $2, $3, $4, $5)`,
    [groupId, collectionId, tokenId || null, parseInt(minBalance) || 1, intervalSeconds],
  );

  // Audit log
  await query(
    `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
    [groupId, user.id, "RULE_ADDED", JSON.stringify({ collectionId, tokenId: tokenId || null, minBalance: parseInt(minBalance) || 1, checkIntervalHours: intervalHours })],
  );

  res.redirect(`/dashboard/${groupId}`);
});

// Delete rule
router.post("/:id/rules/:ruleId/delete", requireGroupAdmin, async (req: Request, res: Response) => {
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

  res.redirect(`/dashboard/${groupId}`);
});

export default router;