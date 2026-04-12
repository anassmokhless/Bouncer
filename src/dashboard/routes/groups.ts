import { Router, Request, Response } from "express";
import { query } from "../../shared/db.js";
import { checkNftOwnership } from "../../shared/enjin.js";
import { requireLogin } from "../middleware.js";

const router = Router();
router.use(requireLogin);

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
router.get("/:id", async (req: Request, res: Response) => {
  const user = req.session.user!;
  const groupId = req.params.id;

  const adminCheck = await query(
    `SELECT 1 FROM group_admins ga JOIN users u ON u.id = ga.user_id
     WHERE ga.group_id = $1 AND u.telegram_id = $2`,
    [groupId, user.telegramId],
  );

  if (adminCheck.rows.length === 0) {
    res.redirect("/dashboard");
    return;
  }

  const groupResult = await query(`SELECT * FROM groups WHERE id = $1`, [groupId]);
  if (groupResult.rows.length === 0) {
    res.status(404).send("Group not found");
    return;
  }

  const rules = await query(
    `SELECT * FROM nft_rules WHERE group_id = $1 AND is_active = true ORDER BY created_at`,
    [groupId],
  );

  const members = await query(
    `SELECT m.*, u.telegram_id AS user_telegram_id, u.username, u.first_name, u.wallet_address
     FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 ORDER BY m.created_at DESC`,
    [groupId],
  );

  res.render("group", { user, group: groupResult.rows[0], rules: rules.rows, members: members.rows });
});

// Manual re-check
router.post("/:id/recheck", async (req: Request, res: Response) => {
  const user = req.session.user!;
  const groupId = req.params.id;

  const adminCheck = await query(
    `SELECT 1 FROM group_admins ga JOIN users u ON u.id = ga.user_id
     WHERE ga.group_id = $1 AND u.telegram_id = $2`,
    [groupId, user.telegramId],
  );

  if (adminCheck.rows.length === 0) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rules = await query(
    `SELECT * FROM nft_rules WHERE group_id = $1 AND is_active = true`,
    [groupId],
  );

  const members = await query(
    `SELECT m.id, u.wallet_address, u.id AS user_id
     FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 AND m.status = 'VERIFIED'`,
    [groupId],
  );

  let checked = 0;
  let kicked = 0;

  for (const member of members.rows) {
    if (!member.wallet_address) continue;
    checked++;

    let stillHolds = false;
    for (const rule of rules.rows) {
      if (await checkNftOwnership(member.wallet_address, rule.collection_id, rule.token_id, rule.min_balance)) {
        stillHolds = true;
        break;
      }
    }

    if (!stillHolds) {
      await query(`UPDATE members SET status = 'KICKED', last_checked = now() WHERE id = $1`, [member.id]);
      await query(
        `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
        [groupId, member.user_id, "USER_KICKED_MANUAL", JSON.stringify({ triggeredBy: user.telegramId })],
      );
      kicked++;
    } else {
      await query(`UPDATE members SET last_checked = now() WHERE id = $1`, [member.id]);
    }
  }

  res.json({ checked, kicked });
});

// Add rule
router.post("/:id/rules", async (req: Request, res: Response) => {
  const user = req.session.user!;
  const groupId = req.params.id;

  const adminCheck = await query(
    `SELECT 1 FROM group_admins ga JOIN users u ON u.id = ga.user_id
     WHERE ga.group_id = $1 AND u.telegram_id = $2`,
    [groupId, user.telegramId],
  );

  if (adminCheck.rows.length === 0) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const { collectionId, tokenId, minBalance } = req.body;

  if (!collectionId) {
    res.status(400).json({ error: "Collection ID is required" });
    return;
  }

  await query(
    `INSERT INTO nft_rules (group_id, collection_id, token_id, min_balance) VALUES ($1, $2, $3, $4)`,
    [groupId, collectionId, tokenId || null, parseInt(minBalance) || 1],
  );

  // Audit log
  const adminUser = await query(`SELECT id FROM users WHERE telegram_id = $1`, [user.telegramId]);
  await query(
    `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
    [groupId, adminUser.rows[0].id, "RULE_ADDED", JSON.stringify({ collectionId, tokenId: tokenId || null, minBalance: parseInt(minBalance) || 1 })],
  );

  res.redirect(`/dashboard/${groupId}`);
});

// Delete rule
router.post("/:id/rules/:ruleId/delete", async (req: Request, res: Response) => {
  const user = req.session.user!;
  const { id: groupId, ruleId } = req.params;

  const adminCheck = await query(
    `SELECT 1 FROM group_admins ga JOIN users u ON u.id = ga.user_id
     WHERE ga.group_id = $1 AND u.telegram_id = $2`,
    [groupId, user.telegramId],
  );

  if (adminCheck.rows.length === 0) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await query(
    `UPDATE nft_rules SET is_active = false WHERE id = $1 AND group_id = $2`,
    [ruleId, groupId],
  );

  // Audit log
  const adminUser = await query(`SELECT id FROM users WHERE telegram_id = $1`, [user.telegramId]);
  await query(
    `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
    [groupId, adminUser.rows[0].id, "RULE_REMOVED", JSON.stringify({ ruleId })],
  );

  res.redirect(`/dashboard/${groupId}`);
});

export default router;