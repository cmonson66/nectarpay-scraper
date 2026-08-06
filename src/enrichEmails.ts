// Site harvester: emails + owner names from a business website.
// Fetches homepage, then contact page (if emails missing), then an
// about/team page (if no name found yet). Max 3 fetches per site.

export type SiteInfo = {
  emails: string[];
  ownerFirst: string | null;
  ownerLast: string | null;
  ownerSource: "site" | "email" | null;
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const JUNK = [
  /\.(png|jpe?g|gif|svg|webp|css|js)$/i,
  /@(example|sentry|wixpress|godaddy|domain)\./i,
  /^(noreply|no-reply|donotreply)@/i,
  /@[0-9]+x\./i,
];

// Addresses that are never a business contact: font-license emails embedded
// in site code (Impallari/Typesetit et al. taught us this), template
// placeholders, and abuse/postmaster roles. These are dropped ENTIRELY —
// unlike GENERIC_LOCALS below, which stay valid send targets (info@ is a
// real inbox) but never yield a person's name.
const EMAIL_JUNK_LOCALS = new Set([
  "impallari", "typesetit", "jonpinhorn", "amkryukov", "anapbm", "lemonad",
  "example", "test", "testing", "demo", "sample", "johndoe", "janedoe",
  "yourname", "youremail", "yourmail", "name", "your", "you", "user",
  "username", "email", "someone", "somebody",
  "abuse", "postmaster", "webmaster", "hostmaster", "mailer-daemon",
]);

function isJunkEmail(email: string): boolean {
  const local = email.split("@")[0];
  if (EMAIL_JUNK_LOCALS.has(local)) return true;
  if (local.startsWith("your")) return true;
  if (local.includes("example")) return true;
  return false;
}

// Local-parts that are roles, not people
const GENERIC_LOCALS = new Set([
  "info", "sales", "contact", "hello", "hi", "admin", "office", "support",
  "shop", "store", "orders", "order", "team", "help", "booking", "bookings",
  "mail", "email", "service", "services", "customerservice", "frontdesk",
  "inquiries", "enquiries", "marketing", "billing", "accounts", "account",
  "manager", "owner", "staff", "general", "questions", "media", "press",
  "careers", "jobs", "smoke", "vape", "cbd", "glass", "tobacco",
  "feedback", "collections", "events", "repairs", "reservations",
  "customercare", "financing", "studio", "weborders", "warranty",
  "returns", "wholesale", "partnerships", "donations", "catering",
]);

// Words that disqualify a "First Last" match as a person
const NAME_STOPWORDS = new Set([
  "Smoke", "Shop", "Vape", "Store", "Glass", "Tobacco", "Cbd", "Hookah",
  "Tattoo", "Barber", "Auto", "Jewelry", "Gold", "Pawn", "Gun", "Coffee",
  "Phoenix", "Arizona", "Tempe", "Mesa", "Scottsdale", "Tucson", "Chandler",
  "Gilbert", "Glendale", "Peoria", "Surprise", "Goodyear", "Avondale",
  "Queen", "Creek", "Flagstaff", "Prescott", "Valley", "Street", "Avenue",
  "Our", "The", "New", "Best", "Contact", "About", "Privacy", "Terms",
  "Shipping", "Returns", "Google", "Facebook", "Instagram", "Yelp",
]);

function cleanEmails(raw: string[]): string[] {
  const seen = new Set<string>();
  for (const e of raw) {
    const email = e.trim().toLowerCase().replace(/^mailto:/, "");
    if (JUNK.some((re) => re.test(email))) continue;
    if (isJunkEmail(email)) continue;
    if (email.length > 60) continue;
    seen.add(email);
  }
  return [...seen].slice(0, 3);
}

async function fetchHtml(url: string, timeoutMs = 8000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    });
    if (!res.ok) return "";
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("text/html")) return "";
    return await res.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

function findLinkedPage(homeUrl: string, html: string, keywords: RegExp): string | null {
  const hrefRe = new RegExp(`href=["']([^"']*(?:${keywords.source})[^"']*)["']`, "i");
  const m = hrefRe.exec(html);
  if (!m) return null;
  try {
    return new URL(m[1], homeUrl).toString();
  } catch {
    return null;
  }
}

function plausiblePerson(full: string): boolean {
  const parts = full.trim().split(/\s+/);
  if (parts.length !== 2) return false;
  if (parts.some((p) => NAME_STOPWORDS.has(p))) return false;
  if (parts.some((p) => p.length < 2 || p.length > 15)) return false;
  return true;
}

