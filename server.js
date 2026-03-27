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

app.post("/analyze", upload.single("file"), async (req, res) => {
  const topic = req.body.topic?.trim();
  const context = req.body.context?.trim();
  const file = req.file;

  if (!topic) {
    return res.status(400).json({ error: "A topic is required." });
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

    // Run AI and Wikipedia image lookup in parallel — no added latency
    const [aiResponse, image] = await Promise.all([
      client.chat.completions.create({
        model: "gpt-4o-mini",
        max_tokens: 1024,
        messages: [
          { role: "system", content: CLARITY_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
      fetchWikipediaImage(topic),
    ]);

    const text = aiResponse.choices[0]?.message?.content ?? "";
    res.json({ topic, result: text, image: image ?? null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong. Try again." });
  }
});

// Local dev
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Clarity engine running on port ${PORT}`));
}

module.exports = app;
