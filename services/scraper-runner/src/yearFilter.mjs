function parseYearFromPtBrDate(s) {
  if (!s) return null;
  const m = String(s).trim().match(/(\d{4})/);
  if (m) {
    const y = Number(m[1]);
    return Number.isFinite(y) ? y : null;
  }
  const ddmmyyyy = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (ddmmyyyy) return Number(ddmmyyyy[3]) || null;
  return null;
}

export function filterEditaisCurrentYear(editais) {
  const year = new Date().getFullYear();
  return (editais || []).filter((e) => {
    const yPub = parseYearFromPtBrDate(e?.dataPublicacao);
    const yEnc = parseYearFromPtBrDate(e?.dataEncerramento);
    const y = yEnc ?? yPub ?? null;
    if (y === null) return true;
    return y === year;
  });
}

