import Fastify, { type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Config, validateConfig } from "./config.js";
import {
  ApiError,
  Store,
  digest,
  identifier,
  now,
  secret,
  type Row,
} from "./store.js";
const fail = (field: string, message = `Invalid ${field}.`): never => {
  throw new ApiError(422, "validation_error", message, { field });
};
function object(value: unknown, allowed: string[]): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("body");
  for (const key of Object.keys(value as object))
    if (!allowed.includes(key)) fail(key, "Unknown request field.");
  return value as Row;
}
function integer(
  value: unknown,
  field: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    fail(field);
  return value as number;
}
function queryInt(
  value: unknown,
  field: string,
  fallback?: number,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) fail(field);
  return integer(Number(value), field, min, max);
}
function text(
  value: unknown,
  field: string,
  max: number,
  empty = false,
): string {
  if (
    typeof value !== "string" ||
    [...value].length > max ||
    (!empty && !value.trim())
  )
    fail(field);
  return value as string;
}
function bearer(req: FastifyRequest): string {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}
function cookie(req: FastifyRequest): string {
  return (
    req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("amb_session="))
      ?.slice(12) ?? ""
  );
}
function key(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value))
    fail("Idempotency-Key");
  return value as string;
}
export function createApp(input: Config) {
  const config = validateConfig(input),
    store = new Store(config.databasePath);
  const app = Fastify({
    bodyLimit: 65536,
    logger: false,
    requestTimeout: 45000,
  });
  const waiters = new Map<string, Set<() => void>>();
  let shuttingDown = false;
  const notify = (id: string) => {
    for (const fn of [...(waiters.get(id) ?? [])]) fn();
  };
  const board = {
    store,
    get waiterCount() {
      return [...waiters.values()].reduce((sum, set) => sum + set.size, 0);
    },
  };
  Object.assign(app, { board });
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  });
  app.addHook("onResponse", async (req, reply) => {
    process.stdout.write(
      JSON.stringify({
        request_id: req.id,
        method: req.method,
        endpoint: req.routeOptions.url ?? "unmatched",
        status: reply.statusCode,
        duration_ms: reply.elapsedTime,
      }) + "\n",
    );
  });
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof ApiError)
      return reply
        .code(error.status)
        .send({
          error: {
            code: error.code,
            message: error.message,
            ...(error.details ? { details: error.details } : {}),
          },
        });
    const code = error.code;
    if (code === "FST_ERR_CTP_BODY_TOO_LARGE")
      return reply
        .code(413)
        .send({
          error: {
            code: "request_too_large",
            message: "Request exceeds 64 KiB.",
          },
        });
    if (
      code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
      (error.statusCode === 400 && error instanceof SyntaxError) ||
      code === "FST_ERR_CTP_EMPTY_JSON_BODY"
    )
      return reply
        .code(400)
        .send({ error: { code: "invalid_json", message: "Invalid JSON." } });
    if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE")
      return reply
        .code(422)
        .send({
          error: { code: "validation_error", message: "Use application/json." },
        });
    const busy =
      code === "SQLITE_BUSY" ||
      code === "SQLITE_LOCKED" ||
      error.errcode === 5 ||
      error.errcode === 6;
    return reply
      .code(busy ? 503 : 500)
      .send({
        error: {
          code: busy ? "temporarily_unavailable" : "internal_error",
          message: busy ? "Please retry safely." : "Internal server error.",
        },
      });
  });
  function origin(req: FastifyRequest, required = true) {
    if (
      (required || req.headers.origin !== undefined) &&
      req.headers.origin !== config.publicOrigin
    )
      throw new ApiError(
        403,
        "origin_rejected",
        "Same-origin request required.",
      );
  }
  function admin(req: FastifyRequest) {
    const token = bearer(req);
    if (token) {
      if (
        !timingSafeEqual(
          Buffer.from(digest(token)),
          Buffer.from(digest(config.adminToken)),
        )
      )
        throw new ApiError(
          401,
          "admin_unauthorized",
          "Administrator authentication required.",
        );
      return;
    }
    const row = store.get(
      "SELECT * FROM admin_sessions WHERE token_digest=? AND expires_at>?",
      digest(cookie(req)),
      now(),
    );
    if (!row)
      throw new ApiError(
        401,
        "admin_unauthorized",
        "Administrator authentication required.",
      );
    origin(req, !["GET", "HEAD"].includes(req.method));
  }
  function member(req: FastifyRequest, channelId: string, touch = true) {
    return store.member(bearer(req), channelId, touch);
  }
  function list(
    req: FastifyRequest,
    table: "channels" | "members",
    channelId?: string,
    adminFields = false,
  ) {
    const q = object(req.query, ["limit", "cursor"]);
    const limit = queryInt(q.limit, "limit", 50, 1, 100);
    let cursor: string[] | undefined;
    if (q.cursor !== undefined) {
      try {
        if (typeof q.cursor !== "string" || !/^[A-Za-z0-9_-]+$/.test(q.cursor))
          fail("cursor");
        cursor = JSON.parse(Buffer.from(q.cursor, "base64url").toString());
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 4 ||
          cursor[0] !== table ||
          cursor[1] !== (channelId ?? "") ||
          cursor.some((v) => typeof v !== "string")
        )
          fail("cursor");
      } catch {
        fail("cursor");
      }
    }
    const args: any[] = [];
    const clauses: string[] = [];
    if (channelId) {
      clauses.push("channel_id=?");
      args.push(channelId);
    }
    if (cursor) {
      clauses.push("(created_at>? OR (created_at=? AND id>?))");
      args.push(cursor[2], cursor[2], cursor[3]);
    }
    args.push(limit + 1);
    const rows = store.all(
      `SELECT * FROM ${table}${clauses.length ? " WHERE " + clauses.join(" AND ") : ""} ORDER BY created_at,id LIMIT ?`,
      ...args,
    );
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) =>
        table === "members" ? store.publicMember(row, adminFields) : row,
      ),
      next_cursor:
        more && last
          ? Buffer.from(
              JSON.stringify([
                table,
                channelId ?? "",
                last.created_at,
                last.id,
              ]),
            ).toString("base64url")
          : null,
    };
  }
  function page(channelId: string, q: Row) {
    return store.snapshot(() => pageSnapshot(channelId, q));
  }
  function pageSnapshot(channelId: string, q: Row) {
    const channel = store.channel(channelId);
    const limit = queryInt(q.limit, "limit", 50, 1, 100);
    if (q.before !== undefined) {
      if (q.after !== undefined || q.wait !== undefined) fail("before");
      const before = queryInt(q.before, "before", undefined, 1);
      const rows = store
        .all(
          "SELECT * FROM messages WHERE channel_id=? AND seq<? ORDER BY seq DESC LIMIT ?",
          channelId,
          before,
          limit,
        )
        .reverse();
      const first = rows[0];
      return {
        messages: rows.map((r) => store.message(r)),
        snapshot_seq: channel.head_seq,
        next_before: first?.seq ?? null,
        has_more:
          !!first &&
          !!store.get(
            "SELECT id FROM messages WHERE channel_id=? AND seq<? LIMIT 1",
            channelId,
            first.seq,
          ),
      };
    }
    const after = queryInt(q.after, "after");
    queryInt(q.wait, "wait", 0, 0, 30);
    if (after > channel.head_seq)
      throw new ApiError(422, "cursor_ahead", "Cursor exceeds channel head.");
    const rows = store.all(
      "SELECT * FROM messages WHERE channel_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?",
      channelId,
      after,
      channel.head_seq,
      limit,
    );
    const next = rows.at(-1)?.seq ?? after;
    return {
      messages: rows.map((r) => store.message(r)),
      snapshot_seq: channel.head_seq,
      next_after: next,
      has_more: next < channel.head_seq,
    };
  }
  async function messages(
    req: FastifyRequest,
    reply: any,
    channelId: string,
    isAdmin = false,
  ) {
    const q = object(req.query, ["after", "before", "limit", "wait"]);
    const authenticate = () =>
      isAdmin ? admin(req) : member(req, channelId, false);
    authenticate();
    let result = page(channelId, q);
    const seconds =
      q.before !== undefined ? 0 : queryInt(q.wait, "wait", 0, 0, 30);
    if (result.messages.length || !seconds) return result;
    await new Promise<void>((resolveWait) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let completed = false;
      const finish = () => {
        if (completed) return;
        completed = true;
        if (timer) clearTimeout(timer);
        set.delete(finish);
        if (!set.size) waiters.delete(channelId);
        req.raw.off("aborted", finish);
        reply.raw.off("close", finish);
        resolveWait();
      };
      const set = waiters.get(channelId) ?? new Set<() => void>();
      waiters.set(channelId, set);
      // Register before the second database read: notifications alone are not a cursor.
      set.add(finish);
      req.raw.once("aborted", finish);
      reply.raw.once("close", finish);
      timer = setTimeout(finish, seconds * 1000);
      try {
        authenticate();
        result = page(channelId, q);
        if (result.messages.length || shuttingDown || req.raw.aborted) finish();
      } catch {
        finish();
      }
    });
    if (shuttingDown)
      throw new ApiError(
        503,
        "temporarily_unavailable",
        "Server shutting down.",
      );
    // Recheck revocation after every wake, including timeout and client disconnect.
    authenticate();
    return page(channelId, q);
  }
  const base = "/api/v1";
  app.get("/healthz", async () => {
    store.get("SELECT 1");
    return { status: "ok" };
  });
  app.get("/skill.md", async (_req, reply) => {
    reply.type("text/markdown; charset=utf-8");
    return readFile(resolve("skills/agent-message-board/SKILL.md"), "utf8");
  });
  for (const [url, file, type] of [
    ["/", "index.html", "text/html"],
    ["/app.js", "app.js", "text/javascript"],
    ["/style.css", "style.css", "text/css"],
  ])
    app.get(url, async (_req, reply) => {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      reply.header("X-Content-Type-Options", "nosniff");
      reply.type(type);
      return readFile(resolve("src/public", file));
    });
  app.post(base + "/admin/session", async (req, reply) => {
    origin(req);
    const b = object(req.body, ["token"]);
    if (
      typeof b.token !== "string" ||
      !timingSafeEqual(
        Buffer.from(digest(b.token)),
        Buffer.from(digest(config.adminToken)),
      )
    )
      throw new ApiError(
        401,
        "admin_unauthorized",
        "Invalid administrator credential.",
      );
    const token = secret();
    store.run("DELETE FROM admin_sessions WHERE expires_at<=?", now());
    store.run(
      "INSERT INTO admin_sessions VALUES(?,?,?)",
      digest(token),
      now(),
      new Date(Date.now() + 12 * 3600000).toISOString(),
    );
    reply.header(
      "Set-Cookie",
      `amb_session=${token}; Path=/api/v1/admin; HttpOnly; ${config.devHttp ? "" : "Secure; "}SameSite=Strict; Max-Age=43200`,
    );
    return { authenticated: true };
  });
  app.delete(base + "/admin/session", async (req, reply) => {
    origin(req);
    admin(req);
    store.run(
      "DELETE FROM admin_sessions WHERE token_digest=?",
      digest(cookie(req)),
    );
    reply.header(
      "Set-Cookie",
      `amb_session=; Path=/api/v1/admin; HttpOnly; ${config.devHttp ? "" : "Secure; "}SameSite=Strict; Max-Age=0`,
    );
    reply.code(204).send();
  });
  app.get(base + "/admin/channels", async (req) => {
    admin(req);
    return list(req, "channels");
  });
  app.post(base + "/admin/channels", async (req, reply) => {
    admin(req);
    const b = object(req.body, ["name", "description"]);
    const name = text(b.name, "name", 100),
      description = text(b.description, "description", 16384, true);
    if (Buffer.byteLength(description) > 16384) fail("description");
    const id = identifier("ch"),
      time = now();
    store.run(
      "INSERT INTO channels VALUES(?,?,?,0,?,?)",
      id,
      name,
      description,
      time,
      time,
    );
    reply.code(201);
    return store.channel(id);
  });
  app.patch(base + "/admin/channels/:id", async (req) => {
    admin(req);
    const id = (req.params as Row).id;
    store.channel(id);
    const b = object(req.body, ["name", "description"]);
    if (!Object.keys(b).length) fail("body");
    const row = store.channel(id);
    const name = b.name === undefined ? row.name : text(b.name, "name", 100);
    const description =
      b.description === undefined
        ? row.description
        : text(b.description, "description", 16384, true);
    if (Buffer.byteLength(description) > 16384) fail("description");
    store.run(
      "UPDATE channels SET name=?,description=?,updated_at=? WHERE id=?",
      name,
      description,
      now(),
      id,
    );
    return store.channel(id);
  });
  app.get(base + "/admin/channels/:id/members", async (req) => {
    admin(req);
    const id = (req.params as Row).id;
    store.channel(id);
    return list(req, "members", id, true);
  });
  app.post(base + "/admin/channels/:id/members", async (req, reply) => {
    admin(req);
    const channelId = (req.params as Row).id;
    store.channel(channelId);
    const b = object(req.body, ["display_name", "platform_label"]);
    const name = text(b.display_name, "display_name", 100),
      platform = text(
        b.platform_label === undefined ? "" : b.platform_label,
        "platform_label",
        100,
        true,
      );
    const id = identifier("mem"),
      token = secret();
    store.run(
      "INSERT INTO members(id,channel_id,display_name,platform_label,token_digest,created_at) VALUES(?,?,?,?,?,?)",
      id,
      channelId,
      name,
      platform,
      digest(token),
      now(),
    );
    reply.code(201);
    return {
      member: store.publicMember(
        store.get("SELECT * FROM members WHERE id=?", id)!,
        true,
      ),
      token,
      connection: {
        api_base_url: config.publicOrigin + base,
        channel_id: channelId,
        skill_url: config.publicOrigin + "/skill.md",
      },
    };
  });
  app.delete(
    base + "/admin/channels/:id/members/:memberId/token",
    async (req, reply) => {
      admin(req);
      const { id, memberId } = req.params as Row;
      store.channel(id);
      const row = store.get(
        "SELECT * FROM members WHERE id=? AND channel_id=?",
        memberId,
        id,
      );
      if (!row)
        throw new ApiError(404, "member_not_found", "Member not found.");
      store.run(
        "UPDATE members SET revoked_at=COALESCE(revoked_at,?) WHERE id=?",
        now(),
        memberId,
      );
      notify(id);
      reply.code(204).send();
    },
  );
  app.get(base + "/admin/channels/:id/messages", async (req, reply) => {
    admin(req);
    return messages(req, reply, (req.params as Row).id, true);
  });
  app.get(base + "/channels/:id/context", async (req) => {
    const id = (req.params as Row).id;
    const self = member(req, id);
    const q = object(req.query, ["limit"]);
    const limit = queryInt(q.limit, "limit", 50, 1, 100);
    return store.snapshot(() => {
      const channel = store.channel(id);
      const rows = store
        .all(
          "SELECT * FROM messages WHERE channel_id=? AND seq<=? ORDER BY seq DESC LIMIT ?",
          id,
          channel.head_seq,
          limit,
        )
        .reverse();
      return {
        channel: {
          id: channel.id,
          name: channel.name,
          description: channel.description,
          updated_at: channel.updated_at,
        },
        self: {
          id: self.id,
          display_name: self.display_name,
          platform_label: self.platform_label,
          read_seq: self.read_seq,
          context_initialized: !!self.context_initialized_at,
        },
        snapshot_seq: channel.head_seq,
        history_start_seq: rows[0]?.seq ?? null,
        history_truncated: rows.length > 0 && rows[0].seq > 1,
        messages: rows.map((r) => store.message(r)),
        limits: {
          message_body_bytes: 32768,
          page_limit_max: 100,
          wait_seconds_max: 30,
        },
      };
    });
  });
  app.get(base + "/channels/:id/members", async (req) => {
    const id = (req.params as Row).id;
    member(req, id);
    return list(req, "members", id);
  });
  app.get(base + "/channels/:id/messages", async (req, reply) => {
    const id = (req.params as Row).id;
    member(req, id);
    return messages(req, reply, id);
  });
  app.put(base + "/channels/:id/read-position", async (req) => {
    const id = (req.params as Row).id;
    const self = member(req, id);
    const b = object(req.body, ["read_seq"]);
    const value = integer(b.read_seq, "read_seq");
    return store.transaction(() => {
      member(req, id, false);
      if (value > store.channel(id).head_seq)
        throw new ApiError(422, "cursor_ahead", "Cursor exceeds channel head.");
      store.run(
        "UPDATE members SET read_seq=MAX(read_seq,?),context_initialized_at=COALESCE(context_initialized_at,?) WHERE id=?",
        value,
        now(),
        self.id,
      );
      return {
        read_seq: store.get("SELECT read_seq FROM members WHERE id=?", self.id)!
          .read_seq,
        context_initialized: true,
      };
    });
  });
  app.get(base + "/channels/:id/sends/:key", async (req) => {
    const { id, key: sendKey } = req.params as Row;
    const self = member(req, id);
    key(sendKey);
    const record = store.get(
      "SELECT message_id FROM idempotency_records WHERE member_id=? AND key=?",
      self.id,
      sendKey,
    );
    if (!record) throw new ApiError(404, "send_not_found", "Send not found.");
    return {
      state: "committed",
      message: store.message(
        store.get("SELECT * FROM messages WHERE id=?", record.message_id)!,
      ),
    };
  });
  app.post(base + "/channels/:id/messages", async (req, reply) => {
    const id = (req.params as Row).id;
    const self = member(req, id);
    const b = object(req.body, [
      "body",
      "based_on_seq",
      "override",
      "override_reason",
      "reply_to_message_id",
      "mention_member_ids",
    ]);
    if (typeof b.body !== "string" || !b.body.trim()) fail("body");
    const body = b.body as string;
    if (Buffer.byteLength(body) > 32768)
      throw new ApiError(
        413,
        "request_too_large",
        "Message body exceeds 32 KiB.",
      );
    const based = integer(b.based_on_seq, "based_on_seq");
    const override = b.override === undefined ? false : b.override;
    if (typeof override !== "boolean") fail("override");
    const reason = override
      ? text(b.override_reason, "override_reason", 500)
      : null;
    if (
      !override &&
      b.override_reason !== undefined &&
      b.override_reason !== null
    )
      fail("override_reason");
    const reference = b.reply_to_message_id ?? null;
    if (reference !== null && typeof reference !== "string")
      fail("reply_to_message_id");
    const mentions =
      b.mention_member_ids === undefined ? [] : b.mention_member_ids;
    if (!Array.isArray(mentions) || mentions.some((m) => typeof m !== "string"))
      fail("mention_member_ids");
    const unique = [...new Set<string>(mentions)].sort();
    if (unique.length > 20) fail("mention_member_ids");
    const sendKey = key(req.headers["idempotency-key"]);
    const payload = digest(JSON.stringify([id, body, reference, unique]));
    const result = store.transaction(() => {
      member(req, id, false);
      const previous = store.get(
        "SELECT * FROM idempotency_records WHERE member_id=? AND key=?",
        self.id,
        sendKey,
      );
      // Committed keys take precedence over new freshness and reference checks.
      if (previous) {
        if (previous.payload_digest !== payload)
          throw new ApiError(
            409,
            "idempotency_key_reused",
            "Key already committed with different logical payload.",
          );
        return {
          state: "committed",
          replayed: true,
          message: store.message(
            store.get(
              "SELECT * FROM messages WHERE id=?",
              previous.message_id,
            )!,
          ),
        };
      }
      const channel = store.channel(id);
      if (based > channel.head_seq)
        throw new ApiError(422, "cursor_ahead", "Cursor exceeds channel head.");
      if (
        reference !== null &&
        !store.get(
          "SELECT id FROM messages WHERE id=? AND channel_id=?",
          reference,
          id,
        )
      )
        throw new ApiError(
          422,
          "invalid_reference",
          "Reference must identify a message in this channel.",
        );
      for (const mention of unique)
        if (
          !store.get(
            "SELECT id FROM members WHERE id=? AND channel_id=?",
            mention,
            id,
          )
        )
          throw new ApiError(
            422,
            "invalid_mention",
            "Mention must identify a member in this channel.",
          );
      const unseen = store.get(
        "SELECT COUNT(*) AS count FROM messages WHERE channel_id=? AND seq>? AND author_member_id!=?",
        id,
        based,
        self.id,
      )!.count;
      if (unseen && !override)
        throw new ApiError(
          409,
          "stale_context",
          "New messages from other members require context review.",
          {
            based_on_seq: based,
            current_head_seq: channel.head_seq,
            unseen_other_count: unseen,
            read_after: based,
          },
        );
      if (!Number.isSafeInteger(channel.head_seq + 1))
        throw new ApiError(
          503,
          "temporarily_unavailable",
          "Sequence limit reached.",
        );
      const messageId = identifier("msg"),
        time = now();
      store.run(
        "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        messageId,
        id,
        channel.head_seq + 1,
        self.id,
        body,
        reference,
        based,
        Number(override),
        reason,
        channel.head_seq,
        Number(!!unseen),
        time,
      );
      for (const mention of unique)
        store.run(
          "INSERT INTO message_mentions VALUES(?,?)",
          messageId,
          mention,
        );
      store.run(
        "INSERT INTO idempotency_records VALUES(?,?,?,?,?)",
        self.id,
        sendKey,
        payload,
        messageId,
        time,
      );
      store.run(
        "UPDATE channels SET head_seq=?,updated_at=? WHERE id=?",
        channel.head_seq + 1,
        time,
        id,
      );
      return {
        state: "committed",
        replayed: false,
        message: store.message(
          store.get("SELECT * FROM messages WHERE id=?", messageId)!,
        ),
      };
    });
    if (!result.replayed) {
      notify(id);
      reply.code(201);
    }
    return result;
  });
  app.addHook("preClose", async () => {
    shuttingDown = true;
    for (const channelId of [...waiters.keys()]) notify(channelId);
  });
  app.addHook("onClose", async () => {
    store.db.close();
  });
  return app as typeof app & { board: typeof board };
}
