// 由 scripts/build-schema.mjs 從 sql/add_pa_tracker.sql 產生,請勿手改。
// 每一步都可重複執行(create if not exists / 欄位已存在就跳過)。

export type SchemaStep = { sql: string } | { addcol: { table: string; column: string; ddl: string } };

export const PA_SCHEMA_STEPS: SchemaStep[] = [
  {
    "sql": "create table if not exists pa_projects (\n  id          text primary key,\n  name        text not null,\n  code        text not null default '',\n  created_by  text not null,\n  archived    integer not null default 0,\n  created_at  text not null,\n  updated_at  text not null\n)"
  },
  {
    "sql": "create table if not exists pa_project_members (\n  project_id  text not null references pa_projects(id) on delete cascade,\n  user_id     text not null,\n  role        text not null,  \n  created_at  text not null,\n  primary key (project_id, user_id, role)\n)"
  },
  {
    "sql": "create index if not exists idx_pa_members_user on pa_project_members(user_id)"
  },
  {
    "sql": "create table if not exists pa_sla_settings (\n  project_id         text primary key references pa_projects(id) on delete cascade,\n  supplier_notified  integer not null default 3,\n  docs_std           integer not null default 7,\n  docs_custom        integer not null default 21,\n  rd_pass            integer not null default 7,\n  qa_pass            integer not null default 7\n)"
  },
  {
    "sql": "create table if not exists pa_parts (\n  id                 text primary key,\n  project_id         text not null references pa_projects(id) on delete cascade,\n  fg_pn              text not null default '',\n  fg_model           text not null default '',\n  fg_desc            text not null default '',\n  main_pn            text not null default '',\n  part_pn            text not null,\n  lifecycle          text not null default '',\n  part_desc          text not null default '',\n  part_type          text not null default '',  \n  supplier           text not null default '',\n  pa_start           text,\n  supplier_notified  text,\n  docs_received      text,\n  rd_review_start    text,\n  qa_review_start    text,\n  rd_pass            text,\n  qa_pass            text,\n  plm_pa_start       text,\n  first_article      text,\n  sourcer_owner      text not null default '',  \n  removed_from_bom   integer not null default 0,  \n  excluded           integer not null default 0,  \n  excluded_note      text not null default '',\n  \n  bom_level          text not null default '',\n  parent_pn          text not null default '',\n  find_num           text not null default '',\n  alt_of_pn          text not null default '',\n  qty                text not null default '',\n  ref_des            text not null default '',\n  sort_order         integer not null default 0,\n  created_at         text not null,\n  updated_at         text not null,\n  unique (project_id, fg_pn, main_pn, part_pn)\n)"
  },
  {
    "sql": "create index if not exists idx_pa_parts_project on pa_parts(project_id)"
  },
  {
    "sql": "create index if not exists idx_pa_parts_owner on pa_parts(sourcer_owner) where sourcer_owner <> ''"
  },
  {
    "sql": "create table if not exists pa_part_notes (\n  id          text primary key,\n  part_id     text not null references pa_parts(id) on delete cascade,\n  date        text not null,\n  text        text not null,\n  created_by  text not null,\n  created_at  text not null\n)"
  },
  {
    "sql": "create index if not exists idx_pa_notes_part on pa_part_notes(part_id, date)"
  },
  {
    "sql": "create table if not exists pa_review_issues (\n  id          text primary key,\n  part_id     text not null references pa_parts(id) on delete cascade,\n  dept        text not null,  \n  date        text not null,\n  note        text not null default '',\n  created_by  text not null,\n  created_at  text not null\n)"
  },
  {
    "sql": "create index if not exists idx_pa_issues_part on pa_review_issues(part_id)"
  },
  {
    "sql": "create table if not exists pa_part_history (\n  id          integer primary key autoincrement,\n  part_id     text not null references pa_parts(id) on delete cascade,\n  user_id     text not null,\n  field       text not null,\n  old_value   text,\n  new_value   text,\n  at          text not null\n)"
  },
  {
    "sql": "create index if not exists idx_pa_history_part on pa_part_history(part_id, at)"
  },
  {
    "sql": "create table if not exists pa_digest_log (\n  day      text not null,\n  user_id  text not null,\n  sent_at  text not null,\n  ok       integer not null,\n  primary key (day, user_id)\n)"
  },
  {
    "addcol": {
      "table": "pa_parts",
      "column": "plm_upload",
      "ddl": "plm_upload text"
    }
  },
  {
    "addcol": {
      "table": "pa_parts",
      "column": "plm_released",
      "ddl": "plm_released text"
    }
  },
  {
    "addcol": {
      "table": "pa_parts",
      "column": "hold_reason",
      "ddl": "hold_reason text not null default ''"
    }
  },
  {
    "sql": "create table if not exists pa_notify_log (\n  part_id  text not null references pa_parts(id) on delete cascade,\n  event    text not null,  \n  sent_at  text not null,\n  primary key (part_id, event)\n)"
  },
  {
    "sql": "create table if not exists pa_api_tokens (\n  id            text primary key,\n  user_id       text not null,\n  name          text not null default '',\n  token_hash    text not null unique,  \n  created_at    text not null,\n  last_used_at  text,\n  revoked       integer not null default 0\n)"
  },
  {
    "sql": "create index if not exists idx_pa_tokens_user on pa_api_tokens(user_id)"
  },
  {
    "addcol": {
      "table": "pa_parts",
      "column": "rd_owner",
      "ddl": "rd_owner text not null default ''"
    }
  },
  {
    "addcol": {
      "table": "pa_parts",
      "column": "sample_received",
      "ddl": "sample_received text"
    }
  },
  {
    "addcol": {
      "table": "pa_parts",
      "column": "supplier_updated",
      "ddl": "supplier_updated text"
    }
  },
  {
    "addcol": {
      "table": "pa_parts",
      "column": "supplier_updated_at",
      "ddl": "supplier_updated_at text"
    }
  },
  {
    "addcol": {
      "table": "pa_parts",
      "column": "drawing_release",
      "ddl": "drawing_release text"
    }
  },
  {
    "sql": "create index if not exists idx_pa_parts_rd_owner on pa_parts(rd_owner) where rd_owner <> ''"
  },
  {
    "addcol": {
      "table": "pa_review_issues",
      "column": "resubmitted",
      "ddl": "resubmitted text"
    }
  },
  {
    "addcol": {
      "table": "pa_sla_settings",
      "column": "supplier_update",
      "ddl": "supplier_update integer not null default 7"
    }
  },
  {
    "sql": "create table if not exists pa_user_prefs (\n  user_id     text not null,\n  key         text not null,\n  value       text not null,\n  updated_at  text not null,\n  primary key (user_id, key)\n)"
  },
  {
    "sql": "create table if not exists pa_global_sla (\n  id                 integer primary key check (id = 1),\n  supplier_notified  integer not null default 3,\n  docs_std           integer not null default 7,\n  docs_custom        integer not null default 21,\n  rd_pass            integer not null default 7,\n  qa_pass            integer not null default 7,\n  supplier_update    integer not null default 7,\n  rereview           integer not null default 3,\n  updated_at         text,\n  updated_by         text\n)"
  },
  {
    "sql": "insert into pa_global_sla (id) values (1) on conflict (id) do nothing"
  },
  {
    "sql": "create table if not exists pa_suppliers (\n  id          text primary key,\n  name        text not null,\n  emails      text not null default '',\n  contact     text not null default '',\n  note        text not null default '',\n  updated_at  text,\n  updated_by  text\n)"
  },
  {
    "sql": "create unique index if not exists pa_suppliers_name_uq on pa_suppliers (lower(name))"
  },
  {
    "addcol": {
      "table": "pa_global_sla",
      "column": "rereview",
      "ddl": "rereview integer not null default 3"
    }
  },
  {
    "sql": "create table if not exists pa_pending_owners (\n  part_id  text not null references pa_parts(id) on delete cascade,\n  field    text not null,\n  email    text not null,\n  primary key (part_id, field)\n)"
  },
  {
    "sql": "create index if not exists pa_pending_owners_email_idx on pa_pending_owners (lower(email))"
  },
  {
    "sql": "create table if not exists pa_supplier_chase_log (\n  day          text not null,\n  supplier_key text not null,\n  to_email     text not null default '',\n  sent_at      text not null,\n  ok           integer not null,\n  primary key (day, supplier_key)\n)"
  },
  {
    "sql": "create table if not exists app_invites (\n  id text primary key, email text not null, name text not null default '',\n  pa_project_id text, pa_roles text not null default '', used_at text,\n  expires_at text not null, created_at text not null\n)"
  }
];
