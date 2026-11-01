export const sqlLit = (v: string | number | null) => v === null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + v.replace(/'/g, "''") + "'";
export const inline = (sql: string, p: (string | number | null)[]) => { let i = 0; return sql.replace(/\?/g, () => sqlLit(p[i++]!)); };
