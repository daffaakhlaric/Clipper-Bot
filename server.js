const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const { promisify } = require("util");
const Anthropic = require("@anthropic-ai/sdk");

// Dynamic import for uuid (ES Module compatibility)
const getUuidv4 = async () => {
  const { v4 } = await import('uuid');
  return v4().slice(0, 8);
};

const execAsync = promisify(exec);
const app = express();
const PORT = 4000;

app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use("/clips", express.static("clips"));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

["clips", "temp"].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ─────────────────────────────────────────────
// DEPS CHECK
// ─────────────────────────────────────────────
async function checkDeps() {
  const results = {};
  for (const cmd of ["yt-dlp --version", "ffmpeg -version"]) {
    try {
      await execAsync(cmd);
      results[cmd.split(" ")[0]] = true;
    } catch {
      results[cmd.split(" ")[0]] = false;
    }
  }
  return results;
}

// ─────────────────────────────────────────────
// VIDEO INFO & SUBTITLES
// ─────────────────────────────────────────────
async function getVideoInfo(url) {
  const { stdout } = await execAsync(
    `yt-dlp --js-runtimes node --dump-json --no-playlist --cookies-from-browser chrome "${url}"`,
    { timeout: 30000 }
  );
  return JSON.parse(stdout);
}

async function downloadSubtitles(url, jobId) {
  const outPath = path.join("temp", jobId);
  try {
    await execAsync(
      `yt-dlp --js-runtimes node --write-auto-sub --skip-download --sub-lang id,en --convert-subs srt --cookies-from-browser chrome -o "${outPath}" "${url}"`,
      { timeout: 60000 }
    );
    const files = fs
      .readdirSync("temp")
      .filter((f) => f.startsWith(jobId) && f.endsWith(".srt"));
    if (files.length > 0) {
      return fs.readFileSync(path.join("temp", files[0]), "utf-8");
    }
  } catch (e) {}
  return null;
}

function parseSRT(srt) {
  return srt
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.trim().split("\n");
      if (lines.length < 3) return null;
      const m = lines[1].match(
        /(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/
      );
      if (!m) return null;
      const s = (h, mn, sc, ms) => +h * 3600 + +mn * 60 + +sc + +ms / 1000;
      return {
        start: s(m[1], m[2], m[3], m[4]),
        end: s(m[5], m[6], m[7], m[8]),
        text: lines.slice(2).join(" ").replace(/<[^>]+>/g, "").trim(),
      };
    })
    .filter(Boolean);
}

