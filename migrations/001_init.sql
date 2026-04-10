-- use pgcrypto
CREATE EXTENSION if not exists pgcrypto;

-- member statuses
DO $$ BEGIN
    CREATE TYPE member_status AS ENUM ('PENDING','VERIFIED','KICKED','LEFT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

--trigger function for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- groups table
create table if not exists groups(
    id uuid primary key default gen_random_uuid(),
    telegram_id text unique not null,
    title text not null,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

DROP TRIGGER IF EXISTS set_updated_at_groups ON groups;
CREATE TRIGGER set_updated_at_groups
BEFORE UPDATE ON groups
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

-- users table
create table if not exists users(
    id uuid primary key default gen_random_uuid(),
    telegram_id text unique not null,
    username text,
    first_name text,
    is_verified boolean not null default false,
    verified_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

DROP TRIGGER IF EXISTS set_updated_at_users ON users;
CREATE TRIGGER set_updated_at_users
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

--nft rules table
create table if not exists nft_rules(
    id uuid primary key default gen_random_uuid(),
    group_id uuid not null references groups(id) on delete cascade,
    collection_id text not null,
    token_id text,
    min_balance int not null default 1,
    check_interval_seconds int not null default 3600,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

DROP TRIGGER IF EXISTS set_updated_at_nft_rules ON nft_rules;
CREATE TRIGGER set_updated_at_nft_rules
BEFORE UPDATE ON nft_rules
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

--members table (join table many to many groups <-> users)
create table if not exists members(
    id uuid primary key default gen_random_uuid(),
    group_id uuid not null references groups(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    status member_status not null default 'PENDING',
    last_checked timestamptz,
    created_at  timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(group_id, user_id)
);

DROP TRIGGER IF EXISTS set_updated_at_members ON members;
CREATE TRIGGER set_updated_at_members
BEFORE UPDATE ON members
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();

--group admins table
create table if not exists group_admins(
    id uuid primary key default gen_random_uuid(),
    group_id uuid not null references groups(id) on delete cascade,
    user_id uuid not null references users(id) on delete cascade,
    created_at timestamptz not null default now(),
    unique(group_id, user_id)
);

-- audit logs table
create table if not exists audit_logs(
    id uuid primary key default gen_random_uuid(),
    group_id uuid not null references groups(id) on delete cascade,
    user_id uuid references users(id) on delete set null,
    action text not null,
    details jsonb,
    created_at timestamptz not null default now()
);

--pending verifications table (open qr-codes)
create table if not exists pending_verifications(
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references users(id) on delete cascade,
    verification_id text not null,
    telegram_chat_id text not null,
    expires_at timestamptz not null default now() + interval '5 minutes',
    created_at timestamptz not null default now()
);

--session storage table
create table if not exists session(
    sid varchar not null collate "default",
    sess jsonb not null,
    expire timestamptz not null,
    primary key(sid)
);

-- indexes
create index if not exists idx_session_expire ON session (expire);
create index if not exists idx_members_last_checked ON members (last_checked);
create index if not exists idx_members_status ON members (status);
create index if not exists idx_audit_logs_created_at ON audit_logs (created_at);
create index if not exists idx_nft_rules_group_id ON nft_rules (group_id);
create index if not exists idx_members_user_id ON members(user_id);
create index if not exists idx_pending_verifications_expires ON pending_verifications (expires_at);
create index if not exists idx_members_group_status ON members(group_id, status);
create index if not exists idx_members_user_group ON members(user_id, group_id);
create index if not exists idx_audit_logs_group_created ON audit_logs(group_id, created_at);