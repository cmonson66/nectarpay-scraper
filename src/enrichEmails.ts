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


// Email-derived names are only trusted when they're recognizably human.
// (Business-y locals kept inventing new shapes — Zpace, Wubcoffee, Woxvqgsk —
// so blocklists lost. Allowlist wins: unknown-but-real names just fall back
// to the business greeting, which costs nothing.)
const FIRST_NAMES = new Set(["aaron","abby","abigail","adam","ade","adrian","ahmed","aiden","aisha","al","alan","albert","alberto","alejandro","alex","alexa","alexander","alexis","alfred","alice","alicia","allen","allison","alyssa","amanda","amara","amber","amy","ana","andre","andrea","andres","andrew","andy","angel","angela","angelica","angie","anil","anita","anjali","ann","anna","anne","annette","annie","anthony","antonio","april","ariel","arjun","arnold","arthur","ashley","aubrey","austin","bao","barb","barbara","barry","beatriz","becky","ben","benjamin","bernard","beth","bethany","betty","beverly","bill","billy","blake","bob","bobby","bola","brad","bradley","brandi","brandon","brandy","brenda","brent","brett","brian","brianna","brittany","brooke","bruce","bryan","bryce","caitlin","caleb","calvin","cameron","camila","candice","carl","carla","carlos","carmen","carol","carole","carolina","caroline","carolyn","carrie","casey","cassandra","catherine","cathy","cecilia","cesar","chad","charlene","charles","charlie","charlotte","chase","chelsea","chen","cheryl","chidi","chris","christian","christina","christine","christopher","christy","cindy","claire","clara","clarence","claudia","clay","clayton","clifford","clint","clinton","cody","cole","colin","colleen","connie","connor","corey","cory","courtney","craig","cristian","crystal","curtis","cynthia","dale","dallas","dalton","damian","damon","dan","dana","daniel","danielle","danny","darlene","darnell","darrell","darren","darryl","dave","david","dawn","dean","deandre","deanna","debbie","deborah","debra","deepak","demetrius","denise","dennis","derek","derrick","desiree","destiny","devin","devon","diana","diane","diego","dillon","dominic","don","donald","donna","doris","dorothy","doug","douglas","drew","duane","dustin","dylan","earl","eben","ed","eddie","edgar","edith","eduardo","edward","edwin","elaine","eli","elias","elijah","elizabeth","ella","ellen","emily","emma","enrique","eric","erica","erik","erika","erin","ernest","esteban","esther","ethan","eugene","eva","evan","evelyn","everett","fatima","felipe","felix","feng","fernando","frances","francis","francisco","frank","fred","freddie","gabriel","gabriela","gail","garrett","garry","gary","gavin","gene","geoffrey","george","gerald","gerardo","gilbert","gina","glen","glenn","gloria","gordon","grace","grant","greg","gregory","guadalupe","guillermo","gustavo","guy","hailey","haley","hannah","harold","harry","haru","harvey","hassan","heather","hector","heidi","helen","henry","herbert","hiroshi","holly","hope","howard","hugo","hunter","hyun","ian","imani","irene","iris","isaac","isabel","isaiah","ivan","jack","jackie","jackson","jacob","jacqueline","jae","jaime","jake","jamal","james","jamie","jan","jana","jane","janet","janice","jared","jasmine","jason","javier","jay","jean","jeanette","jeff","jeffery","jeffrey","jenna","jennifer","jenny","jeremiah","jeremy","jermaine","jerome","jerry","jesse","jessica","jesus","jill","jim","jimmy","jing","jisoo","joan","joann","joanna","joanne","joaquin","jodi","jody","joe","joel","joey","john","johnny","jon","jonathan","jordan","jorge","jose","josef","joseph","josh","joshua","josue","joy","joyce","juan","juanita","judith","judy","julia","julian","julie","julio","justin","kaitlyn","kara","karen","kari","karim","karl","karla","kate","katelyn","katherine","kathleen","kathryn","kathy","katie","katrina","kavita","kay","kayla","keisha","keith","kelli","kellie","kelly","kelsey","ken","kendall","kendra","kenji","kenneth","kenny","kent","kevin","kim","kimberly","kiran","kirk","kris","krista","kristen","kristi","kristin","kristina","kristy","kurt","kwame","kyle","kylie","lance","larry","latoya","laura","lauren","laurie","lawrence","layla","leah","lee","leo","leon","leonard","leonardo","leslie","levi","lewis","lian","libby","lily","linda","lindsay","lindsey","ling","lisa","lloyd","logan","lois","lonnie","lorena","lori","lorraine","louis","louise","lucas","luis","luke","luz","lydia","lynn","mackenzie","madison","malik","manuel","marc","marcia","marco","marcos","marcus","margaret","maria","mariah","marie","marilyn","mario","marion","marisol","marissa","mark","marlene","marsha","marshall","martha","martin","marvin","mary","mason","mathew","matt","matthew","maurice","max","maxwell","meera","megan","mei","melanie","melinda","melissa","melody","melvin","mercedes","meredith","micah","michael","micheal","michele","michelle","miguel","mike","mindy","minjun","miranda","miriam","misty","mitchell","molly","monica","morgan","nancy","naomi","natalie","natasha","nathan","nathaniel","neha","neil","nelson","nia","nicholas","nick","nicolas","nicole","nikhil","nina","noah","noel","noor","nora","norma","norman","obi","oliver","olivia","omar","oscar","oshea","owen","pablo","paige","pam","pamela","pat","patricia","patrick","patti","paul","paula","pedro","peggy","penny","perry","pete","peter","phil","philip","phillip","phyllis","preston","priscilla","priya","rachael","rachel","rafael","rajesh","ralph","ramon","randall","randi","randy","rania","rasheed","raul","ray","raymond","rebecca","regina","reginald","renee","rex","rhonda","ricardo","richard","rick","ricky","rita","ritu","rob","robert","roberta","roberto","robin","robyn","rochelle","rocky","rodney","roger","rohit","roland","rolando","roman","ron","ronald","ronnie","rosa","rose","ross","roxanne","roy","ruben","ruby","russell","rusty","ruth","ryan","sabrina","sakura","sally","salvador","sam","samantha","sameer","samir","samuel","sandra","sandy","sanjay","santiago","sara","sarah","scott","sean","sebastian","seojun","sergio","seth","shane","shanice","shannon","sharon","shaun","shauna","shawn","sheila","shelby","shelia","shelley","shelly","sheri","sherri","sherry","shirley","sidney","sierra","simon","sonia","sonya","sophia","spencer","stacey","stacy","stan","stanley","stefanie","stephanie","stephen","steve","steven","stuart","sue","summer","sunil","susan","suzanne","sydney","sylvia","tabitha","takeshi","tamara","tami","tamika","tammy","tanner","tanya","tara","tariq","taylor","ted","terence","teresa","teri","terrance","terrell","terrence","terri","terry","thelma","theodore","theresa","thomas","tiffany","tim","timothy","tina","toby","todd","tom","tommy","toni","tony","tonya","tracey","traci","tracy","travis","trent","trevor","trey","tricia","trisha","tristan","troy","tunde","tyler","tyrell","tyrone","valerie","vanessa","vernon","veronica","vicki","vickie","victor","victoria","vikram","vincent","virginia","vivian","wade","walter","wanda","warren","wayne","wei","weldon","wendy","wes","wesley","whitney","will","willa","william","willie","wilson","wyatt","xavier","yesenia","ying","yolanda","yuki","yuna","yusuf","yvette","yvonne","zach","zachary","zack","zainab","zane","zaria","zoe"]);

