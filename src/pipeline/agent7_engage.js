/**
 * AGENT 7 — THE ENGAGEMENT ENGINE
 *
 * The growth lever every faceless pipeline ignores. viralScience.growthLevers
 * says it plainly: "Reply to every comment within the first hour = engagement
 * loop." A channel that answers questions and thanks genuine viewers gets a
 * measurable reply-rate lift (YouTube promotes videos with active thread
 * conversations, and a pinned-style conversation reads as a live channel, not
 * a zombie auto-poster).
 *
 * This agent does what no subscription tool (faceless.video, AutoShorts,
 * Blotato, OpusClip...) ships: it actually TALKS to the audience.
 *
 *   read    → list fresh top-level comments on recent published videos
 *   classify→ one batched Gemini pass: question / compliment / critique /
 *             spam / off-topic, plus an on-brand draft reply for the good ones
 *   reply   → post drafts via the YouTube API, never to spam/abuse, never
 *             twice (engagement table is the dedupe ledger), rate-capped per
 *             channel per pass
 *
 * Voice comes from the niche's editing_style_preset.voiceBrief (the
 * brand-voice brief also used by agent2's scriptwriting) so replies sound
 * like the channel, not like a generic bot. AUTO_ENGAGE=false (env or
 * dashboard OPS toggle) disables replying but still records reads.
 */
import { supabase, logEvent } from "../supabase.js";
import { config } from "../config.js";
import { llmJson } from "../lib/llm.js";
import { youtubeClient } from "../lib/youtubeClient.js";

const CLASSIFY_SYSTEM = `You are the community manager of a YouTube short-form channel.
Classify each viewer comment and draft a short, natural reply to post as the channel.

Classification must be exactly one of:
- question: asks the channel something (how/why/what/is this...)
- compliment: praise, appreciation, support, "love this"
- critique: disagreement or criticism (respectful or harsh)
- spam: self-promotion, links, gibberish, bots, scams
- off_topic: doesn't relate to the video or channel

Reply rules:
- Reply ONLY to 'question' and 'compliment'. Never reply to spam, off_topic, or critique.
- Drafts must match the channel voice below: sound like a real human creator, casual and
  specific, no corporate filler, no emoji spam, no sales pitch. Answer questions with a
  real answer where the video didn't cover it. Thank compliments briefly and specifically.
- Max 220 characters per draft. No quotes in JSON.

Return JSON only: {"items":[{"index":0,"classification":"question","should_reply":true,"draft":"..."}]}
Include every input comment, in order.`;

async function nichePreset(nicheName) {
  if (!nicheName) return {};
  const { data } = await supabase
    .from("niche_configurations")
    .select("editing_style_preset")
    .eq("niche_name", nicheName)
    .single();
  return data?.editing_style_preset || {};
}

/** Classify + draft replies for a batch of comments in one cheap LLM call.
 * Returns a Map(commentId → {classification, should_reply, draft}). */
async function classifyComments(comments, voiceBrief, nicheName) {
  const res = await llmJson({
    tier: "fast",
    temperature: 0.4,
    label: "engageClassify",
    messages: [
      { role: "system", content: `${CLASSIFY_SYSTEM}\n\nCHANNEL VOICE:\n${voiceBrief || `A casual, friendly ${nicheName || "creator"} who knows their niche well and talks like a real person.`}` },
      {
        role: "user",
        content: JSON.stringify(comments.map((c, index) => ({
          index,
          id: c.id,
          text: c.text.slice(0, 300),
          likes: c.likes,
        }))),
      },
    ],
  });
  const { items } = JSON.parse(res.content || "{}");
  const map = new Map();
  for (const item of items || []) {
    const comment = comments[Number(item.index)];
    if (!comment) continue;
    map.set(comment.id, {
      classification: String(item.classification || "off_topic"),
      should_reply: !!item.should_reply,
      draft: String(item.draft || "").trim().slice(0, 220),
    });
  }
  return map;
}

async function freshCommentIds(videoIds) {
  const { data } = await supabase
    .from("engagement")
    .select("comment_id")
    .in("youtube_video_id", videoIds);
  return new Set((data || []).map((r) => r.comment_id));
}

