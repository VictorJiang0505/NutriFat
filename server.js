import 'dotenv/config';
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

const SYSTEM_PROMPT = `You are a nutrition expert. When given a food description, return ONLY a JSON object with this shape — no markdown, no explanation:
{
  "calories": number,
  "protein_g": number,
  "saturated_fat_g": number,
  "sodium_mg": number,
  "fiber_g": number,
  "added_sugar_g": number,
  "items": [
    { "name": string, "calories": number, "protein_g": number, "saturated_fat_g": number, "sodium_mg": number }
  ]
}

Units: saturated_fat_g and added_sugar_g are in grams; sodium_mg is in milligrams.

Portion size calibration — use these realistic weights unless the user specifies otherwise:
- Chicken thigh, skinless, cooked: ~100g each (~26g protein each)
- "Large spoon" of rice/grains: ~40–50g cooked (~1.5g protein each)
- "Medium plate" of mixed vegetables: ~150–200g total
- Homemade meatball 1-inch diameter: ~9–10g each (~2–2.5g protein each, ~40 cal)
- Pork meatball 1-inch diameter: ~9g, ~38 cal, ~2g protein, ~0.5g sat fat
- Chicken breast, skinless, cooked: ~150g (~46g protein)
- Egg, large: ~50g (~6g protein)
- Tablespoon of oil/sauce: ~15g

When a meal has many components, estimate each item individually then sum. Do NOT inflate protein — lean meats have ~25–30g protein per 100g cooked weight, vegetables ~2–3g per 100g. A realistic home-cooked dinner for one person is typically 600–900 calories and 30–60g protein unless it is explicitly very large.`;


const PERSONALIZE_PROMPT = `You are a registered dietitian. Given a user's stats, return ONLY a JSON object with personalized daily nutrition targets — no markdown, no explanation:
{
  "calories": number,
  "protein_g": number,
  "saturated_fat_g": number,
  "sodium_mg": number,
  "fiber_g": number,
  "added_sugar_g": number,
  "explanation": "one sentence summarising the rationale"
}

Units: saturated_fat_g, fiber_g, added_sugar_g in grams; sodium_mg in milligrams.
The input will include weightKg (body weight in kilograms).

CRITICAL: Calculate protein_g using ONLY the per-kg body weight guidelines below — do NOT derive it as a percentage of calories.

Protein guidelines (multiply weightKg by the factor for the user's goal):
- Build muscle: 1.9–2.4 g × weightKg (e.g. 67 kg → 127–161 g)
- Lose weight: 1.2–1.6 g × weightKg
- Improve endurance: 1.2–1.4 g × weightKg
- Maintain weight: 1.0–1.2 g × weightKg

Other targets (set to a reasonable goal value, not just the ceiling):
- Build muscle: sodium ~2300 mg; saturated fat ~18 g
- Lose weight: sodium ~1800 mg; saturated fat ~12 g
- Improve endurance: sodium ~2500 mg; saturated fat ~15 g
- Maintain weight: sodium ~2000 mg; saturated fat ~15 g

CRITICAL: Calculate added_sugar_g as 10% of targetCalories divided by 4 (e.g. 2000 cal → 50 g, 3000 cal → 75 g). For "Lose weight" use 5% instead (e.g. 2000 cal → 25 g). Round to the nearest integer. Do NOT use a fixed value.

CRITICAL: Calculate fiber_g using ONLY this formula: 14 g per 1000 kcal of targetCalories (e.g. 2000 cal → 28 g, 3000 cal → 42 g). Round to the nearest integer. Do NOT use a fixed value.
- Return realistic, evidence-based integers`;

app.post('/api/ai-nutrition', async (req, res) => {
  const { foodDescription } = req.body ?? {};
  if (!foodDescription || typeof foodDescription !== 'string' || !foodDescription.trim()) {
    return res.status(400).json({ error: 'foodDescription is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: foodDescription.trim() }],
      }),
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(upstream.status).json({ error: `Anthropic API error: ${body.slice(0, 200)}` });
    }

    const data = await upstream.json();
    const nutrition = JSON.parse(data.content[0].text);
    res.json(nutrition);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/personalize', async (req, res) => {
  const { profile } = req.body ?? {};
  if (!profile || typeof profile !== 'object') {
    return res.status(400).json({ error: 'profile is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: PERSONALIZE_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(profile) }],
      }),
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(upstream.status).json({ error: `Anthropic API error: ${body.slice(0, 200)}` });
    }

    const data = await upstream.json();
    const targets = JSON.parse(data.content[0].text);

    // Override protein and fiber with deterministic formulas — never trust LLM math for these.
    const PROTEIN_FACTOR = {
      'Build muscle': 2.2,
      'Improve endurance': 1.3,
      'Lose weight': 1.4,
      'Maintain weight': 1.1,
    };
    const factor = PROTEIN_FACTOR[profile.fitnessGoal] || 1.1;
    targets.protein_g = Math.round(factor * (profile.weightKg || 70));
    targets.fiber_g = Math.round(14 * (profile.targetCalories || targets.calories || 2000) / 1000);
    const sugarCalories = profile.targetCalories || targets.calories || 2000;
    const sugarPct = profile.fitnessGoal === 'Lose weight' ? 0.05 : 0.10;
    targets.added_sugar_g = Math.round(sugarCalories * sugarPct / 4);

    res.json(targets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const DAILY_SCORE_PROMPT = `You are a direct, honest nutrition coach. The user logged their food today and received a nutrition score out of 100 based on how closely they hit their personalized targets. You will receive the score, their targets, their actual totals, and the food log.

Write exactly 2–3 sentences that explain what drove this score. Be specific: name the nutrients that hurt the score most (too high or too low), name the foods responsible, and give one concrete action they can take tomorrow. Tone: honest, not harsh. Only fiber benefits from going slightly over target — everything else over target is a negative.

Respond with ONLY the plain paragraph — no bullet points, no headers, no JSON.`;

app.post('/api/daily-score', async (req, res) => {
  const { score, log, totals, targets } = req.body ?? {};
  if (!Array.isArray(log) || log.length === 0) {
    return res.status(400).json({ error: 'log is required and must be non-empty' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        system: DAILY_SCORE_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify({ score, targets, totals, log }) }],
      }),
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(upstream.status).json({ error: `API error: ${body.slice(0, 200)}` });
    }

    const data = await upstream.json();
    res.json({ commentary: data.content[0].text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
createServer(app).listen(PORT, () => {
  console.log(`NutriFat running at http://localhost:${PORT}`);
});
