/** Converte DD/MM/YYYY (ou texto com data BR) para ISO YYYY-MM-DD aceito pelo Postgres. */
export function normalizeDateForPostgres(value) {
  if (value == null || value === "") return null;
  const s = String(value).trim();
  if (!s) return null;

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const br = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) {
    const dd = br[1].padStart(2, "0");
    const mm = br[2].padStart(2, "0");
    const yyyy = br[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  const embedded = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (embedded) {
    const dd = embedded[1].padStart(2, "0");
    const mm = embedded[2].padStart(2, "0");
    const yyyy = embedded[3];
    return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}
