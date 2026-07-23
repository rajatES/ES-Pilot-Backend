// Postgres data layer. Implements the subset of the supabase-js query builder
// the services use (filters, ordering, single/maybeSingle, mutations, count,
// nested embedded selects) as parameterised SQL over a pg pool. Schema is
// owned by the TypeORM entities (database/entities.ts).

import pg from "pg";
const { Pool, types } = pg;

// Shared-workspace owner id: all data rows belong to this fixed id,
// independent of which user is logged in.
export const OWNER_ID = "00000000-0000-0000-0000-000000000001";

// Return numeric/bigint as JS numbers (Supabase did); default pg gives strings.
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // int8
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v))); // numeric

let pool = null;
export function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT) || 5432,
      user: process.env.DB_USERNAME || "postgres",
      password: process.env.DB_PASSWORD || "password",
      database: process.env.DB_NAME || "posting_pilot_db",
      max: 10,
    });
  }
  return pool;
}

// Per-table column type cache; needed to serialise jsonb correctly
// (node-pg formats bare JS arrays as pg arrays, not JSON).
const typeCache = {};
async function columnTypes(table) {
  if (typeCache[table]) return typeCache[table];
  const { rows } = await getPool().query(
    `select column_name, data_type, udt_name
       from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  const map = {};
  for (const r of rows) map[r.column_name] = { dataType: r.data_type, udt: r.udt_name };
  typeCache[table] = map;
  return map;
}

// Coerce a JS value for a write, using the column's real Postgres type.
function coerceWrite(colInfo, value) {
  if (value === null || value === undefined) return value ?? null;
  if (colInfo) {
    if (colInfo.udt === "jsonb" || colInfo.udt === "json") return JSON.stringify(value);
    if (colInfo.dataType === "ARRAY") return value; // node-pg formats JS arrays as pg arrays
  }
  // Unknown column but object-shaped → default to JSON so we never send "[object Object]".
  if (typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

// Relationships used by embedded selects. parentKey is on the row being
// embedded into; childKey on the embedded table.
const RELATIONSHIPS = {
  scheduled_posts: {
    post_targets: { table: "post_targets", parentKey: "id", childKey: "post_id", many: true },
  },
  post_targets: {
    social_accounts: { table: "social_accounts", parentKey: "social_account_id", childKey: "id", many: false },
    scheduled_posts: { table: "scheduled_posts", parentKey: "post_id", childKey: "id", many: false },
  },
  post_insights: {
    post_targets: { table: "post_targets", parentKey: "post_target_id", childKey: "id", many: false },
  },
};

// Parse a select string into { columns, embeds }. Handles nesting:
//   "*, post_targets(*, social_accounts(id, name))"
function parseSelect(sel) {
  if (!sel || sel === "*") return { columns: ["*"], embeds: [] };
  const parts = splitTopLevel(sel);
  const columns = [];
  const embeds = [];
  for (const part of parts) {
    const m = part.match(/^\s*([a-z_]+)\s*\(([\s\S]*)\)\s*$/i);
    if (m) embeds.push({ name: m[1], ...parseSelect(m[2].trim()) });
    else if (part.trim()) columns.push(part.trim());
  }
  return { columns, embeds };
}

// Split on top-level commas only (respecting parentheses).
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// Attach embedded resources to parent rows (one batched query per level).
async function resolveEmbeds(table, rows, embeds) {
  if (!rows.length || !embeds.length) return;
  const rels = RELATIONSHIPS[table] || {};
  for (const embed of embeds) {
    const rel = rels[embed.name];
    if (!rel) continue;
    const keys = [...new Set(rows.map((r) => r[rel.parentKey]).filter((v) => v !== null && v !== undefined))];
    if (!keys.length) {
      for (const r of rows) r[embed.name] = rel.many ? [] : null;
      continue;
    }
    const { rows: childRows } = await getPool().query(
      `select * from ${rel.table} where ${rel.childKey} = ANY($1)`,
      [keys],
    );
    await resolveEmbeds(rel.table, childRows, embed.embeds);
    for (const r of rows) {
      const matches = childRows.filter((c) => c[rel.childKey] === r[rel.parentKey]);
      r[embed.name] = rel.many ? matches : matches[0] || null;
    }
  }
}

const OPS = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

// Chainable query builder mirroring the supabase-js surface the app uses.
// Thenable: awaiting it executes and yields { data, error, count }.
class QueryBuilder {
  constructor(table) {
    this.table = table;
    this._op = null;
    this._filters = [];
    this._orders = [];
    this._limit = null;
    this._values = null;
    this._onConflict = null;
    this._single = null; // 'one' | 'maybe' | null
    this._selectStr = "*";
    this._count = null;
    this._head = false;
  }

  select(cols = "*", opts = {}) {
    if (!this._op) {
      this._op = "select";
      this._selectStr = cols || "*";
      this._count = opts.count || null;
      this._head = !!opts.head;
    } else {
      this._selectStr = cols || "*"; // RETURNING after a mutation
    }
    return this;
  }

  insert(values) {
    this._op = "insert";
    this._values = Array.isArray(values) ? values : [values];
    return this;
  }
  update(values) {
    this._op = "update";
    this._values = values;
    return this;
  }
  delete() {
    this._op = "delete";
    return this;
  }
  upsert(values, opts = {}) {
    this._op = "upsert";
    this._values = Array.isArray(values) ? values : [values];
    this._onConflict = opts.onConflict || null;
    return this;
  }

  eq(col, val) { this._filters.push({ col, op: "eq", val }); return this; }
  neq(col, val) { this._filters.push({ col, op: "neq", val }); return this; }
  gt(col, val) { this._filters.push({ col, op: "gt", val }); return this; }
  gte(col, val) { this._filters.push({ col, op: "gte", val }); return this; }
  lt(col, val) { this._filters.push({ col, op: "lt", val }); return this; }
  lte(col, val) { this._filters.push({ col, op: "lte", val }); return this; }
  in(col, arr) { this._filters.push({ col, op: "in", val: arr }); return this; }
  is(col, val) { this._filters.push({ col, op: "is", val }); return this; }
  not(col, op, val) { this._filters.push({ col, op: "not", subOp: op, val }); return this; }
  ilike(col, pattern) { this._filters.push({ col, op: "ilike", val: pattern }); return this; }
  contains(col, val) { this._filters.push({ col, op: "contains", val }); return this; }
  match(obj) { for (const [col, val] of Object.entries(obj)) this._filters.push({ col, op: "eq", val }); return this; }

  order(col, opts = {}) { this._orders.push({ col, asc: opts.ascending !== false }); return this; }
  limit(n) { this._limit = n; return this; }
  single() { this._single = "one"; return this; }
  maybeSingle() { this._single = "maybe"; return this; }

  // WHERE builder shared across select/update/delete. Returns { sql, params }.
  _where(startIdx = 1) {
    if (!this._filters.length) return { sql: "", params: [] };
    const clauses = [];
    const params = [];
    let i = startIdx;
    for (const f of this._filters) {
      if (f.op in OPS) {
        clauses.push(`${f.col} ${OPS[f.op]} $${i++}`);
        params.push(f.val);
      } else if (f.op === "in") {
        clauses.push(`${f.col} = ANY($${i++})`);
        params.push(f.val);
      } else if (f.op === "is") {
        if (f.val === null) clauses.push(`${f.col} is null`);
        else { clauses.push(`${f.col} is $${i++}`); params.push(f.val); }
      } else if (f.op === "not") {
        if (f.subOp === "is" && f.val === null) clauses.push(`${f.col} is not null`);
        else { clauses.push(`${f.col} <> $${i++}`); params.push(f.val); }
      } else if (f.op === "ilike") {
        clauses.push(`${f.col} ilike $${i++}`);
        params.push(f.val);
      } else if (f.op === "contains") {
        clauses.push(`${f.col} @> $${i++}`);
        params.push(f.val);
      }
    }
    return { sql: clauses.length ? ` where ${clauses.join(" and ")}` : "", params };
  }

  async _run() {
    try {
      if (this._op === "insert" || this._op === "upsert") return await this._runInsert();
      if (this._op === "update") return await this._runUpdate();
      if (this._op === "delete") return await this._runDelete();
      return await this._runSelect();
    } catch (e) {
      return { data: null, error: { message: e.message }, count: null };
    }
  }

  async _runSelect() {
    const { sql: whereSql, params } = this._where();

    let count = null;
    if (this._count) {
      const c = await getPool().query(`select count(*)::int as n from ${this.table}${whereSql}`, params);
      count = c.rows[0].n;
      if (this._head) return { data: null, error: null, count };
    }

    const { embeds } = parseSelect(this._selectStr);
    let q = `select * from ${this.table}${whereSql}`;
    if (this._orders.length) {
      q += " order by " + this._orders.map((o) => `${o.col} ${o.asc ? "asc" : "desc"}`).join(", ");
    }
    if (this._limit != null) q += ` limit ${Number(this._limit)}`;

    const { rows } = await getPool().query(q, params);
    if (embeds.length) await resolveEmbeds(this.table, rows, embeds);

    if (this._single === "one") {
      if (rows.length !== 1) {
        return { data: null, error: { message: `Expected one row, got ${rows.length}`, code: "PGRST116" }, count };
      }
      return { data: rows[0], error: null, count };
    }
    if (this._single === "maybe") {
      if (rows.length > 1) return { data: null, error: { message: "Expected 0 or 1 row" }, count };
      return { data: rows[0] || null, error: null, count };
    }
    return { data: rows, error: null, count };
  }

  async _runInsert() {
    const colInfo = await columnTypes(this.table);
    const cols = [...new Set(this._values.flatMap((v) => Object.keys(v)))];
    const params = [];
    let i = 1;
    const rowsSql = this._values.map((row) => {
      const placeholders = cols.map((c) => {
        params.push(coerceWrite(colInfo[c], row[c]));
        return `$${i++}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    let q = `insert into ${this.table} (${cols.join(", ")}) values ${rowsSql.join(", ")}`;
    if (this._op === "upsert") {
      const conflict = this._onConflict || "id";
      const conflictCols = conflict.split(",").map((s) => s.trim());
      const updates = cols.filter((c) => !conflictCols.includes(c));
      q += ` on conflict (${conflict}) do update set ${updates.map((c) => `${c} = excluded.${c}`).join(", ")}`;
    }
    q += " returning *";

    const { rows } = await getPool().query(q, params);
    return this._shapeReturning(rows);
  }

  async _runUpdate() {
    const colInfo = await columnTypes(this.table);
    const cols = Object.keys(this._values);
    const params = [];
    let i = 1;
    const setSql = cols.map((c) => {
      params.push(coerceWrite(colInfo[c], this._values[c]));
      return `${c} = $${i++}`;
    });
    const { sql: whereSql, params: whereParams } = this._where(i);
    const q = `update ${this.table} set ${setSql.join(", ")}${whereSql} returning *`;
    const { rows } = await getPool().query(q, [...params, ...whereParams]);
    return this._shapeReturning(rows);
  }

  async _runDelete() {
    const { sql: whereSql, params } = this._where();
    const { rows } = await getPool().query(`delete from ${this.table}${whereSql} returning *`, params);
    return this._shapeReturning(rows);
  }

  _shapeReturning(rows) {
    if (this._single === "one") {
      if (rows.length !== 1) return { data: null, error: { message: `Expected one row, got ${rows.length}` }, count: null };
      return { data: rows[0], error: null, count: null };
    }
    if (this._single === "maybe") {
      return { data: rows[0] || null, error: null, count: null };
    }
    return { data: rows, error: null, count: null };
  }

  // Thenable — lets `await supabase.from(t)...` execute the query.
  then(onFulfilled, onRejected) {
    return this._run().then(onFulfilled, onRejected);
  }
}

// Data client entry point. Storage and auth live in dedicated services.
export function createServiceSupabase() {
  return {
    from(table) {
      return new QueryBuilder(table);
    },
  };
}
