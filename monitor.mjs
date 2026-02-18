import fs from "fs";

const WEBHOOK = process.env.DISCORD_WEBHOOK;
if (!WEBHOOK) {
  console.error("Missing DISCORD_WEBHOOK secret");
  process.exit(1);
}

// --- state ---
const STATE_FILE = "state.json";
let state = { news: null, notices: null, dev: null };
if (fs.existsSync(STATE_FILE)) {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
}

// --- helpers ---
const GOLD = 15844367;

function absUrl(href) {
  if (!href) return null;
  if (href.startsWith("http")) return href;
  if (href.startsWith("/")) return `https://7origin.netmarble.com${href}`;
  return `https://7origin.netmarble.com/${href}`;
}

async function postDiscord({ category, title, url }) {
  const payload = {
    username: "7DS Origins • Veille",
    embeds: [{
      title: `📌 ${category} — Nouveau post`,
      description: title ? `**${title}**` : "Nouveau post détecté sur le site officiel.",
      url,
      color: GOLD,
      footer: { text: "Source: 7origin.netmarble.com" }
    }]
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

async function getOgTitle(page) {
  const candidates = [
    'meta[property="og:title"]',
    'meta[name="twitter:title"]',
    "title"
  ];

  for (const sel of candidates) {
    try {
      if (sel === "title") {
        const t = await page.title();
        if (t && !t.toLowerCase().includes("netmarble")) return t.trim();
        continue;
      }
      const loc = page.locator(sel);
      if (await loc.count()) {
        const v = await loc.first().getAttribute("content");
        if (v && v.trim()) return v.trim();
      }
    } catch {}
  }
  return null;
}

// Trouve le premier lien vers un article /en/news/<cat>/<id>
async function getLatestArticleUrlFromCurrentView(page) {
  const hrefs = await page.$$eval('a[href*="/news/"]', as =>
    as.map(a => a.getAttribute("href")).filter(Boolean)
  );

  // On prend le premier lien qui ressemble à un article EN
  const rx = /^\/en\/news\/\d+\/\d+$/;
  const found = hrefs.find(h => rx.test(h)) || hrefs.find(h => h.includes("/en/news/"));
  return absUrl(found);
}

async function clickTab(page, tabText) {
  // Essaie boutons / onglets avec texte (site dynamique -> fallback multiples)
  const tries = [
    () => page.getByRole("button", { name: new RegExp(tabText, "i") }).first().click(),
    () => page.getByRole("link", { name: new RegExp(tabText, "i") }).first().click(),
    () => page.getByText(new RegExp(`^${tabText}$`, "i")).first().click(),
    () => page.getByText(new RegExp(tabText, "i")).first().click(),
  ];

  for (const fn of tries) {
    try { await fn(); return; } catch {}
  }
  throw new Error(`Cannot click tab: ${tabText}`);
}

// --- main ---
const { chromium } = await import("playwright");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

try {
  // Ouvre directement la page et clique "News" (menu du haut)
  await page.goto("https://7origin.netmarble.com/en/", { waitUntil: "domcontentloaded", timeout: 60000 });

  // Menu haut: "News"
  try {
    await page.getByRole("link", { name: /news/i }).first().click();
  } catch {
    // parfois déjà sur la bonne vue
  }

  // Attends un peu le rendu
  await page.waitForTimeout(2500);

  const tabs = [
    { key: "news",    label: "News",            tab: "News" },
    { key: "notices", label: "Notices",         tab: "Notices" },
    { key: "dev",     label: "Developer notes", tab: "Developer notes" },
  ];

  for (const t of tabs) {
    await clickTab(page, t.tab);
    await page.waitForTimeout(2000);

    const latestUrl = await getLatestArticleUrlFromCurrentView(page);
    if (!latestUrl) continue;

    if (state[t.key] !== latestUrl) {
      // récupère un titre propre (meta OG si dispo)
      await page.goto(latestUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1200);
      const title = await getOgTitle(page);

      await postDiscord({ category: t.label, title, url: latestUrl });

      state[t.key] = latestUrl;
      // retourne au board
      await page.goto("https://7origin.netmarble.com/en/", { waitUntil: "domcontentloaded", timeout: 60000 });
      try { await page.getByRole("link", { name: /news/i }).first().click(); } catch {}
      await page.waitForTimeout(2000);
    }
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
} finally {
  await browser.close();
}
