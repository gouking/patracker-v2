// PA Tracker 自己的帳號(跟 Trackly 的 schema 同一套欄位,方便日後合併或互搬)。
// 每一步都可重複執行。

export const ACCOUNT_SCHEMA = `
create table if not exists users (
  id                text primary key,
  email             text not null unique,
  password_hash     text not null,
  name              text not null default '',
  role              text not null default 'user',
  created_at        text not null,
  updated_at        text not null,
  -- 停用 = 0:每次請求都檢查,停用後立即無法使用任何 API
  is_active         integer not null default 1,
  email_verified_at text
);

-- 每次登入一列;cookie 的 JWT 帶 sid,每次都回來查,所以登出/重設密碼/停用立刻生效
create table if not exists sessions (
  id           text primary key,
  user_id      text not null references users(id) on delete cascade,
  created_at   text not null,
  expires_at   text not null,
  last_seen_at text not null,
  revoked_at   text,
  user_agent   text not null default '',
  ip           text not null default ''
);
create index if not exists sessions_user_idx on sessions (user_id);

-- 重設密碼用的一次性 token(只存雜湊)
create table if not exists one_time_tokens (
  id         text primary key,
  user_id    text not null references users(id) on delete cascade,
  purpose    text not null,
  token_hash text not null,
  created_at text not null,
  expires_at text not null,
  used_at    text
);
create index if not exists one_time_tokens_user_idx on one_time_tokens (user_id, purpose);

-- 登入失敗/重設請求等的紀錄,給速率限制數次數用
create table if not exists auth_attempts (
  id   text primary key,
  kind text not null,
  key  text not null,
  at   text not null
);
create index if not exists auth_attempts_idx on auth_attempts (kind, key, at);
`;

/** 舊資料庫的 app_invites 少了邀請連結要用的欄位:啟動時補上(已存在就跳過)。 */
export const ACCOUNT_ADD_COLS: { table: string; column: string; ddl: string }[] = [
  { table: "app_invites", column: "token_hash", ddl: "token_hash text" },
  { table: "app_invites", column: "invited_by", ddl: "invited_by text not null default ''" },
  { table: "app_invites", column: "invited_by_name", ddl: "invited_by_name text not null default ''" },
];
