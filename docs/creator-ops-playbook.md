# How Top Creators Operate with AI, LLMs & Automation — 2025/2026 Playbook

Researched for the horizon-ai faceless vertical-video factory. Dense, copyable, source-linked. Where a number is a real number from the creator or a verified study, it is stated as such. Gaps are marked explicitly.

---

## 0. The Universal Pipeline Shape

Every operation that works — from WatchMojo (2006, 20+ yrs) to Zenn (150K subs in ~2 months) — runs the same spine:

```
Ideation/topic → research → script → voiceover → visuals → assembly/edit → packaging (title+thumb) → publish → analyze → feed back
```

Three rules that recur across all 17 creators:
1. **The human keeps judgment; machines do volume.** WatchMojo, TheAIGRID, Wes Roth, Mrwhosetheboss all say the same thing: AI for draft/ideate/assemble, human for topic verdict and claims. TheAIGRID's failure mode: fully-auto channels "confidently repeat inaccurate claims from social posts" and die in this niche because the audience is technical.
2. **Topic + packaging beat production.** Zenn's own catalog: identical art/format/pipeline, only title+topic varies → 84x spread (The Calhoun Effect 3.7M vs The Pratfall Effect 44K). WatchMojo: "repeatable production systems, not individual videos."
3. **Volume is the moat, compounding is the strategy.** WatchMojo 6 uploads/day ≈ 2,190 videos/yr; a 2014 search video still gets views in 2026. Zenn: plan for "a portfolio of cheap attempts over months, not a hit every time" (170x spread between hit and dud).

---

## 1. Source Gathering & Topic Scoring

| Creator | Practice | Numbers |
|---|---|---|
| WatchMojo | Research team idents trending topics → writers 200-300 word scripts; "Suggestions" section lets users upvote future video ideas (crowdsourced topic queue) | 6+ videos/day |
| Kurzgesagt | In-house researcher produces 10-page-to-dozens-of-pages source doc BEFORE any writing: Wikipedia → primary papers → meta-analyses → books. Fact-checking team ~6 people. Writer shapes story only after research exists | 1 video/2 weeks (short) |
| TheAIGRID | Daily-ish pipeline, fixed sub-formats so only content changes day-to-day | ~6.4 videos/week avg; 900+ videos |
| Wes Roth | Personal AI agent (via Telegram/OpenClaw) runs overnight: builds AI-news aggregator, ranks stories by "how big the story is" algorithm, researches podcast guests, pulls YouTube API data (views, publish time, length) into local DB for analysis | Agent-scraped YouTube data, free daily API quota |
| Matt Wolfe | Perplexity Comet: summarize 4 articles at once; pull key takeaways from long YT videos; organize research into tabs | — |
| Fireship | Demo-first outcomes from trending dev topics | — |
| Mrwhosetheboss | ChatGPT ideation: inputs high-performing titles + prompts, skims dozens of AI variations "to spark better human ideas"; "turns a day's worth of work into 10 minutes — if you already know what good looks like" | 1% improvements culture |
| MagnatesMedia | Idea → research → script → voiceover → edit → thumbnail as the canonical 6-step faceless pipeline | — |

**Copyable scoring rules:**
- Topic strength check (Satura/GainExpert pattern): every topic scores on 4 signals — (a) everyone recognizes it, (b) few understand it, (c) the economics are unintuitive, (d) visuals can explain it without a talking head. Reject topics with no stakes/contradiction.
- Outlier principle (OutlierKit): find videos doing **5-10x above a channel's baseline**, reverse-engineer topic + angle, build next 4 videos from that — not from what you personally find interesting.
- Zenn's proven lanes = "ordinary behavior in a prehistoric/existential context" and "your mind/body has a hidden blind spot." Biggest breakout: "What Did Ancient Humans Do at Night?" at 7.7M views (233x the channel's median).
- Open-source reference pipeline: `dark2c/viral-faceless-shorts-generator` — Google Trends topic detection → Gemini script → manual approval gate → Piper TTS → Aeneas forced alignment → FFmpeg. The **manual approval gate** is the load-bearing idea.

