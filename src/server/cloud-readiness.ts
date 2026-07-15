import type { PgAdapterAsync } from "../db/remote-storage.js";

type ColumnSpec = Readonly<Record<string, readonly [dataType: string, nullable: boolean]>>;

const REQUIRED_COLUMNS: Readonly<Record<string, ColumnSpec>> = {
  projects: {
    id: ["text", false], name: ["text", false], path: ["text", false],
    description: ["text", true], created_at: ["text", false], updated_at: ["text", false],
  },
  agents: {
    id: ["text", false], name: ["text", false], description: ["text", true],
    role: ["text", true], metadata: ["text", true], created_at: ["text", false],
    last_seen_at: ["text", false], active_project_id: ["text", true],
  },
  recordings: {
    id: ["text", false], audio_path: ["text", true], raw_text: ["text", false],
    processed_text: ["text", true], processing_mode: ["text", false],
    model_used: ["text", false], enhancement_model: ["text", true],
    duration_ms: ["integer", true], language: ["text", true], tags: ["text", true],
    agent_id: ["text", true], project_id: ["text", true], session_id: ["text", true],
    goal: ["text", true], role: ["text", true], task_list_id: ["text", true],
    machine_id: ["text", true], metadata: ["text", true], created_at: ["text", false],
  },
  recording_tags: { recording_id: ["text", false], tag: ["text", false] },
  feedback: {
    id: ["text", false], message: ["text", false], email: ["text", true],
    category: ["text", true], version: ["text", true], machine_id: ["text", true],
    created_at: ["text", false],
  },
  api_keys: {
    kid: ["text", false], app: ["text", false], agent: ["text", true],
    scopes: ["jsonb", false], token_hash: ["text", false],
    issued_at: ["timestamp with time zone", false], expires_at: ["timestamp with time zone", true],
    revoked_at: ["timestamp with time zone", true], revoked_reason: ["text", true],
    last_used_at: ["timestamp with time zone", true], created_by: ["text", true],
    created_at: ["timestamp with time zone", false],
  },
  recording_idempotency: {
    principal: ["text", false], idempotency_key: ["text", false],
    request_fingerprint: ["text", false], recording_id: ["text", true],
    created_at: ["text", false],
  },
};

const REQUIRED_CLOUD_TABLES = Object.keys(REQUIRED_COLUMNS);

interface CatalogColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

interface CatalogConstraintRow {
  table_name: string;
  constraint_type: string;
  is_validated: boolean;
  is_deferrable: boolean;
  is_deferred: boolean;
  columns: string[];
  referenced_schema: string | null;
  referenced_table: string | null;
  referenced_columns: string[];
  delete_action: string | null;
  update_action: string | null;
  match_type: string | null;
}

interface CatalogUniqueIndexRow {
  table_name: string;
  is_primary: boolean;
  is_unique: boolean;
  is_valid: boolean;
  is_ready: boolean;
  nulls_not_distinct: boolean;
  predicate: string | null;
  columns: string[];
}

interface CloudRoleReadinessRow {
  [key: string]: boolean | null;
}

function sameColumns(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
}

interface ConstraintSpec {
  type: "p" | "u" | "f";
  columns: readonly string[];
  referencedTable?: string;
  referencedColumns?: readonly string[];
  deleteAction?: "c" | "n";
}

const REQUIRED_CONSTRAINTS: Readonly<Record<string, readonly ConstraintSpec[]>> = {
  projects: [
    { type: "p", columns: ["id"] },
    { type: "u", columns: ["path"] },
  ],
  agents: [
    { type: "p", columns: ["id"] },
    { type: "u", columns: ["name"] },
    {
      type: "f", columns: ["active_project_id"], referencedTable: "projects",
      referencedColumns: ["id"], deleteAction: "n",
    },
  ],
  recordings: [
    { type: "p", columns: ["id"] },
    {
      type: "f", columns: ["agent_id"], referencedTable: "agents",
      referencedColumns: ["id"], deleteAction: "n",
    },
    {
      type: "f", columns: ["project_id"], referencedTable: "projects",
      referencedColumns: ["id"], deleteAction: "n",
    },
  ],
  recording_tags: [
    { type: "p", columns: ["recording_id", "tag"] },
    {
      type: "f", columns: ["recording_id"], referencedTable: "recordings",
      referencedColumns: ["id"], deleteAction: "c",
    },
  ],
  feedback: [{ type: "p", columns: ["id"] }],
  api_keys: [
    { type: "p", columns: ["kid"] },
    { type: "u", columns: ["token_hash"] },
  ],
  recording_idempotency: [
    { type: "p", columns: ["principal", "idempotency_key"] },
    { type: "u", columns: ["recording_id"] },
    {
      type: "f", columns: ["recording_id"], referencedTable: "recordings",
      referencedColumns: ["id"], deleteAction: "n",
    },
  ],
};

