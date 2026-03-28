require("dotenv").config();
const express = require("express");
const multer = require("multer");
const OpenAI = require("openai");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const client = new OpenAI.default({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ storage: multer.memoryStorage() });

const CLARITY_SYSTEM_PROMPT = `You are Clarity, an AI that turns any topic into clear, structured understanding in under 60 seconds.

Your job is NOT to dump information or write long explanations.
Your job is to create clarity.

If a topic has multiple interpretations, pick the most likely one and start your response with a single line like:
"Covering [your interpretation] — let me know if you meant something else."

Always follow this exact output structure:

---

## What's happening
- Explain the topic simply in 3–5 bullet points
- Assume the user is smart but not deeply familiar
- Avoid jargon unless necessary (and explain it if used)

## Why it matters
- Explain real-world impact
- Focus on consequences, not theory
- Answer: "Why should anyone care?"

## Key players
- List the most relevant companies, people, or groups
- Add a short descriptor for each (one line max)

## What people disagree on
- Show contrasting perspectives (bull vs bear, optimistic vs skeptical, etc.)
- Be specific, not generic
- This is the most important section

## Why now
- Explain why this topic is trending or relevant currently
- Mention recent events, timing, or shifts

## TL;DR
- 1–2 sentences max
- Extremely clear and punchy

---

STYLE RULES:
- Be concise and structured
- No fluff, no filler
- No long paragraphs (bullets preferred)
- Sound like a sharp, well-informed human — not academic, not robotic
- Prioritize clarity over completeness
- If uncertain, simplify rather than over-explain

AVOID:
- Generic summaries
- Repeating the same idea across sections
- Overly technical language
- Citing sources unless absolutely necessary`;

// Strip conversational prefixes so "Explain black holes" → "black holes"
function cleanTopicForWikipedia(topic) {
  return topic
    .replace(/^(explain|describe|what (is|are|was|were)|how (does|do|did)|tell me about|define|who (is|are|was|were)|why (is|are|does|do))\s+/i, "")
    .trim();
}

