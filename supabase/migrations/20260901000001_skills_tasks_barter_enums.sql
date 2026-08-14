-- ============================================================
-- Skills + Tasks under Barter -- foundation enums.
-- ============================================================
-- Skill/Task remain barter CONTRIBUTION kinds, never a new
-- transaction family. The four authoritative transaction families
-- (buy/rent/barter/rent_to_buy) are untouched by this feature.
-- Isolated migration: ADD VALUE cannot be used in the same
-- transaction as its first use, per this project's established rule.
-- ============================================================

create type barter_skill_task_post_status as enum (
  'draft', 'active', 'offers_received', 'matched', 'paused', 'closed', 'archived', 'suspended'
);

create type barter_milestone_status as enum (
  'pending', 'active', 'completed'
);
