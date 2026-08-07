import { writeFileSync } from "node:fs";
import type { Lead } from "./types.js";

const HEADERS = [
  "band",
  "score",
  "vertical",
  "name",
  "owner_name",
  "address",
  "city",
  "phone",
  "emails",
  "website",
  "rating",
  "review_count",
  "source_query",
  "place_id",
  "scraped_at",
  "vertical_key",
  "latitude",
  "longitude",
  "owner_first",
  "owner_last",
  "owner_source",
];

function esc(v: string | number | null): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function writeCsv(path: string, leads: Lead[]): void {
  const rows = leads.map((l) =>
    [
      l.band,
      l.score,
      l.vertical_label,
      l.name,
      [l.owner_first_name, l.owner_last_name].filter(Boolean).join(" "),
      l.address,
      l.city,
      l.phone,
      l.emails.join("; "),
      l.website,
      l.rating ?? "",
      l.review_count,
      l.source_query,
      l.place_id,
      l.scraped_at,
      l.vertical,
      l.latitude ?? "",
      l.longitude ?? "",
      l.owner_first_name ?? "",
      l.owner_last_name ?? "",
      l.owner_name_source ?? "",
    ]
      .map(esc)
      .join(",")
  );
  // \ufeff BOM so Excel opens UTF-8 correctly on Windows
  writeFileSync(path, "\ufeff" + [HEADERS.join(","), ...rows].join("\r\n"), "utf8");
}