---

## 2. Script & LLM Use

### Zenn — the full repeatable template (highest ROI find of this research)
**Three-beat opening hook** (write these 3 sentences BEFORE anything else):
- Beat 1 — pull viewer into present moment (second person, present tense, something they do daily):
  - "Tonight, when the sun goes down, you're going to flip a switch. Light will flood the room, and you won't think twice about it."
- Beat 2 — pull the rug: the taken-for-granted thing is wrong/strange:
  - "But for 99.9% of human history, that switch didn't exist. When the sun set, the world went dark. You couldn't even see your own hand."
- Beat 3 — seal the open loop (promise only finish-watching collects):
  - "And the answer will change everything you think you know about sleep."

**Snap-back close** — never "like and subscribe"; the final sentence snaps the abstract topic onto the viewer personally:
- "We traded all of that for a light switch, and most of us never even knew it was gone."
- "We are still hunter-gatherers. We just stopped doing it."

**Borrowed authority** — cite real research, never reworded Wikipedia (Calhoun's Universe-25, Belyaev's silver-fox experiment, Hadza 2.5hrs/day work).

### Script length / LLM writing specs
| Creator/System | Spec |
|---|---|
| AI news pipeline (faceless, verified) | 600-900 words per 6-8 min video; fixed structure by sub-format |
| PickGearLab faceless script prompt spec | ~800 words: 15s open-loop hook, 4 sections w/ concrete examples, 20s close that pays off the hook; **write for the ear** |
| Rule of thumb | 150 words ≈ 1 minute of voiceover |
| The Infographics Show | 1,500-2,500 word scripts; 1-2 weeks script-to-publish; 40-80 hrs production/video; 15-25 staff |
| AI explainer script structure (Cliprise) | Hook 0-10s (name the viewer's exact pain), Bridge 10-20s (solution category, don't name product), Demo 20-70s (every claim gets a visual), CTA 80-90s (ONE action). 90s ≈ 210 words |

### LLM role per creator
- **Mrwhosetheboss**: ChatGPT for ideation only (title + prompt → 10s of variants → human picks). Explicitly: "not a creator, a collaborator."
- **WatchMojo**: now integrating ChatGPT + Gemini into ideation, research, scripting support, metadata — "without losing the editorial judgment."
- **Wes Roth**: Claude as a "second brain" — raw notes/files handed to the model as a queryable memory layer (Claude Code + projects as the durable context wrapper).
- **Two Minute Papers**: no LLM drafting; the script IS the scientist's own plain-English explanation of the paper. Structure: big idea → how researchers approached it → visual results → limitations (explicit rule: "I always talk about the limitations"). "First Law of Papers" closing: look two papers down the line.
- **LEMMiNO**: months of research assembled into "an informative and entertaining package" — the research is the raw material, the writer assembles.
- **MKBHD**: script = thesis → context → details (3-step). Then distraction-free edit, light music.

**Prompt engineering pattern for a factory** (from The AI Garage/Cliprise class of workflows): one prompt produces a "production map" — every scene numbered with (a) voiceover line, (b) image prompt, (c) video prompt. Generate scene-by-scene, never the whole script in one block (allows selective regeneration, tone consistency, best-take mixing).

---

## 3. Video Editing Settings (exact numbers)

### Captions (1080x1920, Blitzcut spec)
- Minimum readable: 48-55px
- Standard talking-head/educational: **60-75px**
- Hype/motivation: 75-95px
- Hard max: 100px
- Text block zone: 12-20% of frame height
- Zenn: hard-burned subtitles, one bold word at a time (animated keyword emphasis)
- Caption style matters per niche (finance=calm/trust, history=cinematic, AI news=clear+fast)

