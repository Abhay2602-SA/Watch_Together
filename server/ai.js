/**
 * AI content assistant — powered by Groq (OpenAI-compatible API).
 *
 * /api/ai/generate handles several "kinds" of request, all the same
 * underlying call with a different prompt:
 *   - ask                 free-form question about what's playing
 *   - summarize           episode/video summary
 *   - explain_scene       explain what's going on / what just happened
 *   - trivia              a few trivia facts
 *   - discussion_questions a few discussion prompts for the group
 *
 * /api/subtitles/translate batch-translates a parsed subtitle track.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile";

const KIND_PROMPTS = {
  ask: (videoUrl) =>
    `Answer the viewer's question about whatever they're watching, briefly and conversationally.${
      videoUrl ? ` They are currently watching: ${videoUrl}.` : " No video is currently loaded."
    } If you don't have enough specific context (exact scene, character names), say so rather than guessing.`,
  summarize: (videoUrl) =>
    `Give a concise, spoiler-light summary of this video for someone who just joined: ${videoUrl || "(no video loaded)"}. If you don't actually know this specific video, say so honestly instead of inventing plot details.`,
  explain_scene: (videoUrl) =>
    `The group wants a scene explained for this video: ${videoUrl || "(no video loaded)"}. Explain clearly what's likely happening based on the question they ask. If you don't have specific knowledge of this exact content, say so rather than inventing details.`,
  trivia: (videoUrl) =>
    `Share a few interesting, verifiable trivia facts related to this video: ${videoUrl || "(no video loaded)"}. If you don't have reliable specific trivia for this exact title, say so rather than making facts up.`,
  discussion_questions: (videoUrl) =>
    `Generate 4-5 good discussion questions a group could talk about after watching this: ${videoUrl || "(no video loaded)"}. Keep them general enough to work even without deep specific knowledge of the title.`,
};

async function callGroq(systemPrompt, userMessage) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.6,
      max_tokens: 600,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("[ai] Groq error:", res.status, errText);
    throw new Error("groq_error");
  }
  return res.json();
}

function registerAiRoutes(app) {
  app.post("/api/ai/generate", async (req, res) => {
    if (!process.env.GROQ_API_KEY) {
      return res.status(503).json({ error: "GROQ_API_KEY isn't set in .env." });
    }
    const { kind = "ask", question, videoUrl, chatSnippet } = req.body || {};
    const promptFn = KIND_PROMPTS[kind] || KIND_PROMPTS.ask;

    if (kind === "ask" && (!question || !question.trim())) {
      return res.status(400).json({ error: "question is required for kind=ask" });
    }

    const systemPrompt = [
      "You are the in-room AI assistant for a watch-together app called AS watch-together.",
      promptFn(videoUrl),
      chatSnippet ? `Recent room chat, for context only:\n${chatSnippet}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    const userMessage = question && question.trim() ? question : `Please help with: ${kind.replace(/_/g, " ")}`;

    try {
      const data = await callGroq(systemPrompt, userMessage);
      const answer = data.choices?.[0]?.message?.content?.trim() || "I couldn't come up with an answer for that.";
      res.json({ answer });
    } catch {
      res.status(502).json({ error: "The AI assistant is unavailable right now." });
    }
  });

  app.post("/api/subtitles/translate", async (req, res) => {
    if (!process.env.GROQ_API_KEY) {
      return res.status(503).json({ error: "GROQ_API_KEY isn't set in .env." });
    }
    const { cues, targetLang } = req.body || {};
    if (!Array.isArray(cues) || !cues.length || !targetLang) {
      return res.status(400).json({ error: "cues (array) and targetLang are required" });
    }
    // Batch in chunks so we don't blow context on very long subtitle files.
    const CHUNK = 60;
    const out = [];
    try {
      for (let i = 0; i < cues.length; i += CHUNK) {
        const chunk = cues.slice(i, i + CHUNK);
        const systemPrompt = [
          `Translate each subtitle line to ${targetLang}.`,
          "Respond with ONLY a JSON array of translated strings, same length and order as the input array.",
          "No preamble, no markdown fences, no explanations — just the JSON array.",
        ].join(" ");
        const data = await callGroq(systemPrompt, JSON.stringify(chunk.map((c) => c.text)));
        let translated;
        try {
          translated = JSON.parse(data.choices[0].message.content.trim());
        } catch {
          translated = chunk.map((c) => c.text); // fall back to original text if parsing fails
        }
        chunk.forEach((c, idx) => out.push({ ...c, text: translated[idx] ?? c.text }));
      }
      res.json({ cues: out });
    } catch {
      res.status(502).json({ error: "Translation is unavailable right now." });
    }
  });
}

module.exports = { registerAiRoutes };