// ─────────────────────────────────────────────
// ✨ NEW: Slice SRT to clip window & write temp file
// ─────────────────────────────────────────────
function sliceSRTToClip(srtRaw, clipStart, clipEnd, outSrtPath) {
  const entries = parseSRT(srtRaw);
  const fmt = (sec) => {
    const h = Math.floor(sec / 3600);
    const mn = Math.floor((sec % 3600) / 60);
    const sc = Math.floor(sec % 60);
    const ms = Math.round((sec % 1) * 1000);
    return `${String(h).padStart(2, "0")}:${String(mn).padStart(2, "0")}:${String(sc).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
  };
  const shifted = entries
    .filter((e) => e.end > clipStart && e.start < clipEnd)
    .map((e, i) => {
      const s = Math.max(0, e.start - clipStart);
      const en = Math.min(clipEnd - clipStart, e.end - clipStart);
      return `${i + 1}\n${fmt(s)} --> ${fmt(en)}\n${e.text}`;
    });
  fs.writeFileSync(outSrtPath, shifted.join("\n\n") + "\n");
  return shifted.length > 0;
}

// ─────────────────────────────────────────────
// CLAUDE: Generate clip ideas
// ─────────────────────────────────────────────
async function generateClipIdeas(videoInfo, transcript, strategy) {
  const strategyPrompts = {
    viral: "Focus on emotionally engaging moments, surprising facts, strong hooks (first 3 seconds), and high-energy segments that stop scrolling.",
    educational: "Extract clear tips, how-to segments, key insights, and step-by-step explanations that provide standalone value.",
    testimonial: "Find personal stories, results, transformations, client success moments, and emotional breakthroughs.",
    property: "Extract property features, pricing mentions, location advantages, agent pitches, and call-to-action moments — ideal for PropertyKlik listings.",
    highlights: "Find the most quoted, memorable, or impactful moments — the 'greatest hits' of the video.",
  };

  const transcriptText = transcript
    ? transcript.map((t) => `[${t.start.toFixed(1)}s] ${t.text}`).join("\n")
    : `Video title: "${videoInfo.title}"\nDuration: ${videoInfo.duration}s\n(No transcript available)`;

  const prompt = `You are an expert video editor and content strategist. Analyze this YouTube video and generate clipping ideas.

VIDEO INFO:
Title: ${videoInfo.title}
Duration: ${videoInfo.duration} seconds (${Math.floor(videoInfo.duration / 60)}m ${videoInfo.duration % 60}s)
Channel: ${videoInfo.uploader || "Unknown"}
Description snippet: ${(videoInfo.description || "").slice(0, 500)}

STRATEGY: ${strategy}
${strategyPrompts[strategy] || strategyPrompts.viral}

TRANSCRIPT/TIMELINE:
${transcriptText}

Generate exactly 6 clip ideas. Each clip should be 30-90 seconds long.
Respond ONLY with valid JSON array, no markdown, no explanation:

[
  {
    "id": 1,
    "title": "Clip title",
    "hook": "Why this clip will perform well",
    "start": 10.5,
    "end": 55.0,
    "duration": 44.5,
    "category": "educational|viral|testimonial|highlight|cta",
    "viralScore": 85,
    "platforms": ["TikTok", "Reels", "Shorts"],
    "caption": "Suggested social media caption with hashtags"
  }
]`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content[0].text.trim();
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ─────────────────────────────────────────────
// ✨ UPGRADED: cutClip — subtitle burn-in + format crop
// format: "16:9" | "9:16" | "1:1"
// ─────────────────────────────────────────────
async function cutClip(videoPath, start, end, outputPath, options = {}) {
  const duration = end - start;
  const { subtitlePath, format = "16:9" } = options;

  const filters = [];

  // Crop/scale for format
  if (format === "9:16") {
    // Scale height to 1920, then crop width to 1080 (center)
    filters.push("scale=-2:1920");
    filters.push("crop=1080:1920:(iw-1080)/2:0");
  } else if (format === "1:1") {
    filters.push("scale=-2:1080");
    filters.push("crop=1080:1080:(iw-1080)/2:0");
  }

  // Subtitle burn-in (applied after crop so font size is consistent)
  if (subtitlePath && fs.existsSync(subtitlePath)) {
    const escaped = subtitlePath.replace(/\\/g, "/").replace(/:/g, "\\:");
    const fontSize = format === "9:16" ? 20 : 16;
    const marginV = format === "9:16" ? 80 : 40;
    filters.push(
      `subtitles='${escaped}':force_style='FontName=Arial,FontSize=${fontSize},Alignment=2,MarginV=${marginV},PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=2,Shadow=1'`
    );
  }

  const vf = filters.length > 0 ? `-vf "${filters.join(",")}"` : "";
  const cmd = `ffmpeg -y -ss ${start} -i "${videoPath}" -t ${duration} ${vf} -c:v libx264 -c:a aac -preset fast -crf 23 "${outputPath}"`;
  await execAsync(cmd, { timeout: 180000 });
}

async function downloadVideo(url, jobId) {
  const outPath = path.join("temp", `${jobId}_full.mp4`);
  await execAsync(
    `yt-dlp --js-runtimes node -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best[height<=720]" --merge-output-format mp4 --cookies-from-browser chrome -o "${outPath}" "${url}"`,
    { timeout: 300000 }
  );
  return outPath;
}

// ─────────────────────────────────────────────
// Shared clipping pipeline (used by single + batch)
// ─────────────────────────────────────────────
async function executeClipping(jobId, { format = "16:9", burnSubtitles = false }) {
  const job = jobs[jobId];
  const videoPath = await downloadVideo(job.url, jobId);

  job.status = "cutting_clips";
  const total = job.clipIdeas.length;

  for (let i = 0; i < total; i++) {
    const clip = job.clipIdeas[i];
    const safeName = clip.title.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 28);
    const fmtTag = format === "9:16" ? "_9x16" : format === "1:1" ? "_1x1" : "_16x9";
    const subTag = burnSubtitles ? "_sub" : "";
    const filename = `clip_${jobId}_${String(i + 1).padStart(2, "0")}_${safeName}${fmtTag}${subTag}.mp4`;
    const outputPath = path.join("clips", filename);

    const start = Math.max(0, clip.start);
    const end = Math.min(job.videoInfo.duration, clip.end);

    // Write clip-specific SRT
    let clipSrtPath = null;
    if (burnSubtitles && job.srtRaw) {
      clipSrtPath = path.join("temp", `${jobId}_c${i}.srt`);
      const hasEntries = sliceSRTToClip(job.srtRaw, start, end, clipSrtPath);
      if (!hasEntries) clipSrtPath = null;
    }

    await cutClip(videoPath, start, end, outputPath, {
      subtitlePath: clipSrtPath,
      format,
    });

    if (clipSrtPath && fs.existsSync(clipSrtPath)) fs.unlinkSync(clipSrtPath);

    job.generatedClips.push({
      ...clip,
      filename,
      downloadUrl: `/clips/${filename}`,
      fileSize: fs.statSync(outputPath).size,
      format,
      burnSubtitles,
    });
    job.clipProgress = Math.round(((i + 1) / total) * 100);
  }

  if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
  job.status = "completed";
}