// Fetch the Wikipedia thumbnail for a topic.
// Returns a URL string or null — never throws.
async function fetchWikipediaImage(topic) {
  const headers = { "User-Agent": "Clarity/1.0 (educational app; contact via github)" };
  try {
    const query = cleanTopicForWikipedia(topic);
    // Use opensearch to resolve the best matching article title first
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&format=json`;
    const searchRes = await fetch(searchUrl, { headers });
    if (!searchRes.ok) return null;
    const [, titles] = await searchRes.json();
    const title = titles?.[0];
    if (!title) return null;

    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const res = await fetch(summaryUrl, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.type !== "standard") return null;
    const src = data.originalimage?.source ?? data.thumbnail?.source ?? null;
    if (!src) return null;
    return src.replace(/\/\d+px-/, "/800px-");
  } catch {
    return null;
  }
}

const CREATOR_TRIGGERS = [
  /^edge$/i,
  /^edgerrin$/i,
  /^edgerrin\s+washington$/i,
  /who\s+(is|made|built|created|made)\s+(clarity|this)/i,
  /who\s+created\s+clarity/i,
  /who\s+built\s+clarity/i,
  /about\s+the\s+(creator|developer|maker|founder)/i,
  /^who\s+is\s+edge$/i,
  /^who\s+is\s+edgerrin/i,
];

const CREATOR_BIO_PROMPT = `You are generating a short "About Me" profile for a user inside the Clarity app.

The goal is to write a compelling, polished, slightly impressive (but not arrogant) profile that feels human and natural—not templated. You are the Clarity AI explaining who this person is to someone who just searched for them.

You MUST incorporate the following core facts:
- Edgerrin Washington is a full-time public servant and part-time developer
- He builds digital tools with real-world utility
- He cares about helping small businesses
- He built:
  - Clarity (the app the user is currently using — a tool for understanding topics quickly)
  - a news tracker app (custom keyword-based news aggregation)
- He grew up in Immokalee, Florida
- He is currently based in Washington, D.C.

STYLE GUIDELINES:
- Write in third person — you are describing Edgerrin to the user
- Keep it concise (4–7 sentences max)
- Vary phrasing and sentence structure each time (do NOT reuse fixed templates)
- Tone: confident, thoughtful, mission-driven
- "Glaze" the user slightly (make them sound impressive), but keep it believable
- Avoid buzzwords and clichés like "passionate leader" or "results-driven"
- Make it feel modern and intentional

OPENING LINE RULES — match the opening to how the user phrased their search:
- If they asked who created/built/made Clarity → open with "Clarity was created by Edgerrin Washington..."
- If they searched "Edge" or "who is Edge" → open with: Edgerrin Washington (aka "Edge") is...
- If they searched "Edgerrin" or "Edgerrin Washington" → open naturally with his full name
- Never start with "I" — this is always third person

CONTENT GUIDELINES:
- Blend personal background with current work
- Highlight the contrast of public service + building products
- Emphasize usefulness and real-world impact of their tools
- Optionally include a subtle forward-looking or mission-oriented closing line

AVOID:
- Repetitive sentence patterns
- Overly formal or corporate tone
- Lists or bullet points
- Sounding generic or AI-generated

OUTPUT:
Return only the final "About Me" text.`;

function isCreatorQuery(topic) {
  return CREATOR_TRIGGERS.some(r => r.test(topic.trim()));
}

// Detect queries about Clarity the product, not the concept
const CLARITY_PRODUCT_TRIGGERS = [
  /^clarity$/i,
  /^what\s+is\s+clarity(\?)?$/i,
  /^tell\s+me\s+about\s+clarity(\?)?$/i,
  /^what('?s|\s+is)\s+clarity(\s+app)?(\?)?$/i,
  /^(explain|describe)\s+clarity(\?)?$/i,
  /^clarity\s+app(\?)?$/i,
  /^ineedclarity(\?)?$/i,
];

// Concept qualifiers override product detection (e.g. "clarity in writing")
const CLARITY_CONCEPT_OVERRIDES = [
  /clarity\s+(in|of|for|meaning|definition|synonym)/i,
  /\bcommunication\b/i,
  /\bwriting\b/i,
  /\bthinking\b/i,
  /\bvision\b/i,
  /\bspeech\b/i,
];

function isClarityProductQuery(topic) {
  const t = topic.trim();
  if (CLARITY_CONCEPT_OVERRIDES.some(r => r.test(t))) return false;
  return CLARITY_PRODUCT_TRIGGERS.some(r => r.test(t));
}

const CLARITY_PRODUCT_PROMPT = `You are generating a product explanation for Clarity — an AI-powered research app — to show when a user searches for "Clarity" inside the app itself.

Write a natural, grounded, slightly varied explanation each time. Do not sound promotional or salesy. Sound like you're explaining it to a curious person.

Use this structure exactly:

## What is Clarity
- Clarity is an AI-powered research app created by Edgerrin Washington
- It helps users understand any topic quickly by turning complex information into clear, structured insights
- Instead of sending users down rabbit holes, Clarity delivers what matters most in seconds

## What it does
- Breaks down topics into key insights, real-world relevance, and opposing perspectives
- Surfaces not just information, but understanding
- Helps users cut through noise and stay informed with intention

## Why it exists
- Built to solve information overload
- Designed for people who want clarity, not just more content
- Focused on real-world utility over complexity

## More context
- If you meant the general definition of "clarity" (the concept), you can refine your question (e.g. "what does clarity mean in communication")

## TL;DR
- Clarity is a tool that helps you understand anything faster and more clearly

STYLE RULES:
- Keep tone clear, confident, concise
- Do not sound overly promotional
- Slightly vary wording each time while keeping meaning consistent
- Do not repeat identical phrasing across responses`;

app.post("/analyze", upload.single("file"), async (req, res) => {
  const topic = req.body.topic?.trim();
  const context = req.body.context?.trim();
  const file = req.file;

  if (!topic) {
    return res.status(400).json({ error: "A topic is required." });
  }

  // Clarity product queries — explain the app itself
  if (isClarityProductQuery(topic)) {
    try {
      const prodResponse = await client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 400,
        messages: [
          { role: "system", content: CLARITY_PRODUCT_PROMPT },
          { role: "user",   content: topic },
        ],
      });
      const prodResult = prodResponse.choices[0]?.message?.content ?? "";
      return res.json({ topic, result: prodResult, image: '/clarity4.png', reddit: [], articles: [] });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Something went wrong. Try again." });
    }
  }

  // Creator / about-the-builder queries — return a generated bio instead
  if (isCreatorQuery(topic)) {
    try {
      const bioResponse = await client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 300,
        messages: [
          { role: "system", content: CREATOR_BIO_PROMPT },
          { role: "user",   content: topic },
        ],
      });
      const bio = bioResponse.choices[0]?.message?.content ?? "";
      return res.json({ topic, result: bio, image: null, reddit: [], articles: [] });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Something went wrong. Try again." });
    }
  }

  try {
    const userContent = [];

    // Build the user text message
    let userText = topic;
    if (context) userText += `\n\nAdditional context: ${context}`;

    // Handle PDF — extract text and append
    if (file && file.mimetype === "application/pdf") {
      const { PDFParse } = require("pdf-parse");
      const parser = new PDFParse({ data: file.buffer });
      const data = await parser.getText();
      await parser.destroy();
      userText += `\n\nContent from uploaded PDF:\n${data.text}`;
      userContent.push({ type: "text", text: userText });
    }
    // Handle image — send as vision input
    else if (file && file.mimetype.startsWith("image/")) {
      const base64 = file.buffer.toString("base64");
      userContent.push({ type: "text", text: userText });
      userContent.push({
        type: "image_url",
        image_url: { url: `data:${file.mimetype};base64,${base64}` },
      });
    }
    // Text only
    else {
      userContent.push({ type: "text", text: userText });
    }

    // Run all lookups in parallel — no added latency
    const [aiResponse, image, redditPosts, hnArticles, newsArticles, zhArticles] = await Promise.all([
      client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 1024,
        messages: [
          { role: "system", content: CLARITY_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
      fetchWikipediaImage(topic),
      fetchRedditPosts(topic),
      fetchHackerNewsArticles(topic),
      fetchGoogleNewsArticles(topic),
      fetchZeroHedgeArticles(topic),
    ]);

    const text = aiResponse.choices[0]?.message?.content ?? "";

    // Generate follow-up questions using the result for context
    let followUps = [];
    try {
      const fuRes = await client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 150,
        messages: [
          { role: "system", content: `Generate exactly 3 short follow-up questions for a topic. Mix:
1. A devil's advocate or contrarian challenge
2. A common misconception or overlooked angle
3. A "what happens next" or consequence-based question
Return ONLY a valid JSON array of 3 strings, each under 9 words. No other text.` },
          { role: "user", content: `Topic: ${topic}\nContext: ${text.slice(0, 400)}` },
        ],
      });
      const raw = fuRes.choices[0]?.message?.content ?? "[]";
      followUps = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
    } catch { followUps = []; }

    // ZeroHedge first, then Google News, then HN. Dedupe by domain.
    const seen = new Set();
    const articles = [...zhArticles, ...newsArticles, ...hnArticles].filter(a => {
      try {
        const host = new URL(a.url).hostname;
        if (seen.has(host)) return false;
        seen.add(host);
        return true;
      } catch { return false; }
    }).slice(0, 5);

    res.json({ topic, result: text, image: image ?? null, reddit: redditPosts, articles, followUps });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Try again." });
  }
});

// Decode common HTML entities in RSS text.
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Parse a basic RSS/Atom XML feed — returns array of { title, url, source, image }.
function parseRssItems(xml, defaultSource = "") {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
  return items.map(([, block]) => {
    const raw = decodeEntities(
      block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]>/)?.[1]
      ?? block.match(/<title>([\s\S]*?)<\/title>/)?.[1]
      ?? ""
    );
    // Google News embeds " - Source Name" at the end of titles
    const dashIdx = raw.lastIndexOf(" - ");
    const title  = (dashIdx > 0 ? raw.slice(0, dashIdx) : raw).trim();
    const source = (dashIdx > 0 ? raw.slice(dashIdx + 3) : defaultSource).trim();
    const url    = (block.match(/<link>([\s\S]*?)<\/link>/)?.[1]
                 ?? block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/)?.[1]
                 ?? "").trim();
    // Extract image from media tags or description
    const image  = block.match(/<media:content[^>]+url="([^"]+)"/)?.[1]
                ?? block.match(/<media:thumbnail[^>]+url="([^"]+)"/)?.[1]
                ?? block.match(/<enclosure[^>]+url="([^"]+)"[^>]+type="image/)?.[1]
                ?? block.match(/<img[^>]+src="([^"]+)"/)?.[1]
                ?? null;
    return { title, url, source, image };
  }).filter(a => a.title && a.url.startsWith("http"));
}

// Fetch top headlines from CNN RSS.
async function fetchCnnHeadlines() {
  try {
    const res = await fetch("https://rss.cnn.com/rss/cnn_topstories.rss", {
      headers: { "User-Agent": "Clarity/1.0 (educational app; contact via github)" },
    });
    if (!res.ok) return [];
    return parseRssItems(await res.text(), "CNN").slice(0, 5);
  } catch { return []; }
}

// Fetch top headlines from Fox News RSS.
async function fetchFoxHeadlines() {
  try {
    const res = await fetch("https://moxie.foxnews.com/google-publisher/latest.xml", {
      headers: { "User-Agent": "Clarity/1.0 (educational app; contact via github)" },
    });
    if (!res.ok) return [];
    return parseRssItems(await res.text(), "Fox News").slice(0, 5);
  } catch { return []; }
}

// Fetch Google News top stories (no query — general headlines).
async function fetchGoogleTopStories() {
  try {
    const res = await fetch("https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", {
      headers: { "User-Agent": "Clarity/1.0 (educational app; contact via github)" },
    });
    if (!res.ok) return [];
    return parseRssItems(await res.text()).filter(a => a.source).slice(0, 6);
  } catch { return []; }
}

// Fetch ZeroHedge articles relevant to a topic via their RSS feed + keyword matching.
// Returns array of { title, url, source } or [] — never throws.
async function fetchZeroHedgeArticles(topic) {
  const STOP = new Set(["the","a","an","and","or","of","in","on","at","to","for",
    "with","is","are","was","were","be","been","how","what","why","who","does","do",
    "explain","describe","tell","me","about","define"]);
  try {
    const keywords = cleanTopicForWikipedia(topic)
      .toLowerCase().split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w));
    if (!keywords.length) return [];

    const res = await fetch("https://feeds.feedburner.com/zerohedge/feed", {
      headers: { "User-Agent": "Clarity/1.0 (educational app; contact via github)" },
    });
    if (!res.ok) return [];
    const xml = await res.text();

    return parseRssItems(xml)
      .filter(a => {
        const haystack = a.title.toLowerCase();
        return keywords.some(kw => haystack.includes(kw));
      })
      .slice(0, 2)
      .map(a => ({ ...a, source: "ZeroHedge" }));
  } catch {
    return [];
  }
}

// Fetch articles from Google News RSS (aggregates Fox, CNN, BBC, Reuters, AP, etc.)
// Returns array of { title, url, source } or [] — never throws.
async function fetchGoogleNewsArticles(topic) {
  try {
    const query = encodeURIComponent(cleanTopicForWikipedia(topic));
    const url   = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
    const res   = await fetch(url, {
      headers: { "User-Agent": "Clarity/1.0 (educational app; contact via github)" },
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRssItems(xml)
      .filter(a => a.source)
      .slice(0, 4);
  } catch {
    return [];
  }
}

// Fetch top HackerNews articles for a topic.
// Returns array of { title, url, domain, points } or [] — never throws.
async function fetchHackerNewsArticles(topic) {
  try {
    const query = encodeURIComponent(cleanTopicForWikipedia(topic));
    const url = `https://hn.algolia.com/api/v1/search?query=${query}&tags=story&hitsPerPage=8`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Clarity/1.0 (educational app; contact via github)" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.hits ?? [])
      .filter(h => h.url && h.points >= 50)
      .slice(0, 3)
      .map(h => ({
        title:  h.title,
        url:    h.url,
        domain: new URL(h.url).hostname.replace(/^www\./, ""),
        points: h.points,
      }));
  } catch {
    return [];
  }
}

