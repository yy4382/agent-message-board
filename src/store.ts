import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const identifier = (prefix: string) =>
  `${prefix}_${randomBytes(16).toString("hex")}`;
export const secret = () => randomBytes(32).toString("base64url");
export const now = () => new Date().toISOString();
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: object,
  ) {
    super(message);
  }
}
export type Row = Record<string, any>;
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;",
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);`,
    );
    const version = Number(
      this.get(
        "SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations",
      )!.version,
    );
    if (version > 1)
      throw new Error("Database schema newer than this service.");
    if (version < 1)
      this.transaction(() =>
        this.db.exec(`
      CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,head_seq INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE members(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id),display_name TEXT NOT NULL,platform_label TEXT NOT NULL,token_digest TEXT NOT NULL UNIQUE,revoked_at TEXT,read_seq INTEGER NOT NULL DEFAULT 0,context_initialized_at TEXT,last_request_at TEXT,created_at TEXT NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY,channel_id TEXT NOT NULL REFERENCES channels(id),seq INTEGER NOT NULL,author_member_id TEXT NOT NULL REFERENCES members(id),body TEXT NOT NULL,reply_to_message_id TEXT REFERENCES messages(id),based_on_seq INTEGER NOT NULL,override INTEGER NOT NULL,override_reason TEXT,head_seq_at_commit INTEGER NOT NULL,stale_at_commit INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(channel_id,seq));
      CREATE TABLE message_mentions(message_id TEXT NOT NULL REFERENCES messages(id),member_id TEXT NOT NULL REFERENCES members(id),PRIMARY KEY(message_id,member_id));
      CREATE TABLE idempotency_records(member_id TEXT NOT NULL REFERENCES members(id),key TEXT NOT NULL,payload_digest TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES messages(id),created_at TEXT NOT NULL,PRIMARY KEY(member_id,key));
      CREATE TABLE admin_sessions(token_digest TEXT PRIMARY KEY,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE INDEX members_channel ON members(channel_id,created_at,id);
      CREATE INDEX channels_created ON channels(created_at,id);
      INSERT INTO schema_migrations VALUES(1);
    `),
      );
    this.run("DELETE FROM admin_sessions");
  }
  get(sql: string, ...args: any[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }
  all(sql: string, ...args: any[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  snapshot<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  channel(id: string): Row {
    const row = this.get("SELECT * FROM channels WHERE id=?", id);
    if (!row)
      throw new ApiError(404, "channel_not_found", "Channel not found.");
    return row;
  }
  member(token: string, channelId: string, touch = false): Row {
    const row = this.get(
      "SELECT * FROM members WHERE token_digest=? AND revoked_at IS NULL",
      digest(token),
    );
    if (!row) throw new ApiError(401, "invalid_token", "Invalid member token.");
    if (row.channel_id !== channelId)
      throw new ApiError(404, "channel_not_found", "Channel not found.");
    this.channel(channelId);
    if (touch)
      this.run(
        "UPDATE members SET last_request_at=? WHERE id=?",
        now(),
        row.id,
      );
    return row;
  }
  publicMember(row: Row, admin = false) {
    const {
      id,
      channel_id,
      display_name,
      platform_label,
      created_at,
      revoked_at,
    } = row;
    return {
      id,
      channel_id,
      display_name,
      platform_label,
      created_at,
      revoked_at,
      ...(admin
        ? {
            read_seq: row.read_seq,
            context_initialized: !!row.context_initialized_at,
            last_request_at: row.last_request_at,
          }
        : {}),
    };
  }
  message(row: Row) {
    return {
      ...row,
      override: !!row.override,
      stale_at_commit: !!row.stale_at_commit,
      mention_member_ids: this.all(
        "SELECT member_id FROM message_mentions WHERE message_id=? ORDER BY member_id",
        row.id,
      ).map((r) => r.member_id),
    };
  }
}
