// Feature detection for database objects that may not be applied yet (a newer migration
// than the project's database): the apps fall back instead of showing an error.

type Err = { code?: string; message?: string } | null | undefined;

/** True when the error says the RPC (or a table/column/bucket it needs) doesn't exist yet. */
export function isMissing(error: Err): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (code === "PGRST202" || code === "PGRST205" || code === "42883" || code === "42P01" || code === "42703") return true;
  return /could not find the (function|table)|does not exist|bucket not found/i.test(error.message ?? "");
}