export async function runEngagementPass({ maxRepliesPerChannel = 8, maxCommentsPerVideo = 40 } = {}) {
  // Recent window: published WITHIN the last 21 days. (The old `.lte`
  // selected only videos older than that — the exact opposite of the
  // "reply while the thread is fresh" intent.)
  const cutoff = new Date(Date.now() - 21 * 86400000).toISOString();
  const { data: jobs, error } = await supabase
    .from("pipeline_logs")
    .select("id, youtube_video_id, target_channel, niche, publish_schedule")
    .not("youtube_video_id", "is", null)
    .gte("publish_schedule", cutoff)
    .order("publish_schedule", { ascending: false })
    .limit(15);
  if (error) throw new Error(`Engagement: could not load published jobs — ${error.message}`);

  const videoJobs = (jobs || []).filter((j) => j.youtube_video_id);
  if (!videoJobs.length) {
    await logEvent("Agent 7", "No published videos in the window — skipping engagement pass");
    return { read: 0, replied: 0, skipped: true };
  }

  await logEvent("Agent 7", `Engagement pass over ${videoJobs.length} recent published video(s)...`);
  const byChannel = Object.groupBy(videoJobs, (j) => j.target_channel || "primary");
  let read = 0;
  let replied = 0;
  let classified = 0;

  for (const [channelKey, channelJobs] of Object.entries(byChannel)) {
    let yt;
    try {
      yt = await youtubeClient(channelKey);
    } catch (err) {
      await logEvent("Agent 7", `No valid YouTube token for channel "${channelKey}" — skipping (${err.message})`, { level: "warn" });
      continue;
    }
    let replyBudget = maxRepliesPerChannel;
    // One dedupe query per channel, not per video — the old loop re-fetched
    // the identical comment_id set for every job in the channel.
    const seen = await freshCommentIds(channelJobs.map((j) => j.youtube_video_id));

    for (const job of channelJobs) {
      if (replyBudget <= 0) break;
      const preset = await nichePreset(job.niche);
      const voiceBrief = preset.voiceBrief || "";

      let videoMeta;
      try {
        const { data: meta } = await yt.videos.list({ part: ["snippet"], id: [job.youtube_video_id] });
        videoMeta = meta.items?.[0]?.snippet;
      } catch (err) {
        await logEvent("Agent 7", `Engagement: cannot fetch metadata for ${job.youtube_video_id} (${err.message})`, { level: "warn" });
        continue;
      }
      if (!videoMeta) continue;
      const uploaderChannelId = videoMeta.channelId;

      let threads;
      try {
        const { data } = await yt.commentThreads.list({
          part: ["snippet"],
          videoId: job.youtube_video_id,
          maxResults: maxCommentsPerVideo,
          textFormat: "plainText",
        });
        threads = data.items || [];
      } catch (err) {
        await logEvent("Agent 7", `Engagement: cannot list comments for ${job.youtube_video_id} (${err.message})`, { level: "warn" });
        continue;
      }

      const newComments = threads
        .map((t) => ({
          // replies.insert needs the *comment* id, not the enclosing thread
          // id. The old value created a fresh top-level channel comment rather
          // than an actual reply to the viewer.
          id: t.snippet?.topLevelComment?.id || t.id,
          videoId: job.youtube_video_id,
          author: t.snippet?.topLevelComment?.snippet?.authorDisplayName || "Unknown",
          authorChannelId: t.snippet?.topLevelComment?.snippet?.authorChannelId?.value || null,
          text: t.snippet?.topLevelComment?.snippet?.textDisplay || "",
          likes: Number(t.snippet?.topLevelComment?.snippet?.likeCount || 0),
        }))
        .filter((c) => c.text && !seen.has(c.id))
        // Never talk to the channel's own pinned/CTA comment.
        .filter((c) => c.authorChannelId !== uploaderChannelId);

      if (!newComments.length) continue;
      read += newComments.length;

      let verdicts = new Map();
      try {
        verdicts = await classifyComments(newComments, voiceBrief, job.niche);
        classified += newComments.length;
      } catch (err) {
        await logEvent("Agent 7", `Comment classification failed (${err.message}) — recording reads only`, { jobId: job.id, level: "warn" });
      }

      for (const comment of newComments) {
        const verdict = verdicts.get(comment.id);
        const row = {
          pipeline_log_id: job.id,
          youtube_video_id: comment.videoId,
          comment_id: comment.id,
          comment_author: comment.author,
          comment_text: comment.text.slice(0, 2000),
          comment_like_count: comment.likes,
          channel_key: channelKey,
          niche: job.niche,
          classification: verdict?.classification || "unclassified",
        };

        const shouldReply = config.autoEngage && verdict?.should_reply && verdict?.draft && replyBudget > 0;
        if (!shouldReply) {
          await supabase.from("engagement").insert(row).then(() => {}).catch(() => {});
          continue;
        }

        try {
          const { data: posted } = await yt.comments.insert({
            part: ["snippet"],
            requestBody: {
              snippet: { parentId: comment.id, textOriginal: verdict.draft },
            },
          });
          const replyId = posted?.id || null;
          // If this ledger write fails while the reply above succeeded, the
          // next pass would see an "unread" comment and reply AGAIN — surface
          // it loudly instead of swallowing.
          const { error: ledgerErr } = await supabase.from("engagement").insert({ ...row, status: "replied", reply_text: verdict.draft, reply_id: replyId, replied_at: new Date().toISOString() });
          if (ledgerErr) {
            await logEvent("Agent 7", `⚠ REPLY POSTED but ledger write failed (${ledgerErr.message}) — risk of duplicate reply to @${comment.author} next pass`, { jobId: job.id, level: "error" });
          }
          replyBudget--;
          replied++;
          await logEvent("Agent 7", `Replied to @${comment.author} on "${job.niche}": "${verdict.draft.slice(0, 60)}…"`, { jobId: job.id });
        } catch (err) {
          await supabase.from("engagement").insert({ ...row, status: "failed", reply_text: verdict.draft }).catch(() => {});
          await logEvent("Agent 7", `Reply to @${comment.author} failed (${err.message})`, { jobId: job.id, level: "warn" });
        }
        // Space replies out so a burst of comments never gets machine-gunned.
        if (replied > 0 && replied % 3 === 0) await new Promise((r) => setTimeout(r, 2500));
      }
    }
  }

  await logEvent("Agent 7", `✓ Engagement pass complete — ${read} new comment(s), ${classified} classified, ${replied} replied`);
  return { read, classified, replied };
}

export async function recentEngagement({ limit = 20 } = {}) {
  const { data, error } = await supabase
    .from("engagement")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

if (process.argv[1]?.endsWith("agent7_engage.js")) {
  runEngagementPass()
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
