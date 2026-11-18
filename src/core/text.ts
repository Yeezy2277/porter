/** Small text helpers shared by the transform and the checks. No HTML parsing here. */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  euro: "€",
  pound: "£",
  yen: "¥",
  copy: "©",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  agrave: "à",
  atilde: "ã",
  otilde: "õ",
  ccedil: "ç",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
};

/** Decodes the HTML entities WordPress emits in titles and excerpts (named, decimal, hex). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return NAMED[code.toLowerCase()] ?? whole;
  });
}

/** Lowercase words with accents and punctuation removed: what "the same text" means for the checks. */
export function words(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function slugify(s: string): string {
  return words(s).join("-");
}
