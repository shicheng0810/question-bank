const HEX64 = /^[0-9a-f]{64}$/;
const TICKET = /^dt1\.([0-9a-f]{64})\.([0-9a-f]{64})$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TICKET_TABLE = 'gen05_deletion_tickets';
const TICKET_TTL_MS = 24 * 60 * 60 * 1000;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function rows(cursor) {
  if (!cursor) return [];
  if (typeof cursor.toArray === 'function') return cursor.toArray();
  return Array.from(cursor);
}

function query(sql, statement, ...bindings) {
  return rows(sql.exec(statement, ...bindings));
}

function tableExists(sql) {
  return query(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", TICKET_TABLE).length > 0;
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw failure('INVALID_INPUT');
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')
    || actual.length !== keys.length || keys.some((key) => !actual.includes(key))) throw failure('INVALID_INPUT');
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw failure('INVALID_INPUT');
    result[key] = descriptor.value;
  }
  return result;
}

function safeExpiry(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validCommand(command) {
  const fields = exactRecord(command, ['principal', 'incarnation', 'generation', 'expiresAt', 'fence', 'opId']);
  if (typeof fields.principal !== 'string' || !HEX64.test(fields.principal)
    || typeof fields.incarnation !== 'string' || !HEX64.test(fields.incarnation)
    || fields.principal === fields.incarnation || typeof fields.generation !== 'string'
    || !UUID_V4.test(fields.generation) || !safeExpiry(fields.expiresAt)
    || !Number.isSafeInteger(fields.fence) || fields.fence < 0
    || fields.fence > Number.MAX_SAFE_INTEGER - 2
    || typeof fields.opId !== 'string' || !UUID_V4.test(fields.opId)) throw failure('INVALID_INPUT');
  return fields;
}

function canonicalCommand(command) {
  return {
    principal: command.principal,
    incarnation: command.incarnation,
    generation: command.generation,
    expiresAt: command.expiresAt,
    fence: command.fence,
    opId: command.opId,
  };
}

export function createDeletionTicketSchema(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TICKET_TABLE}(
    ticket TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    secret_hex TEXT NOT NULL,
    op_id TEXT NOT NULL,
    command_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    UNIQUE(principal, secret_hex),
    UNIQUE(principal, op_id)
  )`);
}

export function ticketParts(ticket) {
  if (typeof ticket !== 'string') return null;
  const match = ticket.match(TICKET);
  if (!match) return null;
  return { ticket, principal: match[1], secretHex: match[2] };
}

export function issueDeletionTicket(principal) {
  if (typeof principal !== 'string' || !HEX64.test(principal)) throw failure('INVALID_INPUT');
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let secretHex = '';
  for (const byte of bytes) secretHex += byte.toString(16).padStart(2, '0');
  if (!HEX64.test(secretHex)) throw failure('UNAVAILABLE');
  return { ticket: `dt1.${principal}.${secretHex}`, secretHex };
}

export function ticketExpiresAt(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - TICKET_TTL_MS) {
    throw failure('UNAVAILABLE');
  }
  return now + TICKET_TTL_MS;
}

export function readDeletionTicket(sql, ticket) {
  const parts = ticketParts(ticket);
  if (!parts) throw failure('INVALID_CREDENTIALS');
  if (!tableExists(sql)) throw failure('INVALID_CREDENTIALS');
  const records = query(sql, `SELECT ticket,principal,secret_hex,op_id,command_json,expires_at
    FROM ${TICKET_TABLE} WHERE ticket=?`, parts.ticket);
  if (records.length !== 1) throw failure('INVALID_CREDENTIALS');
  const row = records[0];
  if (!row || row.ticket !== parts.ticket || row.principal !== parts.principal
    || typeof row.secret_hex !== 'string' || !HEX64.test(row.secret_hex)
    || !UUID_V4.test(row.op_id) || !safeExpiry(row.expires_at) || typeof row.command_json !== 'string') {
    throw failure('UNAVAILABLE');
  }
  try {
    if (!timingSafeEqualHex(parts.secretHex, row.secret_hex)) throw failure('UNAVAILABLE');
  } catch (error) {
    if (error?.code === 'UNAVAILABLE') throw error;
    throw failure('UNAVAILABLE');
  }
  let command;
  try {
    command = JSON.parse(row.command_json);
  } catch {
    throw failure('UNAVAILABLE');
  }
  let captured;
  try {
    captured = validCommand(command);
  } catch {
    throw failure('UNAVAILABLE');
  }
  if (JSON.stringify(captured) !== row.command_json || captured.principal !== row.principal
    || captured.opId !== row.op_id) {
    throw failure('UNAVAILABLE');
  }
  return {
    ticket: parts.ticket,
    principal: parts.principal,
    secretHex: row.secret_hex,
    command: captured,
    expiresAt: row.expires_at,
  };
}

export function findDeletionTicketByOperation(sql, principal, opId) {
  if (!tableExists(sql)) return null;
  if (typeof principal !== 'string' || !HEX64.test(principal)
    || typeof opId !== 'string' || !UUID_V4.test(opId)) throw failure('INVALID_INPUT');
  const records = query(sql, `SELECT ticket FROM ${TICKET_TABLE} WHERE principal=? AND op_id=?`, principal, opId);
  if (records.length === 0) return null;
  if (records.length !== 1 || typeof records[0].ticket !== 'string') throw failure('UNAVAILABLE');
  return readDeletionTicket(sql, records[0].ticket);
}

export function insertDeletionTicket(sql, row) {
  const parsed = ticketParts(row.ticket);
  if (!parsed || parsed.principal !== row.principal || typeof row.secretHex !== 'string' || !HEX64.test(row.secretHex)
    || !safeExpiry(row.expiresAt)) throw failure('INVALID_INPUT');
  const command = validCommand(row.command);
  sql.exec(`INSERT INTO ${TICKET_TABLE}(
    ticket,principal,secret_hex,op_id,command_json,expires_at
  ) VALUES(?,?,?,?,?,?)`, row.ticket, row.principal, row.secretHex, command.opId,
  JSON.stringify(command), row.expiresAt);
}

export function deletionTicketSchemaExists(sql) {
  return tableExists(sql);
}

export function timingSafeEqualHex(leftHex, rightHex) {
  if (typeof leftHex !== 'string' || typeof rightHex !== 'string'
    || !HEX64.test(leftHex) || !HEX64.test(rightHex)) return false;
  const left = Uint8Array.from(leftHex.match(/../g), (value) => Number.parseInt(value, 16));
  const right = Uint8Array.from(rightHex.match(/../g), (value) => Number.parseInt(value, 16));
  if (typeof crypto.subtle?.timingSafeEqual !== 'function') throw failure('UNAVAILABLE');
  return crypto.subtle.timingSafeEqual(left, right);
}

export function assertDeletionTicket(row, now = Date.now()) {
  if (!row || !ticketParts(row.ticket) || !safeExpiry(row.expiresAt)
    || !Number.isSafeInteger(now) || now < 0 || now >= row.expiresAt) throw failure('INVALID_CREDENTIALS');
  const parts = ticketParts(row.ticket);
  if (parts.principal !== row.principal || !timingSafeEqualHex(parts.secretHex, row.secretHex)) {
    throw failure('INVALID_CREDENTIALS');
  }
  return row;
}

export function ticketTtlMs() {
  return TICKET_TTL_MS;
}

export function ticketTableName() {
  return TICKET_TABLE;
}