// ─────────────────────────────────────────────
// JOB & BATCH STORES
// ─────────────────────────────────────────────
const jobs = {};
const batchJobs = {};

// ─────────────────────────────────────────────
// ✨ NEW: Batch processing pipeline (up to 10 URLs)
// ─────────────────────────────────────────────
async function processBatchAnalyze(batchId) {
  const batch = batchJobs[batchId];
  batch.status = "running";
  batch.startedAt = Date.now();

  // Process sequentially to avoid hammering yt-dlp / Claude
  for (let i = 0; i < batch.urls.length; i++) {
    const entry = batch.urls[i];
    entry.status = "analyzing";
    batch.currentIndex = i;

    try {
      const jobId = await getUuidv4();
      jobs[jobId] = {
        status: "fetching_info",
        url: entry.url,
        strategy: batch.strategy,
        progress: 0,
        clipIdeas: [],
        generatedClips: [],
      };
      entry.jobId = jobId;

      const videoInfo = await getVideoInfo(entry.url);
      jobs[jobId].videoInfo = {
        title: videoInfo.title,
        duration: videoInfo.duration,
        thumbnail: videoInfo.thumbnail,
        uploader: videoInfo.uploader,
      };

      jobs[jobId].status = "fetching_transcript";
      const srtRaw = await downloadSubtitles(entry.url, jobId);
      jobs[jobId].srtRaw = srtRaw;
      const transcript = srtRaw ? parseSRT(srtRaw) : null;
      jobs[jobId].hasTranscript = !!transcript;

      jobs[jobId].status = "generating_ideas";
      const clipIdeas = await generateClipIdeas(videoInfo, transcript, batch.strategy);
      jobs[jobId].clipIdeas = clipIdeas;
      jobs[jobId].status = "ready_to_clip";
      jobs[jobId].progress = 100;

      entry.status = "analyzed";
      entry.title = videoInfo.title;
      entry.thumbnail = videoInfo.thumbnail;
      entry.duration = videoInfo.duration;
      entry.clipCount = clipIdeas.length;
    } catch (err) {
      entry.status = "error";
      entry.error = err.message;
      if (entry.jobId) {
        jobs[entry.jobId].status = "error";
        jobs[entry.jobId].error = err.message;
      }
    }

    batch.completedCount = (batch.completedCount || 0) + 1;
  }

  batch.status = "all_analyzed";
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

app.get("/api/status", async (req, res) => {
  const deps = await checkDeps();
  res.json({ status: "ok", deps, jobs: Object.keys(jobs).length });
});

// ── Single: Analyze ──
app.post("/api/analyze", async (req, res) => {
  const { url, strategy = "viral" } = req.body;
  if (!url) return res.status(400).json({ error: "URL required" });

  const jobId = await getUuidv4();
  jobs[jobId] = { status: "analyzing", url, strategy, progress: 0, clipIdeas: [], generatedClips: [] };
  res.json({ jobId });

  (async () => {
    try {
      jobs[jobId].status = "fetching_info";
      jobs[jobId].progress = 10;

      const videoInfo = await getVideoInfo(url);
      jobs[jobId].videoInfo = {
        title: videoInfo.title,
        duration: videoInfo.duration,
        thumbnail: videoInfo.thumbnail,
        uploader: videoInfo.uploader,
        view_count: videoInfo.view_count,
      };
      jobs[jobId].progress = 30;

      jobs[jobId].status = "fetching_transcript";
      const srtRaw = await downloadSubtitles(url, jobId);
      jobs[jobId].srtRaw = srtRaw;
      const transcript = srtRaw ? parseSRT(srtRaw) : null;
      jobs[jobId].hasTranscript = !!transcript;
      jobs[jobId].progress = 50;

      jobs[jobId].status = "generating_ideas";
      const clipIdeas = await generateClipIdeas(videoInfo, transcript, strategy);
      jobs[jobId].clipIdeas = clipIdeas;
      jobs[jobId].progress = 80;

      jobs[jobId].status = "ready_to_clip";
      jobs[jobId].progress = 100;
    } catch (err) {
      jobs[jobId].status = "error";
      jobs[jobId].error = err.message;
    }
  })();
});

// ── Single: Clip ──
app.post("/api/clip", async (req, res) => {
  const {
    jobId,
    selectedClips,
    burnSubtitles = false,
    format = "16:9",
  } = req.body;

  const job = jobs[jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  if (["downloading_video", "cutting_clips"].includes(job.status))
    return res.status(400).json({ error: "Already processing" });

  // Override clipIdeas with selection if provided
  if (selectedClips && selectedClips.length > 0) {
    job.clipIdeas = selectedClips;
  }

  job.status = "downloading_video";
  job.clipProgress = 0;
  job.generatedClips = [];

  res.json({ message: "Clipping started" });

  executeClipping(jobId, { format, burnSubtitles }).catch((err) => {
    job.status = "clip_error";
    job.error = err.message;
  });
});

// ── Batch: Start analyze ──
app.post("/api/batch/analyze", async (req, res) => {
  const { urls, strategy = "viral" } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0)
    return res.status(400).json({ error: "urls[] required" });
  if (urls.length > 10)
    return res.status(400).json({ error: "Max 10 URLs per batch" });

  const batchId = await getUuidv4();
  batchJobs[batchId] = {
    batchId,
    status: "queued",
    strategy,
    createdAt: Date.now(),
    totalCount: urls.length,
    completedCount: 0,
    currentIndex: -1,
    urls: urls.map((u) => ({ url: u, status: "pending" })),
  };

  res.json({ batchId });
  processBatchAnalyze(batchId);
});

// ── Batch: Poll ──
app.get("/api/batch/:batchId", (req, res) => {
  const batch = batchJobs[req.params.batchId];
  if (!batch) return res.status(404).json({ error: "Not found" });

  // Enrich with sub-job status
  const enriched = {
    ...batch,
    urls: batch.urls.map((e) => ({
      ...e,
      jobStatus: e.jobId ? jobs[e.jobId]?.status : undefined,
      clipProgress: e.jobId ? jobs[e.jobId]?.clipProgress : undefined,
    })),
  };
  res.json(enriched);
});

// ── Batch: Start clipping all analyzed ──
app.post("/api/batch/:batchId/clip", async (req, res) => {
  const { format = "9:16", burnSubtitles = true } = req.body;
  const batch = batchJobs[req.params.batchId];
  if (!batch) return res.status(404).json({ error: "Not found" });

  const toClip = batch.urls.filter(
    (e) => e.status === "analyzed" && e.jobId && jobs[e.jobId]?.status === "ready_to_clip"
  );
  if (toClip.length === 0)
    return res.status(400).json({ error: "No analyzed videos ready to clip" });

  res.json({ message: `Clipping ${toClip.length} videos`, count: toClip.length });

  batch.status = "clipping";

  // Process one at a time (sequential to save RAM/disk)
  (async () => {
    for (const entry of toClip) {
      const job = jobs[entry.jobId];
      job.status = "downloading_video";
      job.clipProgress = 0;
      job.generatedClips = [];
      entry.status = "clipping";

      try {
        await executeClipping(entry.jobId, { format, burnSubtitles });
        entry.status = "clipped";
        entry.clipCount = job.generatedClips.length;
      } catch (err) {
        entry.status = "error";
        entry.error = err.message;
      }
    }
    batch.status = "completed";
  })();
});

// ── Job poll ──
app.get("/api/job/:jobId", (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

// ── Clips list & delete ──
app.get("/api/clips", (req, res) => {
  const files = fs.readdirSync("clips").filter((f) => f.endsWith(".mp4"));
  res.json(files.map((f) => ({ filename: f, url: `/clips/${f}` })));
});

app.delete("/api/clips/:filename", (req, res) => {
  const fp = path.join("clips", req.params.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ deleted: true });
});

app.listen(PORT, () => {
  console.log(`\n🎬 ClipForge AI — http://localhost:${PORT}`);
  console.log(`   ✅ Subtitle burn-in  ✅ 9:16/1:1/16:9 crop  ✅ Batch queue (max 10)`);
});