/** Look for an owner/founder name in page HTML. */
function extractOwnerName(html: string): { first: string; last: string } | null {
  // Strip tags so patterns can span markup boundaries
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, (m) => m) // keep scripts for JSON-LD pass
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  // 1) JSON-LD Person
  const jsonLd = /"@type"\s*:\s*"Person"[^}]{0,200}?"name"\s*:\s*"([^"]{4,40})"/.exec(text)
    ?? /"name"\s*:\s*"([^"]{4,40})"[^}]{0,200}?"@type"\s*:\s*"Person"/.exec(text);
  if (jsonLd && plausiblePerson(jsonLd[1])) {
    const [first, last] = jsonLd[1].trim().split(/\s+/);
    return { first, last };
  }

  const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  // 2) Labeled owner/founder patterns
  const patterns = [
    /[Oo]wner[:,]?\s+(?:is\s+)?([A-Z][a-z]+ [A-Z][a-z]+)/,
    /([A-Z][a-z]+ [A-Z][a-z]+)\s*,?\s+(?:the\s+)?[Oo]wner/,
    /[Ff]ounded\s+by\s+([A-Z][a-z]+ [A-Z][a-z]+)/,
    /[Oo]wned\s+(?:and\s+operated\s+)?by\s+([A-Z][a-z]+ [A-Z][a-z]+)/,
    /[Ff]ounder[:,]?\s+([A-Z][a-z]+ [A-Z][a-z]+)/,
    /[Mm]eet\s+(?:the\s+owner,?\s+)?([A-Z][a-z]+ [A-Z][a-z]+)/,
  ];
  for (const re of patterns) {
    const m = re.exec(plain);
    if (m && plausiblePerson(m[1])) {
      const [first, last] = m[1].trim().split(/\s+/);
      return { first, last };
    }
  }
  return null;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Derive a person name from an email local-part, if it looks human. */
export function nameFromEmail(
  email: string,
  businessName: string
): { first: string; last: string | null } | null {
  const local = email.split("@")[0].toLowerCase();
  if (GENERIC_LOCALS.has(local)) return null;
  if (local.endsWith("support") || local.endsWith("online")) return null;
  if (local.includes("orders") || local.includes("service")) return null;

  const bizNorm = businessName.toLowerCase().replace(/[^a-z]/g, "");

  // first.last / first_last
  const two = /^([a-z]{2,12})[._]([a-z]{2,15})$/.exec(local);
  if (two && !GENERIC_LOCALS.has(two[1]) && !GENERIC_LOCALS.has(two[2])) {
    return { first: cap(two[1]), last: cap(two[2]) };
  }

  // bare first name — reject if it overlaps the business name in either
  // direction (cloudnine@CloudNine, baxtersaz@Baxters),
  // EXCEPT true possessives: "tony" in "Tony's Tattoo" is the owner
  if (/^[a-z]{3,12}$/.test(local)) {
    const rawBiz = businessName.toLowerCase();
    const possessive = rawBiz.includes(`${local}'`) || rawBiz.includes(`${local}\u2019`);
    const overlaps =
      bizNorm.length >= 4 && (bizNorm.includes(local) || local.includes(bizNorm.slice(0, 6)));
    if (overlaps && !possessive) return null;
    return { first: cap(local), last: null };
  }
  return null;
}

/** Full site harvest: emails + owner name. */
export async function harvestSite(
  website: string,
  businessName: string
): Promise<SiteInfo> {
  const empty: SiteInfo = { emails: [], ownerFirst: null, ownerLast: null, ownerSource: null };
  if (!website) return empty;

  let homeUrl: string;
  try {
    homeUrl = new URL(website).toString();
  } catch {
    return empty;
  }

  const homeHtml = await fetchHtml(homeUrl);
  let emails = cleanEmails(homeHtml.match(EMAIL_RE) ?? []);
  let owner = extractOwnerName(homeHtml);

  if (emails.length === 0) {
    const contactUrl = findLinkedPage(homeUrl, homeHtml, /contact/);
    if (contactUrl) {
      const contactHtml = await fetchHtml(contactUrl);
      emails = cleanEmails(contactHtml.match(EMAIL_RE) ?? []);
      if (!owner) owner = extractOwnerName(contactHtml);
    }
  }

  if (!owner) {
    const aboutUrl = findLinkedPage(homeUrl, homeHtml, /about|team|our-story|meet/);
    if (aboutUrl) {
      const aboutHtml = await fetchHtml(aboutUrl);
      owner = extractOwnerName(aboutHtml);
    }
  }

  if (owner) {
    return { emails, ownerFirst: owner.first, ownerLast: owner.last, ownerSource: "site" };
  }

  // Fallback: derive from best email local-part
  for (const e of emails) {
    const derived = nameFromEmail(e, businessName);
    if (derived) {
      return { emails, ownerFirst: derived.first, ownerLast: derived.last, ownerSource: "email" };
    }
  }

  return { emails, ownerFirst: null, ownerLast: null, ownerSource: null };
}