### Pacing / cut density
- MrBeast: retention editing; up to 8 editors per video; **mini-payoff every 30-60 seconds** ("payoff ladder"); current shift from hyper-stimulation to "breathing room" — stillness now reads as premium; editors must know the exact minute-mark drop-offs from analytics
- Mrwhosetheboss: anti-retention-editing stance — "allergic" to overstimulation; previously used timers ("time is everywhere") then rejected them in favor of "a story so interesting people aren't thinking about time"; the tier above is "one thing to look at at any moment, you're the director." Newest videos = constant angles/text/graphics even 12-15 min in (that's his director Josh)
- Fireship: hook in first 5-10s; **outcome-first** (show working demo before setup) creating "outcome debt" — the viewer owes attention to resolve the gap
- Faceless AI news: visual style is "literal rather than cinematic" (screen capture + benchmark charts + announcement page) — speed over polish in news niches
- AI documentary/explainer pacing rule: **cut faster when the concept is familiar, slow down when abstract**; every scene has one job: clarify, escalate, or reframe

### Audio levels (Cliprise verified layering spec)
- Layer 1 — Voiceover: 0 dB (dominant)
- Layer 2 — Music: **-10 to -15 dB below voiceover**; fade in at opening, fade out at CTA
- Layer 3 — SFX: sparse, at key visual moments, **-6 to -10 dB**
- (horizon-ai already: sidechain ducking + loudnorm -14 LUFS — consistent with these numbers)

### Export
- 1080p floor; 4K only where niche demands (AI visual channels grade deliberately *down* — VHS noise/soft focus — to hide generation artifacts, per Josh Kerrigan's Neural Viz)

---

## 4. Hook & Retention

### TikTok/Shorts first-3-seconds (tugan.ai + Increditors 1,000-video study)
- Window is **1-4 seconds**. Jenny Hoyos: "You have one second to hook someone, especially on Shorts."
- **Three layers fire at once**: first frame + first sentence + text overlay. Design all three together.
- Batch-write **10 hooks per idea**, pick the one that works when watched on mute.
- Increditors hook frameworks ranked (composite = 30s retention 40% / CTR 35% / views 25%):
  1. **Pattern interrupt** — best overall; violates expectation in first 2s (mid-sentence cold open, jarring cut, unexpected sound)
  2. **Shocking statistic** — best CTR (8.6% vs 6.4% dataset avg, +34%); e.g. "87% of people who start a YouTube channel quit within 90 days"
  3. **Outcome-first** — highest watch-time, moderate CTR
  4. Curiosity gap — bimodal; declining as audience sophistication rises
- **4-element hook formula**: relevance signal (who is this for, in first 3s) + stakes statement (specific/quantified beats vague 2.7:1) + promise (modest, over-delivered → 40% higher subscriber retention) + credibility signal (+11 pts 60s retention)
- "Hey guys, welcome back, today I'm going to be talking about..." = the most common opening in the dataset and the most correlated with sub-50% 1-minute retention.

### Pattern interrupt beats curiosity gap 2:1 on watch time (Increditors).

### Hook lines from Zenn (copyable sentence shapes)
- "You lived an entire life before the age of three... and you remember none of it."
- "Every species on this planet has spent millions of years adapting to Earth. Fish developed gills. Birds evolved hollow bones. And then there's us. We burn in our own sunlight. Our spines are falling apart."

### Completion & length
- Zenn videos ~8.5 min: "long enough for mid-roll ads, short enough that a meaningful share finish." **Completion rate is one of the heaviest signals the algorithm rewards.** Keep it as short as the title's promise allows.
- AI Uncovered: 6-12 min runtimes, publish within hours of news.

---

## 5. Audio

### TTS & voices
- Faceless AI news: **AI voice is near-universal; latency matters more than warmth** — audiences accept synthetic narration in this niche
- AI explainer TTS workflow (Cliprise): test **minimum 4-6 voices** on the same 3 lines (hook + mid info-dense section + CTA); generate in paragraph segments; ElevenLabs stability 0.68 / clarity 0.70 (their verified example)
- Voice-to-niche matching (OverseerOS): finance = calm trust; history = cinematic narration; AI news = clear, fast delivery. Consistent voice every video; never switch voices
- TheAIGRID/The AI Garage class of stack: GPT-4/script → image gen → ElevenLabs voiceover → CapCut
- Zenn visual style note: AI voice + doodle visuals + hard captions; "everything that scares people off has been engineered away"
- Two Minute Papers: signature verbal greeting "Dear Fellow Scholars, this is Two Minute Papers with Dr. Károly Zsolnai-Fehér" — a fixed audio brand element (equivalent of the hook-in-the-voice)

### Music
- MrBeast: sound design (risers, silence, impacts) drives retention — one of his core editing principles (FT Creative analysis)
- Kurzgesagt: original ambient score per video
- Music bed spec: -10 to -15 dB under VO, fades in/out (above)
- WatchMojo: professional VO + consistent branding as the faceless standard

---

## 6. Publishing & Growth / Monetization Stacking

### Cadence
| Creator | Cadence |
|---|---|
| WatchMojo | 6+ videos/day main channel; 20-30/day claimed across network; ~2,190/yr compounding search library |
| TheAIGRID | ~6.4 uploads/week (~1/day) |
| Zenn | ~2.1 videos/week (~9/month) |
| The Infographics Show | 5-7 videos/week |
| Techquickie/LTT | daily including weekends; video-tracker spreadsheet for production state |
| Mrwhosetheboss | two production groups — one for fast/quick turnaround, one for non-time-sensitive content |
| AI Uncovered | publish within hours of the news (timeliness is the format's value) |

### Titles (air.io study of 18,000 channels, 11 niches, 4 size tiers)
- **30-50 chars** = universal sweet spot (survives mobile truncation at ~60-70 chars, fits keyword + hook)
- **Curiosity language is the only signal that transfers across ALL niches/sizes**: "what nobody tells you," "the real reason," "I finally found"
- Numbers work only when they carry a specific promise ("$50K in 6 months") or intrinsic interest; decorative numbers ("7 gaming tips") do nothing
- Keyword-first only in search-driven niches (front-load in first 40% of title); in browse niches put the hook first
- Questions work when the viewer already has the question in their head ("What happens if you don't sleep for 72 hours?")
- Brackets [x] modest positive effect at 100K-1M and 1M-10M tiers
- **Warning**: clickbait packaging gets suppressed by YouTube's quality classifiers — perceived manipulation reduces distribution

### Title formulas that bank (Monica Njuguna, 1,000+ viral faceless videos reverse-engineered)
1. Curiosity Gap: `[Unexpected Subject] + [Surprising Outcome] + [Time Constraint]`
2. Negative Assertion: `[Common Advice] + [Is a Lie] + [Real Solution]`
3. Numbered Case Study: `[Number] + [Action] + [Result] + [Time Frame]`
4. Specific Niche Breakdown: `[Hyper-Specific Audience] + [Undiscovered Hack] + [Benefit]`
5. Threat/Fear: `[Pain Point] + [Shocking Revelation] + [Solution]`

### Cross-posting & distribution
- WatchMojo: 35+ YouTube channels (MsMojo, MojoPlays, BrickMojo...), plus Facebook/Twitter/Snapchat; multi-language pipelines; FAST channels + livestreams
- Mrwhosetheboss: YouTube + Instagram + TikTok to reach different segments
- MrBeast: YouTube is the core; shorts from long-form
- The Archive (AI fiction): TikTok + Instagram + YouTube + Substack + Patreon + Discord + Spotify, ~4 stories/week

### Monetization stacking
- WatchMojo: ads + brand licensing/syndication (80% of revenue was licensing in 2012), sponsorships, FAST + podcasts + trivia app + livestreams
- Mrwhosetheboss: ads + sponsorships + **affiliate marketing** + brand collaborations (per Studio Supply analysis)
- **Shorts RPM reality check (air.io, 274 channels)**: $0.02-$1.48 RPM by niche; Shorts = **3-14% of long-form RPM**; 11,000-34,000 Shorts views ≈ 1,000 long-form views. Shorts are a growth channel, not the primary income channel.
- Faceless documentary/finance format: $10-25 CPM (B2B advertiser demand) at 9-12 min runtime
- Zenn estimate (public data): $2K-6K/mo total, $1K-2K/mo ad revenue at ~621K avg views/video
- The Infographics Show: premium CPM moat built on original custom vector art — owned visual assets as the defensible income layer
- The Archive's model (fully independent): **Patreon + book sales, zero ads** — audience-funded AI fiction, one full-time income

### Feedback loops
- Wes Roth: AI agent scrapes YT API into local DB → asks it analytical questions ("is there a linear relationship between video length and views?") → found a weak local optimum at 26-34 min. Let the model test hypotheses on your own data.
- Mrwhosetheboss: "Pay attention to the comments. Implement them. Do that 500 times and you're a good YouTuber."
- 48-72h post-publish check: CTR + first-hour retention vs channel average; then double down on outlier signals.

---

## 7. Proven Viral Formulas / Templates

1. **The Zenn template (the most complete copyable formula found)**: everyday question + ancient/existential framing + three-beat hook + borrowed authority + snap-back close + ~8.5 min runtime. Title written FIRST. Run as a series ("What Did Ancient Humans Do X?" / "The ___ Effect") so the algorithm already knows your audience.
2. **WatchMojo top-10 shell**: `Top 10 [Superlative] [Category] [of All Time/Ever/You've Never Seen]` — plug new topic into proven frame, six times a day. Infinite content from one template.
3. **Kurzgesagt research-first**: research doc (10+ pages) before a single scripted sentence. The moat is the fact-check, not the animation.
4. **Two Minute Papers format**: big idea → approach → visual results → limitations (the credibility rule: "no one can change what I say here") + fixed greeting + "First Law of Papers" closer. Trust as the retention engine.
5. **MKBHD 3-step script**: thesis → context → details; quiet editing, light music — the "adult" counter-position to retention editing.
6. **Mrwhosetheboss recipe**: constant visual storytelling (angles/text/graphics persist past minute 12) but one focal element at a time; timers rejected in favor of story; the "document" — write your style down granularly ("the font, the outline, the thickness of that outline") so any hire can reproduce it. **This is the exact pattern the horizon-ai editing_style_preset jsonb should encode.**
7. **Business-explainers spine (Satura/GainExpert)**: big number → bigger risk → hidden mechanic → counterintuitive payoff. Thumbnail exposes the pressure point, not the object. Every scene clarifies/escalates/reframes.
8. **Faceless news pipeline**: monitoring sweep (20-30 min, skip days with nothing) → angle (15 min, "what the story is beyond X released Y") → verify against primary source (20-30 min — the step most channels skip) → script (45-60 min) → VO (10-15 min) → capture+assembly (60-90 min) → package (20-30 min). ~3-4 hrs announcement-to-published.

---

## 8. Creator-by-Creator Operational Summary

| Creator | Format | AI/LLM use | Key number |
|---|---|---|---|
| MrBeast | big-budget challenge | analytics-driven retention editing, 8 editors | payoff every 30-60s |
| Zenn | faceless doodle explainer | script template + borrowed authority | 7.7M on one video; 150K subs/2mo |
| Kurzgesagt | animation essay | research-factcheck team, no LLM drafting | 6-person fact-check; 10+ page docs |
| Fireship | code explainer | outcome-first structure | hook in 5-10s |
| MKBHD | tech review | 3-step script | — |
| Two Minute Papers | paper explainer | script = scientist's plain-English | limitations always stated |
| SunnyV2 | creator-essay documentary | research-heavy commentary | 4.4M subs / 1.4B views |
| MagnatesMedia | documentary essay | 6-step pipeline (idea→research→script→VO→edit→thumb) | — |
| LEMMiNO | documentary essay | months of research, human assembly | — |
| The Infographics Show | top-list explainer | custom vector art factory | 5-7 vids/wk, 15-25 staff |
| WatchMojo | top-10 machine | now ChatGPT+Gemini for ideation/research/metadata | 6+ vids/day; 35+ channels; MojoUnity CMS/CRM/ERP |
| Mrwhosetheboss | tech review/features | ChatGPT ideation (titles→variants) | 2-person core team; 1% improvements |
| Techquickie | quick explainer | script review keeps voice consistent (Linus writes <25%) | daily incl. weekends |
| AI Uncovered | AI explainers (faceless) | stock B-roll + AI voiceover | 6-12 min; publish in hours |
| TheAIGRID | AI news/tutorials | GPT-4 script + make.com agents + ElevenLabs | ~6.4 uploads/wk; 900+ videos |
| Matt Wolfe | AI news | Perplexity Comet (4 articles at once) | — |
| Wes Roth | AI news + podcast | Telegram/OpenClaw agent runs overnight research + data analysis | 305K subs; agent-scraped YT API DB |

---

## 9. Gaps & Caveats
- SunnyV2, LEMMiNO, The Infographics Show, Kurzgesagt: no published tool-stack details; their "LLM use" is inferred (none confirmed publicly). Two Minute Papers confirmed zero LLM drafting.
- TheAIGRID's $26,890/mo agent-system number is from a third-party tutorial summary, not the channel; treat as marketing copy.
- WatchMojo/AI Uncovered subscriber numbers are recent-snapshot, not constant.
- No confirmed word-for-word scripts or per-video budgets from MrBeast's team beyond FT Creative/Business Insider descriptions.

## Source Index
- MrBeast: businessinsider.com (2025-8, production team), ftcreative.co/blog/mrbeasts-editing-style
- Zenn: fableclip.com/blog/youtube-automation-faceless-channels (full teardown), outlierkit.com/channel/zenn0009
- Kurzgesagt: medium.com/@Kurzgesagt/how-research-and-factchecking-work-at-kurzgesagt-f5b239188255
- Fireship: wisp.blog/blog/how-to-create-video-content-like-fireship-hyperplexed-and-juxtoposed
- MKBHD: youtube.com/watch?v=3dQ6yKSttEc
- Two Minute Papers: aiitinfluencers.com/articles/two-minute-papers; medium.com/aifromscratch/videos-two-minute-papers-b7eeed064db6; youtube.com/@twominutepapers
- SunnyV2: grokipedia.com/page/sunnyv2
- MagnatesMedia: scribd.com/document/801866181/3-The-Full-Process-For-Creating-Videos
- LEMMiNO: rosetta.to/u/lemmino/5-000-000-q-a
- The Infographics Show: leaxor.com/creators/the-infographics-show
- WatchMojo: en.wikipedia.org/wiki/WatchMojo.com; becomeviral.com/blog/watchmojo-case-study; faceless.directory/blog/is-watchmojo-faceless; contextisking.com (MojoUnity)
- Mrwhosetheboss: rosetta.to/u/colinandsamir/an-honest-conversation-with-mrwhosetheboss; thewantrepreneurshow.com; oscarlagrosen.medium.com; studiosupply.com
- Techquickie/LTT: rosetta.to/u/linustechtips/how-our-videos-are-made
- AI Uncovered: outlierkit.com/resources/faceless-ai-news-youtube-channels; asted.cloud channel analytics
- TheAIGRID: agentsindex.ai/theaigrid; inthacity.com (tutorial summary)
- Matt Wolfe: kazuha.ai/sources/matt-wolfe/posts/how-i-make-my-ai-news-videos
- Wes Roth: youtube.com/watch?v=Mz7W0qNlmOw (OpenClaw agent); canto.so/experts/wes-roth; ai-tldr.dev (Claude second brain)
- Shorts RPM: air.io/en/air-data-findings/what-is-youtube-shorts-rpm-in-your-niche-in-2026
- Captions: blitzcutai.com/blog/best-caption-size-tiktok-2026
- Hooks: tugan.ai/blog/how-to-write-tiktok-hooks; increditors.com/youtube-hook-frameworks-2026-data
- Titles: air.io/en/audience-growth/how-to-write-a-youtube-title-that-gets-clicked-research-across-11-niches; medium.com/@monicanjuguna/5-title-formulas-that-made-a-faceless-youtube-channel-bank-10-000-and-how-to-steal-them-145ebe71e8c6
- Faceless stack: pickgearlab.com; outlierkit.com; ovseeros.com; cliprise.app/learn/workflows; thedaringcreatives.com; github.com/dark2c/viral-faceless-shorts-generator
