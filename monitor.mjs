import fs from "fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK;
if (!WEBHOOK) {
  console.error("Missing DISCORD_WEBHOOK secret");
  process.exit(1);
}

const BASE = "https://7origin.netmarble.com/en/";
const STATE_FILE = "state.json";
const GOLD = 15844367;

// ---------- state ----------
let state = { news: null, notices: null, dev: null };
const hadStateFile = fs.existsSync(STATE_FILE);

if (hadStateFile) {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    // keep defaults
  }
}

// bootstrap si pas de state.json, ou si state vide
const isBootstrap =
  !hadStateFile || (!state.news && !state.notices && !state.dev);

// ---------- helpers ----------
function absUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `https://7origin.netmarble.com${href}`;
  return `https://7origin.netmarble.com/${href}`;
}

function cleanText(s) {
  if (!s) return s;
  return s
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

async function postDiscord({ category, title, url }) {
  const payload = {
    username: "7DS Origins • Veille",
    embeds: [
      {
        title: `📌 ${category} — Nouveau post`,
        description: title ? `**${title}**` : "Nouveau post détecté.",
        url,
        color: GOLD,
        footer: { text: "Source: 7origin.netmarble.com" },
      },
    ],
  };

  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${res.status} ${t}`);
  }
}

async function getBestTitle(page) {
  const selectors = [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
  ];

  for (const sel of selectors) {
    try {
      const loc = page.locator(sel);
      if ((await loc.count()) > 0) {
        const v = await loc.first().getAttribute("content");
        if (v && cleanText(v)) return cleanText(v);
      }
    } catch {}
  }

  // fallback H1
  try {
    const h1 = page.locator("h1").first();
    if ((await h1.count()) > 0) {
      const t = await h1.innerText();
      if (t && cleanText(t)) return cleanText(t);
    }
  } catch {}

  // fallback <title>
  try {
    const t = await page.title();
    if (t && cleanText(t)) return cleanText(t);
  } catch {}

  return null;
}

// prend le 1er lien d’article /en/news/<x>/<y> visible dans la liste
async function getLatestArticleUrlFromCurrentView(page) {
  const hrefs = await page.$$eval('a[href^="/en/news/"]', (as) =>
    as.map((a) => a.getAttribute("href")).filter(Boolean)
  );

  const rx = /^\/en\/news\/\d+\/\d+$/;
  const filtered = hrefs.filter((h) => rx.test(h));

  // unique, conserve l’ordre
  const uniq = [];
  for (const h of filtered) {
    if (!uniq.includes(h)) uniq.push(h);
  }

  return absUrl(uniq[0] || null);
}

async function goToNewsSection(page) {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60000 });

  // clique "News" dans le menu si présent
  try {
    await page.getByRole("link", { name: /news/i }).first().click({ timeout: 8000 });
  } catch {
    // si le site charge déjà le module news, on continue
  }

  await page.waitForTimeout(2000);
}

async function clickTab(page, tabText) {
  const tries = [
    () => page.getByRole("button", { name: new RegExp(tabText, "i") }).first().click(),
    () => page.getByRole("link", { name: new RegExp(tabText, "i") }).first().click(),
    () => page.getByText(new RegExp(`^${tabText}$`, "i")).first().click(),
    () => page.getByText(new RegExp(tabText, "i")).first().click(),
  ];

  for (const fn of tries) {
    try {
      await fn();
      return;
    } catch {}
  }
  throw new Error(`Cannot click tab: ${tabText}`);
}

// ---------- main ----------
const { chromium } = await import("playwright");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

try {
  await goToNewsSection(page);

  const tabs = [
    { key: "news", label: "News", tab: "News" },
    { key: "notices", label: "Notices", tab: "Notices" },
    { key: "dev", label: "Developer notes", tab: "Developer notes" },
  ];

  // évite d’envoyer la même URL plusieurs fois pendant un run
  const sentThisRun = new Set();

  for (const t of tabs) {
    await clickTab(page, t.tab);
    await page.waitForTimeout(1500);

    const latestUrl = await getLatestArticleUrlFromCurrentView(page);
    if (!latestUrl) continue;

    // BOOTSTRAP : on enregistre sans notifier
    if (isBootstrap && !state[t.key]) {
      state[t.key] = latestUrl;
      continue;
    }

    // si doublon dans le même run (ex: News == Notices), on skip
    if (sentThisRun.has(latestUrl)) {
      state[t.key] = latestUrl;
      continue;
    }

    // changement => notification
    if (state[t.key] !== latestUrl) {
      await page.goto(latestUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(800);

      const title = await getBestTitle(page);
      await postDiscord({ category: t.label, title, url: latestUrl });

      sentThisRun.add(latestUrl);
      state[t.key] = latestUrl;

      // retour au tableau des news pour la suite
      await goToNewsSection(page);
    }
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
} finally {
  await browser.close();
}