interface UniqueIndexSpec {
  primary: boolean;
  columns: readonly string[];
}

const REQUIRED_UNIQUE_INDEXES: Readonly<Record<string, readonly UniqueIndexSpec[]>> = {
  projects: [{ primary: true, columns: ["id"] }, { primary: false, columns: ["path"] }],
  agents: [{ primary: true, columns: ["id"] }, { primary: false, columns: ["name"] }],
  recordings: [{ primary: true, columns: ["id"] }],
  recording_tags: [{ primary: true, columns: ["recording_id", "tag"] }],
  feedback: [{ primary: true, columns: ["id"] }],
  api_keys: [{ primary: true, columns: ["kid"] }, { primary: false, columns: ["token_hash"] }],
  recording_idempotency: [
    { primary: true, columns: ["principal", "idempotency_key"] },
    { primary: false, columns: ["recording_id"] },
  ],
};

function constraintMatches(actual: CatalogConstraintRow, expected: ConstraintSpec): boolean {
  if (!actual.is_validated || actual.is_deferrable || actual.is_deferred || actual.constraint_type !== expected.type ||
      !sameColumns(actual.columns, [...expected.columns])) return false;
  if (expected.type !== "f") {
    return actual.referenced_schema === null && actual.referenced_table === null &&
      actual.referenced_columns.length === 0 && actual.delete_action === null &&
      actual.update_action === null && actual.match_type === null;
  }
  return actual.referenced_schema === "public" && actual.referenced_table === expected.referencedTable &&
    sameColumns(actual.referenced_columns, [...(expected.referencedColumns ?? [])]) &&
    actual.delete_action === expected.deleteAction && actual.update_action === "a" && actual.match_type === "s";
}

function uniqueIndexMatches(actual: CatalogUniqueIndexRow, expected: UniqueIndexSpec): boolean {
  return actual.is_primary === expected.primary && actual.is_unique && actual.is_valid && actual.is_ready &&
    !actual.nulls_not_distinct && actual.predicate === null &&
    sameColumns(actual.columns, [...expected.columns]);
}

