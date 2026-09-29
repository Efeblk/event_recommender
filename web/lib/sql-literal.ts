/** Explicit PostgreSQL escape literal, independent of session string settings. */
export function sqlLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('SQL text cannot contain a zero byte');
  return "E'" + value.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}
