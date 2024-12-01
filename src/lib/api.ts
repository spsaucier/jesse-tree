import OAuth from "oauth-1.0a";
import crypto from "crypto";
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";
import fs from "fs/promises";
import path from "path";
import type { CardData } from "../types";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";

// API Keys
const NOUN_KEY = import.meta.env.NOUN_PROJECT_KEY;
const NOUN_SECRET = import.meta.env.NOUN_PROJECT_SECRET;
const BIBLE_API_KEY = import.meta.env.BIBLE_API_KEY;
const RAPID_API_KEY = import.meta.env.RAPID_API_KEY;

if (!NOUN_KEY || !NOUN_SECRET || !BIBLE_API_KEY || !RAPID_API_KEY) {
  throw new Error("Missing required environment variables");
}

// Initialize OAuth
const oauth = new OAuth({
  consumer: { key: NOUN_KEY, secret: NOUN_SECRET },
  signature_method: "HMAC-SHA1",
  hash_function(base_string: string, key: string) {
    return crypto.createHmac("sha1", key).update(base_string).digest("base64");
  },
});

// At the top, after imports
const DEBUG = import.meta.env.PROD !== true;

const CACHE_DIR = path.join(process.cwd(), ".cache");

async function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) {
    await mkdir(CACHE_DIR, { recursive: true });
  }
}

async function getCachedData<T>(cacheKey: string): Promise<T | null> {
  try {
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    if (existsSync(cachePath)) {
      const data = await fs.readFile(cachePath, "utf-8");
      return JSON.parse(data) as T;
    }
  } catch (error) {
    console.error(`Cache read error for ${cacheKey}:`, error);
  }
  return null;
}

async function setCachedData(cacheKey: string, data: any): Promise<void> {
  try {
    await ensureCacheDir();
    const cachePath = path.join(CACHE_DIR, `${cacheKey}.json`);
    await fs.writeFile(cachePath, JSON.stringify(data), "utf-8");
  } catch (error) {
    console.error(`Cache write error for ${cacheKey}:`, error);
  }
}

export async function getIcon(terms: string): Promise<string | null> {
  // Handle multiple terms separated by " or "
  const termArray = terms.split(" or ");
  const results = await Promise.all(
    termArray.map(async (term) => {
      const cacheKey = `icon_${term.toLowerCase().replace(/[^a-z0-9]/g, "_")}`;

      // Check cache first
      const cached = await getCachedData<{ thumbnail_url: string }>(cacheKey);
      if (cached) {
        if (DEBUG) console.log(`🎨 Using cached icon for: ${term}`);
        return cached.thumbnail_url;
      }

      if (DEBUG)
        console.log(`🎨 Fetching icon for: ${encodeURIComponent(term)}`);

      // Try Noun Project first
      const request_data = {
        url: `https://api.thenounproject.com/v2/icon?query=${encodeURIComponent(
          term
        )}&limit=1`,
        method: "GET",
      };

      const headers = oauth.toHeader(oauth.authorize(request_data));
      const response = await fetch(request_data.url, {
        headers: headers as unknown as Record<string, string>,
      });
      const data = (await response.json()) as {
        icons?: Array<{ thumbnail_url: string }>;
      };

      // If Noun Project has results, use them
      if (data.icons?.[0]) {
        const iconData = {
          thumbnail_url: data.icons[0].thumbnail_url.replace(
            "_200.png",
            "_512.png"
          ),
        };
        await setCachedData(cacheKey, iconData);
        return iconData.thumbnail_url;
      }

      // Fall back to Google Image API
      try {
        const googleResponse = await fetch(
          "https://google-image-grab-cheap-json.p.rapidapi.com/imgrabgooglev2",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-rapidapi-host": "google-image-grab-cheap-json.p.rapidapi.com",
              "x-rapidapi-key": RAPID_API_KEY!,
            },
            body: JSON.stringify({ keyword: term }),
          }
        );

        const googleData = (await googleResponse.json()) as GoogleImageResponse;

        if (googleData.success && googleData.data?.[0]?.url) {
          const iconData = { thumbnail_url: googleData.data[0].url };
          await setCachedData(cacheKey, iconData);
          return iconData.thumbnail_url;
        } else {
          console.error(
            "Google Image API error:",
            JSON.stringify(googleData, null, 2)
          );
        }
      } catch (error) {
        console.error("Google Image API error:", error);
      }

      if (DEBUG) {
        console.log(`📦 No icon found for ${term}`);
      }
      return null;
    })
  );

  // Filter out nulls and join with " or "
  const validResults = results.filter((url): url is string => url !== null);
  return validResults.length > 0 ? validResults.join(" or ") : null;
}

interface BibleApiResponse {
  reference: string;
  verses: Array<{ text: string }>;
  text: string;
  translation_id: string;
  translation_name: string;
}

export async function getVerse(reference: string) {
  const cacheKey = `verse_${reference
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")}`;

  // Check cache first
  const cached = await getCachedData<BibleApiResponse>(cacheKey);
  if (cached) {
    if (DEBUG) console.log(`📖 Using cached verse for: ${reference}`);
    return {
      content: cached.text || "Verse not found",
      reference: cached.reference || reference,
    };
  }

  if (DEBUG) console.log(`📖 Fetching verse: ${reference}`);

  try {
    const response = await fetch(
      `https://bible-api.com/${encodeURIComponent(reference)}`
    );

    if (!response.ok) {
      console.error(
        `Bible API error: ${response.status} ${response.statusText}`
      );
      return {
        content: `Error fetching verse: ${response.status}`,
        reference: reference,
      };
    }

    const data = (await response.json()) as BibleApiResponse;

    // Cache successful responses
    await setCachedData(cacheKey, data);

    if (DEBUG) {
      console.log(`📦 Verse response for ${reference}:`, {
        content: data.text?.slice(0, 50) + "..." || "Not found",
        reference: data.reference,
      });
    }

    return {
      content: data.text || "Verse not found",
      reference: data.reference || reference,
    };
  } catch (error) {
    console.error("Failed to fetch verse:", error);
    return {
      content: `Error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      reference: reference,
    };
  }
}

export async function getCardData(): Promise<CardData[]> {
  const csvContent = await fs.readFile(
    path.join(process.cwd(), "public", "Untitled spreadsheet - Sheet1.csv"),
    "utf-8"
  );

  const rows = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  });

  const cards = await Promise.all(
    rows.map(async (row: any) => {
      if (!row.Day) return null;

      const [iconUrl, verseData1, verseData2, verseData3] = await Promise.all([
        getIcon(row.Symbol),
        ...row.Reading.split(";").map(getVerse),
      ]);

      return {
        day: row.Day,
        person: row.Person,
        theme: row.Theme,
        reading: row.Reading,
        symbol: row.Symbol,
        iconUrl,
        verseContent: [verseData1, verseData2, verseData3]
          .filter(Boolean)
          .map((verse) => verse.content)
          .join("\n\n"),
      };
    })
  );

  return cards.filter((card): card is CardData => card !== null);
}

// Add near the top with other interfaces
interface GoogleImageResponse {
  success: boolean;
  data: Array<{
    url: string;
    thumbnail: string;
    title: string;
    width: number;
    height: number;
  }>;
  message: string;
}
