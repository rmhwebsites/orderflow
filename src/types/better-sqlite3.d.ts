// Minimal local declarations for better-sqlite3: the package ships no types and
// @types/better-sqlite3 is intentionally not installed (no new dependencies).
// Covers only the surface the tests use.
declare module "better-sqlite3" {
  class Statement {
    run(...params: Array<string | number | bigint | null>): {
      changes: number;
      lastInsertRowid: number | bigint;
    };
    all(...params: Array<string | number | bigint | null>): unknown[];
    get(...params: Array<string | number | bigint | null>): unknown;
  }
  class Database {
    constructor(filename: string, options?: { readonly?: boolean });
    prepare(sql: string): Statement;
    pragma(source: string): unknown;
    close(): this;
  }
  export = Database;
}