// Fetch top Reddit posts for a topic.
// Returns an array of { title, url, subreddit, score } or [] — never throws.
async function fetchRedditPosts(topic) {
  try {
    const query = encodeURIComponent(topic);
    const url = `https://www.reddit.com/search.json?q=${query}&sort=relevance&t=year&limit=5&type=link`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Clarity/1.0 (educational app; contact via github)" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const posts = data?.data?.children ?? [];
    return posts
      .map(p => ({
        title:     p.data.title,
        url:       `https://reddit.com${p.data.permalink}`,
        subreddit: p.data.subreddit,
        score:     p.data.score,
      }))
      .filter(p => p.score >= 50)
      .slice(0, 3);
  } catch {
    return [];
  }
}

app.post("/followup", async (req, res) => {
  const { topic, question } = req.body;
  if (!topic || !question) return res.status(400).json({ error: "Missing topic or question." });

  try {
    const [answerRes, resources] = await Promise.all([
      client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 180,
        messages: [
          { role: "system", content: `You are Clarity's follow-up assistant. Answer the question briefly and directly.
- 2–4 sentences max
- No markdown headers or bullet points
- Conversational but sharp
- Stay tightly focused on the question asked` },
          { role: "user", content: `Topic: ${topic}\nQuestion: ${question}` },
        ],
      }),
      Promise.all([
        fetchGoogleNewsArticles(question),
        fetchHackerNewsArticles(question),
      ]).then(([news, hn]) => {
        const merged = [...news, ...hn];
        const seen = new Set();
        return merged.filter(a => {
          try {
            const domain = new URL(a.url).hostname.replace('www.', '');
            if (seen.has(domain)) return false;
            seen.add(domain);
            return true;
          } catch { return false; }
        }).slice(0, 3);
      }).catch(() => []),
    ]);

    const answer = answerRes.choices[0]?.message?.content ?? "";
    res.json({ answer, resources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

// Trending headlines — used for empty history state
app.get("/trending", async (req, res) => {
  try {
    const [cnn, fox, google] = await Promise.all([
      fetchCnnHeadlines(),
      fetchFoxHeadlines(),
      fetchGoogleTopStories(),
    ]);

    // CNN + Fox first (they have images), then Google News
    const merged = [...cnn, ...fox, ...google];
    const seen = new Set();
    const articles = merged.filter(a => {
      try {
        const domain = new URL(a.url).hostname.replace("www.", "");
        if (seen.has(domain)) return false;
        seen.add(domain);
        return true;
      } catch { return false; }
    }).slice(0, 8);

    res.json(articles);
  } catch (err) {
    console.error(err);
    res.status(500).json([]);
  }
});

// Local dev
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Clarity engine running on port ${PORT}`));
}

module.exports = app;