const JUNK_DOMAINS = /@(mailparser\.io|mailinator\.com|mailinater|tempmail|10minutemail|guerrillamail|yopmail|xxx\.xxx|doe\.com|domain\.com|yourdomain)/i;

const FREE_MAIL = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
  "icloud.com", "me.com", "live.com", "msn.com", "comcast.net", "cox.net",
  "protonmail.com", "proton.me", "mail.com", "gmx.com", "ymail.com",
]);

/** Registrable-ish domain: host minus www. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Third-party addresses (web agencies, franchise HQs) get scraped off
 * business sites constantly — eben@eyebytes.com is a web designer, not a
 * hookah lounge owner. Keep an address only when its domain matches the
 * business's own site, or it's a free provider (the owner's personal box).
 */
function addressBelongsToBusiness(email: string, website: string): boolean {
  const site = hostOf(website);
  if (!site) return true; // no site to compare against
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (!domain) return false;
  if (FREE_MAIL.has(domain)) return true;
  const root = (d: string) => d.split(".").slice(-2).join(".");
  return root(domain) === root(site);
}

function isJunkEmail(email: string): boolean {
  const local = email.split("@")[0];
  if (EMAIL_JUNK_LOCALS.has(local)) return true;
  if (local.startsWith("your")) return true;
  if (local.includes("example")) return true;
  if (JUNK_DOMAINS.test(email)) return true;
  if (/^(x{2,}|test\d*)$/.test(local)) return true;
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
  "Your", "Meet", "Team", "Press", "Site", "Privacy", "Legal",
  "Events", "Repairs", "Services", "Staff", "Crew", "Family",
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
  // Site headings produced "Return", "Story", "Responsible" — the first
  // token has to be a recognizable human name, same bar as email-derived.
  if (!FIRST_NAMES.has(parts[0].toLowerCase())) return false;
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

  // first.last / first_last — first token must be a recognizable name
  const two = /^([a-z]{2,12})[._]([a-z]{2,15})$/.exec(local);
  if (two && FIRST_NAMES.has(two[1]) && !GENERIC_LOCALS.has(two[2])) {
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
    if (!FIRST_NAMES.has(local)) return null; // human names only
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

  const belongs = (list: string[]) =>
    list.filter((e) => addressBelongsToBusiness(e, website));

  const homeHtml = await fetchHtml(homeUrl);
  let emails = belongs(cleanEmails(homeHtml.match(EMAIL_RE) ?? []));
  let owner = extractOwnerName(homeHtml);

  if (emails.length === 0) {
    const contactUrl = findLinkedPage(homeUrl, homeHtml, /contact/);
    if (contactUrl) {
      const contactHtml = await fetchHtml(contactUrl);
      emails = belongs(cleanEmails(contactHtml.match(EMAIL_RE) ?? []));
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