/** Validate the schema shape without imposing request-role privilege restrictions. */
export async function assertCloudSchemaContract(
  pg: Pick<PgAdapterAsync, "all">,
): Promise<void> {
  const columns = (await pg.all(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY (ARRAY[${REQUIRED_CLOUD_TABLES.map((table) => `'${table}'`).join(", ")}])`,
  )) as CatalogColumnRow[];
  const indexedColumns = new Map(columns.map((column) => [`${column.table_name}.${column.column_name}`, column]));

  for (const [table, expectedColumns] of Object.entries(REQUIRED_COLUMNS)) {
    for (const [column, [dataType, nullable]] of Object.entries(expectedColumns)) {
      const actual = indexedColumns.get(`${table}.${column}`);
      if (!actual) throw new Error(`cloud schema is missing required column: ${table}.${column}`);
      if (actual.data_type !== dataType || (actual.is_nullable === "YES") !== nullable) {
        throw new Error(
          `cloud schema has incompatible column: ${table}.${column} must be ${dataType} ${nullable ? "NULL" : "NOT NULL"}`,
        );
      }
    }
  }
  const idempotencyColumns = columns.filter((column) => column.table_name === "recording_idempotency");
  const expectedIdempotencyColumns = Object.keys(REQUIRED_COLUMNS.recording_idempotency!);
  const unexpectedIdempotencyColumn = idempotencyColumns.find(
    (column) => !expectedIdempotencyColumns.includes(column.column_name),
  );
  if (unexpectedIdempotencyColumn) {
    throw new Error(
      `cloud schema has unexpected column: recording_idempotency.${unexpectedIdempotencyColumn.column_name}`,
    );
  }

  const constraints = (await pg.all(
    `SELECT table_row.relname AS table_name,
            constraint_row.contype::text AS constraint_type,
            constraint_row.convalidated AS is_validated,
            constraint_row.condeferrable AS is_deferrable,
            constraint_row.condeferred AS is_deferred,
            ARRAY(
              SELECT attribute_row.attname
                FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_row(attnum, position)
                JOIN pg_attribute attribute_row
                  ON attribute_row.attrelid = constraint_row.conrelid
                 AND attribute_row.attnum = key_row.attnum
               ORDER BY key_row.position
            ) AS columns,
            referenced_namespace.nspname AS referenced_schema,
            referenced_table.relname AS referenced_table,
            CASE WHEN constraint_row.confrelid = 0 THEN ARRAY[]::text[] ELSE ARRAY(
              SELECT attribute_row.attname
                FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key_row(attnum, position)
                JOIN pg_attribute attribute_row
                  ON attribute_row.attrelid = constraint_row.confrelid
                 AND attribute_row.attnum = key_row.attnum
               ORDER BY key_row.position
            ) END AS referenced_columns,
            NULLIF(constraint_row.confdeltype::text, ' ') AS delete_action,
            NULLIF(constraint_row.confupdtype::text, ' ') AS update_action,
            NULLIF(constraint_row.confmatchtype::text, ' ') AS match_type
       FROM pg_constraint constraint_row
       JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
       JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
       LEFT JOIN pg_class referenced_table ON referenced_table.oid = constraint_row.confrelid
       LEFT JOIN pg_namespace referenced_namespace ON referenced_namespace.oid = referenced_table.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND table_row.relname = ANY (ARRAY[${Object.keys(REQUIRED_CONSTRAINTS).map((table) => `'${table}'`).join(", ")}])
        AND constraint_row.contype IN ('p', 'u', 'f')`,
  )) as CatalogConstraintRow[];

  for (const [table, expectedConstraints] of Object.entries(REQUIRED_CONSTRAINTS)) {
    const actualConstraints = constraints.filter((constraint) => constraint.table_name === table);
    const exact = actualConstraints.length === expectedConstraints.length &&
      expectedConstraints.every((expected) =>
        actualConstraints.some((actual) => constraintMatches(actual, expected))
      );
    if (!exact) {
      throw new Error(`cloud schema has incompatible ${table} constraints`);
    }
  }

  const uniqueIndexes = (await pg.all(
    `SELECT table_row.relname AS table_name,
            index_row.indisprimary AS is_primary,
            index_row.indisunique AS is_unique,
            index_row.indisvalid AS is_valid,
            index_row.indisready AS is_ready,
            COALESCE((to_jsonb(index_row)->>'indnullsnotdistinct')::boolean, false) AS nulls_not_distinct,
            pg_get_expr(index_row.indpred, index_row.indrelid) AS predicate,
            ARRAY(
              SELECT attribute_row.attname
                FROM unnest(index_row.indkey::smallint[]) WITH ORDINALITY AS key_row(attnum, position)
                JOIN pg_attribute attribute_row
                  ON attribute_row.attrelid = index_row.indrelid
                 AND attribute_row.attnum = key_row.attnum
               WHERE key_row.position <= index_row.indnkeyatts
               ORDER BY key_row.position
            ) AS columns
       FROM pg_index index_row
       JOIN pg_class table_row ON table_row.oid = index_row.indrelid
       JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND table_row.relname = ANY (ARRAY[${Object.keys(REQUIRED_UNIQUE_INDEXES).map((table) => `'${table}'`).join(", ")}])
        AND index_row.indisunique`,
  )) as CatalogUniqueIndexRow[];
  for (const [table, expectedIndexes] of Object.entries(REQUIRED_UNIQUE_INDEXES)) {
    const actualIndexes = uniqueIndexes.filter((index) => index.table_name === table);
    const exact = actualIndexes.length === expectedIndexes.length &&
      expectedIndexes.every((expected) =>
        actualIndexes.some((actual) => uniqueIndexMatches(actual, expected))
      );
    if (!exact) {
      throw new Error(`cloud schema has incompatible ${table} unique indexes`);
    }
  }
}

/** Verify the complete schema and the request role's least-privilege contract. */
export async function assertCloudSchemaReady(
  pg: Pick<PgAdapterAsync, "all" | "get">,
): Promise<void> {
  await assertCloudSchemaContract(pg);
  const row = (await pg.get(
    `SELECT
       COALESCE((SELECT role_row.rolsuper FROM pg_roles role_row WHERE role_row.rolname = current_user), false) AS is_superuser,
       COALESCE((SELECT role_row.rolcreaterole FROM pg_roles role_row WHERE role_row.rolname = current_user), false) AS can_create_role,
       COALESCE((SELECT role_row.rolcreatedb FROM pg_roles role_row WHERE role_row.rolname = current_user), false) AS can_create_database,
       COALESCE((SELECT role_row.rolreplication FROM pg_roles role_row WHERE role_row.rolname = current_user), false) AS can_replicate,
       COALESCE((SELECT role_row.rolbypassrls FROM pg_roles role_row WHERE role_row.rolname = current_user), false) AS can_bypass_rls,
       has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_in_database,
       has_database_privilege(current_user, current_database(), 'TEMPORARY') AS can_create_temporary_tables,
       EXISTS (
         SELECT 1 FROM pg_namespace schema_row
          WHERE schema_row.nspname !~ '^pg_'
            AND schema_row.nspname <> 'information_schema'
            AND pg_has_role(current_user, schema_row.nspowner, 'MEMBER')
       ) AS owns_user_schema,
       EXISTS (
         SELECT 1 FROM pg_namespace schema_row
          WHERE schema_row.nspname !~ '^pg_'
            AND schema_row.nspname <> 'information_schema'
            AND has_schema_privilege(current_user, schema_row.oid, 'CREATE')
       ) AS can_create_in_user_schema,
       has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_public,
       EXISTS (
         SELECT 1
           FROM pg_class table_row
           JOIN pg_namespace schema_row ON schema_row.oid = table_row.relnamespace
          WHERE schema_row.nspname !~ '^pg_'
            AND schema_row.nspname <> 'information_schema'
            AND table_row.relkind IN ('r', 'p')
            AND pg_has_role(current_user, table_row.relowner, 'MEMBER')
       ) AS owns_user_table,
       has_table_privilege(current_user, 'public.recordings', 'SELECT') AND
         has_table_privilege(current_user, 'public.recordings', 'INSERT') AND
         has_table_privilege(current_user, 'public.recordings', 'DELETE') AS can_recordings,
       has_table_privilege(current_user, 'public.recordings', 'UPDATE') OR
         has_any_column_privilege(current_user, 'public.recordings', 'UPDATE') OR
         has_table_privilege(current_user, 'public.recordings', 'TRUNCATE') OR
         has_table_privilege(current_user, 'public.recordings', 'REFERENCES') OR
         has_any_column_privilege(current_user, 'public.recordings', 'REFERENCES') OR
         has_table_privilege(current_user, 'public.recordings', 'TRIGGER') AS has_extra_recordings_privileges,
       has_table_privilege(current_user, 'public.recording_tags', 'SELECT') AND
         has_table_privilege(current_user, 'public.recording_tags', 'INSERT') AS can_recording_tags,
       has_table_privilege(current_user, 'public.recording_tags', 'UPDATE') OR
         has_any_column_privilege(current_user, 'public.recording_tags', 'UPDATE') OR
         has_table_privilege(current_user, 'public.recording_tags', 'DELETE') OR
         has_table_privilege(current_user, 'public.recording_tags', 'TRUNCATE') OR
         has_table_privilege(current_user, 'public.recording_tags', 'REFERENCES') OR
         has_any_column_privilege(current_user, 'public.recording_tags', 'REFERENCES') OR
         has_table_privilege(current_user, 'public.recording_tags', 'TRIGGER') AS has_extra_recording_tags_privileges,
       has_table_privilege(current_user, 'public.agents', 'SELECT') AND
         has_table_privilege(current_user, 'public.agents', 'INSERT') AND
         has_table_privilege(current_user, 'public.agents', 'UPDATE') AS can_agents,
       has_table_privilege(current_user, 'public.agents', 'DELETE') OR
         has_table_privilege(current_user, 'public.agents', 'TRUNCATE') OR
         has_table_privilege(current_user, 'public.agents', 'REFERENCES') OR
         has_any_column_privilege(current_user, 'public.agents', 'REFERENCES') OR
         has_table_privilege(current_user, 'public.agents', 'TRIGGER') AS has_extra_agents_privileges,
       has_table_privilege(current_user, 'public.projects', 'SELECT') AND
         has_table_privilege(current_user, 'public.projects', 'INSERT') AND
         has_table_privilege(current_user, 'public.projects', 'UPDATE') AS can_projects,
       has_table_privilege(current_user, 'public.projects', 'DELETE') OR
         has_table_privilege(current_user, 'public.projects', 'TRUNCATE') OR
         has_table_privilege(current_user, 'public.projects', 'REFERENCES') OR
         has_any_column_privilege(current_user, 'public.projects', 'REFERENCES') OR
         has_table_privilege(current_user, 'public.projects', 'TRIGGER') AS has_extra_projects_privileges,
       has_table_privilege(current_user, 'public.feedback', 'INSERT') AS can_feedback,
       has_table_privilege(current_user, 'public.feedback', 'SELECT') OR
         has_any_column_privilege(current_user, 'public.feedback', 'SELECT') OR
         has_table_privilege(current_user, 'public.feedback', 'UPDATE') OR
         has_any_column_privilege(current_user, 'public.feedback', 'UPDATE') OR
         has_table_privilege(current_user, 'public.feedback', 'DELETE') OR
         has_table_privilege(current_user, 'public.feedback', 'TRUNCATE') OR
         has_table_privilege(current_user, 'public.feedback', 'REFERENCES') OR
         has_any_column_privilege(current_user, 'public.feedback', 'REFERENCES') OR
         has_table_privilege(current_user, 'public.feedback', 'TRIGGER') AS has_extra_feedback_privileges,
       has_table_privilege(current_user, 'public.api_keys', 'SELECT') AS can_api_keys,
       has_table_privilege(current_user, 'public.api_keys', 'INSERT') OR
         has_any_column_privilege(current_user, 'public.api_keys', 'INSERT') OR
         has_table_privilege(current_user, 'public.api_keys', 'UPDATE') OR
         has_any_column_privilege(current_user, 'public.api_keys', 'UPDATE') OR
         has_table_privilege(current_user, 'public.api_keys', 'DELETE') OR
         has_table_privilege(current_user, 'public.api_keys', 'TRUNCATE') OR
         has_table_privilege(current_user, 'public.api_keys', 'REFERENCES') OR
         has_any_column_privilege(current_user, 'public.api_keys', 'REFERENCES') OR
         has_table_privilege(current_user, 'public.api_keys', 'TRIGGER') AS has_extra_api_keys_privileges,
       has_table_privilege(current_user, 'public.recording_idempotency', 'SELECT') AND
         has_table_privilege(current_user, 'public.recording_idempotency', 'INSERT') AS can_recording_idempotency,
       has_table_privilege(current_user, 'public.recording_idempotency', 'UPDATE') OR
         has_any_column_privilege(current_user, 'public.recording_idempotency', 'UPDATE') OR
         has_table_privilege(current_user, 'public.recording_idempotency', 'DELETE') OR
         has_table_privilege(current_user, 'public.recording_idempotency', 'TRUNCATE') OR
         has_table_privilege(current_user, 'public.recording_idempotency', 'REFERENCES') OR
         has_any_column_privilege(current_user, 'public.recording_idempotency', 'REFERENCES') OR
         has_table_privilege(current_user, 'public.recording_idempotency', 'TRIGGER') AS has_extra_recording_idempotency_privileges`,
  )) as CloudRoleReadinessRow | null;

  if (
    row?.is_superuser || row?.can_create_role || row?.can_create_database || row?.can_replicate ||
    row?.can_bypass_rls || row?.can_create_in_database || row?.can_create_temporary_tables || row?.owns_user_schema ||
    row?.can_create_in_user_schema || row?.owns_user_table
  ) {
    throw new Error("cloud database request role violates the DML-only privilege contract");
  }
  if (!row?.can_use_public) {
    throw new Error("cloud database role lacks required public schema USAGE privilege");
  }
  const denied = REQUIRED_CLOUD_TABLES.filter((table) => !row?.[`can_${table}`]);
  if (denied.length > 0) {
    throw new Error(`cloud database role lacks required DML privileges: ${denied.join(", ")}`);
  }
  const excessive = REQUIRED_CLOUD_TABLES.filter((table) => row?.[`has_extra_${table}_privileges`]);
  if (excessive.length > 0) {
    throw new Error(`cloud database role has surplus table privileges beyond runtime use: ${excessive.join(", ")}`);
  }
}

/** Connectivity-only probe. Safe before a fresh or pending schema migration. */
export async function pingCloudConnectivity(pg: Pick<PgAdapterAsync, "get">): Promise<boolean> {
  const res = (await pg.get("SELECT 1 as ok")) as { ok: number } | null;
  if (Number(res?.ok) !== 1) throw new Error("cloud database ping failed");
  return true;
}

/** Full runtime readiness: connectivity, schema shape, and DML-only role posture. */
export async function pingCloudReadiness(
  pg: Pick<PgAdapterAsync, "all" | "get">,
): Promise<boolean> {
  await pingCloudConnectivity(pg);
  await assertCloudSchemaReady(pg);
  return true;
}
