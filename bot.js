// Momobit — a friendly Persian "file toolbox" Telegram bot.
// Webhook mode so the host's own inbound traffic keeps it awake. ffmpeg does
// the media work; the PDF writer is hand-rolled so there are no extra deps.

import { Bot, InlineKeyboard, InputFile, webhookCallback } from "grammy";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// ---- config ---------------------------------------------------------------
const TOKEN = process.env.BOT_TOKEN;
const CHANNEL = process.env.CHANNEL || "@parsv2r";
const CHANNEL_LINK = process.env.CHANNEL_LINK || "https://t.me/parsv2r";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;

if (!TOKEN) {
  console.error("BOT_TOKEN is missing.");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// Telegram only lets bots download files up to 20 MB — fail early and clearly.
const MAX_BYTES = 20 * 1024 * 1024;
const BRAND = "🧰 Momobit";

// Per-user scratch state. In-memory is fine: one instance, and nothing here
// is worth persisting across a restart.
const lastFile = new Map(); // userId -> { fileId, kind }
const albums = new Map();   // userId -> [fileId, ...]

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------
const welcomeText = (name) =>
`✨ سلام ${name} عزیز، به ${BRAND} خوش اومدی!

من یه جعبه‌ابزار کوچولو برای فایل‌هاتم 🎒

🖼 عکس → PDF (تکی یا چندتایی)
🗜 کم کردن حجم عکس
🎵 گرفتن صدای ویدیو (MP3)
🎬 کم کردن حجم ویدیو
🎞 ساخت GIF از ویدیو
🔇 حذف صدای ویدیو
🎤 تبدیل صدا به ویس تلگرام

کافیه یه عکس، ویدیو یا صدا برام بفرستی،
خودم می‌پرسم باهاش چیکار کنم 😊`;

const GATE_TEXT =
`🔒 یه قدم کوچیک تا شروع!

برای استفاده از ${BRAND} اول باید عضو کانال ما بشی 🌟
بعد از عضویت، دکمه‌ی «✅ عضو شدم» رو بزن.`;

const HELP_TEXT =
`راهنمای ${BRAND} 📖

فقط فایلت رو بفرست، بقیه‌ش با من:

🖼 *عکس* → PDF، فشرده‌سازی، یا اضافه‌کردن به آلبوم
🎬 *ویدیو* → MP3، فشرده‌سازی، GIF، حذف صدا
🎤 *صدا یا ویس* → MP3 یا ویس تلگرام

📚 *چند عکس در یک PDF:*
هر عکس رو بفرست و «افزودن به آلبوم» رو بزن،
آخرش دکمه‌ی ساخت PDF رو بزن.

📌 نکته‌ها:
— حداکثر حجم فایل ۲۰ مگابایته (محدودیت خود تلگرامه)
— فشرده‌سازی ویدیو ممکنه یکی دو دقیقه طول بکشه 🙏

دستورها: /start /help /pdf /clear`;

const mainMenuKb = () =>
  new InlineKeyboard().text("📖 راهنما", "help").row().url("🌟 کانال ما", CHANNEL_LINK);

const gateKb = () =>
  new InlineKeyboard().url("🌟 عضویت در کانال", CHANNEL_LINK).row().text("✅ عضو شدم", "recheck");

// ---------------------------------------------------------------------------
// Membership gate
// ---------------------------------------------------------------------------
async function isMember(userId) {
  try {
    const m = await bot.api.getChatMember(CHANNEL, userId);
    return ["member", "administrator", "creator"].includes(m.status);
  } catch (e) {
    console.error("getChatMember failed (is the bot an admin of the channel?):", e.description || e.message);
    return false;
  }
}

async function ensureMember(ctx) {
  if (await isMember(ctx.from.id)) return true;
  await ctx.reply(GATE_TEXT, { reply_markup: gateKb() });
  return false;
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} ${c}: ${err.slice(-400)}`))));
  });
}

function probeSize(path) {
  return new Promise((resolve) => {
    const p = spawn("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", path,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      const m = out.trim().match(/(\d+)x(\d+)/);
      resolve(m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1000, h: 1000 });
    });
    p.on("error", () => resolve({ w: 1000, h: 1000 }));
  });
}

// ---------------------------------------------------------------------------
// Minimal PDF writer — embeds JPEGs directly (DCTDecode), one per page.
// ---------------------------------------------------------------------------
function imagesToPdf(pages) {
  const parts = []; const offsets = []; let pos = 0;
  const push = (b) => { const x = Buffer.isBuffer(b) ? b : Buffer.from(b, "binary"); parts.push(x); pos += x.length; };
  const obj = (n, body) => { offsets[n] = pos; push(`${n} 0 obj\n`); push(body); push("\nendobj\n"); };

  const n = pages.length;
  const pageId = (i) => 3 + i * 3;
  const imgId = (i) => 4 + i * 3;
  const cntId = (i) => 5 + i * 3;
  const lastId = 2 + n * 3;

  push("%PDF-1.4\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] /Count ${n} >>`);

  pages.forEach((p, i) => {
    obj(pageId(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w} ${p.h}] ` +
      `/Resources << /XObject << /Im0 ${imgId(i)} 0 R >> >> /Contents ${cntId(i)} 0 R >>`);
    offsets[imgId(i)] = pos;
    push(`${imgId(i)} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} `);
    push("/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ");
    push(`/Length ${p.jpeg.length} >>\nstream\n`);
    push(p.jpeg);
    push("\nendstream\nendobj\n");
    const c = `q\n${p.w} 0 0 ${p.h} 0 0 cm\n/Im0 Do\nQ`;
    obj(cntId(i), `<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
  });

  const xrefStart = pos;
  push(`xref\n0 ${lastId + 1}\n`);
  push("0000000000 65535 f \n");
  for (let i = 1; i <= lastId; i++) push(String(offsets[i] ?? 0).padStart(10, "0") + " 00000 n \n");
  push(`trailer\n<< /Size ${lastId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
  return Buffer.concat(parts);
}

async function download(ctx, fileId, dir, name) {
  const f = await ctx.api.getFile(fileId);
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
  const path = join(dir, name);
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

// Normalise any image into a JPEG plus its true pixel size.
async function toJpegPage(ctx, fileId, dir, idx) {
  const src = await download(ctx, fileId, dir, `in${idx}`);
  const jpg = join(dir, `p${idx}.jpg`);
  await run("ffmpeg", ["-y", "-i", src, "-qscale:v", "3", jpg]);
  const { w, h } = await probeSize(jpg);
  return { jpeg: await readFile(jpg), w, h };
}

const tmp = () => mkdtemp(join(tmpdir(), "mb-"));

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------
async function jobImageToPdf(ctx, fileId) {
  const dir = await tmp();
  try {
    const page = await toJpegPage(ctx, fileId, dir, 0);
    await ctx.replyWithDocument(new InputFile(imagesToPdf([page]), "momobit.pdf"), {
      caption: `✅ آماده شد!\n\n${BRAND}`,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function jobAlbumPdf(ctx, ids) {
  const dir = await tmp();
  try {
    const pages = [];
    for (let i = 0; i < ids.length; i++) pages.push(await toJpegPage(ctx, ids[i], dir, i));
    await ctx.replyWithDocument(new InputFile(imagesToPdf(pages), "momobit.pdf"), {
      caption: `✅ PDF با ${pages.length} صفحه آماده شد!\n\n${BRAND}`,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function jobImageCompress(ctx, fileId) {
  const dir = await tmp();
  try {
    const src = await download(ctx, fileId, dir, "in");
    const out = join(dir, "out.jpg");
    await run("ffmpeg", ["-y", "-i", src, "-vf", "scale='min(1600,iw)':-2", "-qscale:v", "6", out]);
    await ctx.replyWithDocument(new InputFile(await readFile(out), "momobit-compressed.jpg"), {
      caption: `✅ فشرده شد!\n\n${BRAND}`,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function jobVideoToMp3(ctx, fileId) {
  const dir = await tmp();
  try {
    const src = await download(ctx, fileId, dir, "in");
    const out = join(dir, "out.mp3");
    await run("ffmpeg", ["-y", "-i", src, "-vn", "-b:a", "192k", out]);
    await ctx.replyWithAudio(new InputFile(await readFile(out), "momobit.mp3"), {
      caption: `✅ صداش آماده شد!\n\n${BRAND}`,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function jobVideoCompress(ctx, fileId) {
  const dir = await tmp();
  try {
    const src = await download(ctx, fileId, dir, "in");
    const out = join(dir, "out.mp4");
    await run("ffmpeg", [
      "-y", "-i", src,
      "-vf", "scale=-2:'min(720,ih)'",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
      "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out,
    ]);
    await ctx.replyWithVideo(new InputFile(await readFile(out), "momobit.mp4"), {
      caption: `✅ حجمش کم شد!\n\n${BRAND}`,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function jobVideoToGif(ctx, fileId) {
  const dir = await tmp();
  try {
    const src = await download(ctx, fileId, dir, "in");
    const out = join(dir, "out.gif");
    // Only the first 6 seconds: a GIF of a whole clip is enormous and Telegram
    // would reject it. A palette pass keeps the colours from banding.
    await run("ffmpeg", [
      "-y", "-t", "6", "-i", src,
      "-vf", "fps=12,scale=320:-2:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
      "-loop", "0", out,
    ]);
    await ctx.replyWithAnimation(new InputFile(await readFile(out), "momobit.gif"), {
      caption: `✅ GIF آماده شد! (۶ ثانیه‌ی اول)\n\n${BRAND}`,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function jobVideoMute(ctx, fileId) {
  const dir = await tmp();
  try {
    const src = await download(ctx, fileId, dir, "in");
    const out = join(dir, "out.mp4");
    // Copy the video stream untouched — no re-encode, so it is fast and lossless.
    await run("ffmpeg", ["-y", "-i", src, "-an", "-c:v", "copy", out]);
    await ctx.replyWithVideo(new InputFile(await readFile(out), "momobit-muted.mp4"), {
      caption: `✅ صداش حذف شد!\n\n${BRAND}`,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function jobAudioToMp3(ctx, fileId) {
  const dir = await tmp();
  try {
    const src = await download(ctx, fileId, dir, "in");
    const out = join(dir, "out.mp3");
    await run("ffmpeg", ["-y", "-i", src, "-b:a", "192k", out]);
    await ctx.replyWithAudio(new InputFile(await readFile(out), "momobit.mp3"), {
      caption: `✅ تبدیل شد!\n\n${BRAND}`,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function jobAudioToVoice(ctx, fileId) {
  const dir = await tmp();
  try {
    const src = await download(ctx, fileId, dir, "in");
    const out = join(dir, "out.ogg");
    // Telegram voice notes are mono Opus in an Ogg container.
    await run("ffmpeg", ["-y", "-i", src, "-c:a", "libopus", "-b:a", "48k", "-ar", "48000", "-ac", "1", out]);
    await ctx.replyWithVoice(new InputFile(await readFile(out), "momobit.ogg"), {
      caption: `✅ ویس آماده شد!\n\n${BRAND}`,
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------------------
// Keyboards per file kind
// ---------------------------------------------------------------------------
function imageKb(userId) {
  const n = (albums.get(userId) || []).length;
  const kb = new InlineKeyboard()
    .text("🖼 تبدیل به PDF", "do:img2pdf")
    .text("🗜 فشرده کن", "do:imgzip").row()
    .text(n ? `➕ افزودن به آلبوم (${n})` : "➕ افزودن به آلبوم", "album:add");
  if (n) kb.row().text(`📕 ساخت PDF از ${n} عکس`, "album:make").text("🗑 پاک کن", "album:clear");
  return kb;
}

const videoKb = () =>
  new InlineKeyboard()
    .text("🎵 گرفتن صدا", "do:vid2mp3")
    .text("🎬 فشرده کن", "do:vidzip").row()
    .text("🎞 ساخت GIF", "do:vid2gif")
    .text("🔇 حذف صدا", "do:vidmute");

const audioKb = () =>
  new InlineKeyboard()
    .text("🎵 تبدیل به MP3", "do:aud2mp3")
    .text("🎤 تبدیل به ویس", "do:aud2voice");

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
bot.command("start", async (ctx) => {
  if (!(await ensureMember(ctx))) return;
  await ctx.reply(welcomeText(ctx.from.first_name || "دوست من"), { reply_markup: mainMenuKb() });
});

bot.command("help", async (ctx) => {
  if (!(await ensureMember(ctx))) return;
  await ctx.reply(HELP_TEXT, { parse_mode: "Markdown" });
});

bot.command("pdf", async (ctx) => {
  if (!(await ensureMember(ctx))) return;
  const ids = albums.get(ctx.from.id) || [];
  if (!ids.length) return ctx.reply("📭 آلبومت خالیه. اول چندتا عکس بفرست و «افزودن به آلبوم» رو بزن.");
  await runJob(ctx, `ساخت PDF از ${ids.length} عکس`, () => jobAlbumPdf(ctx, ids), () => albums.delete(ctx.from.id));
});

bot.command("clear", async (ctx) => {
  albums.delete(ctx.from.id);
  await ctx.reply("🗑 آلبومت پاک شد.");
});

bot.callbackQuery("help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(HELP_TEXT, { parse_mode: "Markdown" });
});

bot.callbackQuery("recheck", async (ctx) => {
  if (await isMember(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "خوش اومدی! 🎉" });
    try { await ctx.deleteMessage(); } catch {}
    await ctx.reply(welcomeText(ctx.from.first_name || "دوست من"), { reply_markup: mainMenuKb() });
  } else {
    await ctx.answerCallbackQuery({
      text: "هنوز عضو نشدی 🙏 اول عضو کانال شو بعد این دکمه رو بزن.",
      show_alert: true,
    });
  }
});

const tooBig = (n) => typeof n === "number" && n > MAX_BYTES;

async function offer(ctx, fileId, kind) {
  lastFile.set(ctx.from.id, { fileId, kind });
  if (kind === "image") return ctx.reply("با این عکس چیکار کنم؟ 👇", { reply_markup: imageKb(ctx.from.id) });
  if (kind === "video") return ctx.reply("با این ویدیو چیکار کنم؟ 👇", { reply_markup: videoKb() });
  return ctx.reply("با این صدا چیکار کنم؟ 👇", { reply_markup: audioKb() });
}

bot.on(":photo", async (ctx) => {
  if (!(await ensureMember(ctx))) return;
  const p = ctx.message.photo.at(-1);
  if (tooBig(p.file_size)) return ctx.reply("😅 این عکس بزرگ‌تر از ۲۰ مگابایته.");
  await offer(ctx, p.file_id, "image");
});

bot.on(":video", async (ctx) => {
  if (!(await ensureMember(ctx))) return;
  const v = ctx.message.video;
  if (tooBig(v.file_size)) return ctx.reply("😅 این ویدیو بزرگ‌تر از ۲۰ مگابایته.");
  await offer(ctx, v.file_id, "video");
});

bot.on([":audio", ":voice"], async (ctx) => {
  if (!(await ensureMember(ctx))) return;
  const a = ctx.message.audio || ctx.message.voice;
  if (tooBig(a.file_size)) return ctx.reply("😅 این فایل بزرگ‌تر از ۲۰ مگابایته.");
  await offer(ctx, a.file_id, "audio");
});

bot.on(":document", async (ctx) => {
  if (!(await ensureMember(ctx))) return;
  const d = ctx.message.document;
  if (tooBig(d.file_size)) return ctx.reply("😅 این فایل بزرگ‌تر از ۲۰ مگابایته.");
  const mime = d.mime_type || "";
  if (mime.startsWith("image/")) return offer(ctx, d.file_id, "image");
  if (mime.startsWith("video/")) return offer(ctx, d.file_id, "video");
  if (mime.startsWith("audio/")) return offer(ctx, d.file_id, "audio");
  return ctx.reply("🤔 فعلاً فقط عکس، ویدیو و صدا رو بلدم.");
});

// Album buttons
bot.callbackQuery(/^album:(add|make|clear)$/, async (ctx) => {
  if (!(await isMember(ctx.from.id))) {
    return ctx.answerCallbackQuery({ text: "اول عضو کانال شو 🙏", show_alert: true });
  }
  const action = ctx.match[1];
  const uid = ctx.from.id;

  if (action === "clear") {
    albums.delete(uid);
    await ctx.answerCallbackQuery({ text: "آلبوم پاک شد 🗑" });
    try { await ctx.editMessageReplyMarkup({ reply_markup: imageKb(uid) }); } catch {}
    return;
  }

  if (action === "add") {
    const item = lastFile.get(uid);
    if (!item || item.kind !== "image") {
      return ctx.answerCallbackQuery({ text: "عکسش رو پیدا نکردم 😅 دوباره بفرستش.", show_alert: true });
    }
    const list = albums.get(uid) || [];
    list.push(item.fileId);
    albums.set(uid, list);
    await ctx.answerCallbackQuery({ text: `اضافه شد ✅ (${list.length} عکس)` });
    try { await ctx.editMessageReplyMarkup({ reply_markup: imageKb(uid) }); } catch {}
    return;
  }

  const ids = albums.get(uid) || [];
  if (!ids.length) return ctx.answerCallbackQuery({ text: "آلبومت خالیه 📭", show_alert: true });
  await ctx.answerCallbackQuery();
  await runJob(ctx, `ساخت PDF از ${ids.length} عکس`, () => jobAlbumPdf(ctx, ids), () => albums.delete(uid));
});

const JOBS = {
  img2pdf:   { need: "image", label: "دارم PDF می‌سازم",              run: jobImageToPdf },
  imgzip:    { need: "image", label: "دارم فشرده می‌کنم",             run: jobImageCompress },
  vid2mp3:   { need: "video", label: "دارم صداشو درمیارم",            run: jobVideoToMp3 },
  vidzip:    { need: "video", label: "دارم حجمشو کم می‌کنم (کمی صبر کن)", run: jobVideoCompress },
  vid2gif:   { need: "video", label: "دارم GIF می‌سازم",              run: jobVideoToGif },
  vidmute:   { need: "video", label: "دارم صداشو حذف می‌کنم",         run: jobVideoMute },
  aud2mp3:   { need: "audio", label: "دارم به MP3 تبدیل می‌کنم",      run: jobAudioToMp3 },
  aud2voice: { need: "audio", label: "دارم ویس می‌سازم",              run: jobAudioToVoice },
};

async function runJob(ctx, label, fn, onDone) {
  const status = await ctx.reply(`⏳ ${label}…`);
  try {
    await fn();
    if (onDone) onDone();
  } catch (e) {
    console.error("job failed:", e.message);
    await ctx.reply("😔 یه مشکلی پیش اومد. لطفاً دوباره امتحان کن یا فایل کوچیک‌تری بفرست.");
  } finally {
    try { await ctx.api.deleteMessage(status.chat.id, status.message_id); } catch {}
  }
}

bot.callbackQuery(/^do:(.+)$/, async (ctx) => {
  const job = JOBS[ctx.match[1]];
  if (!job) return ctx.answerCallbackQuery();
  if (!(await isMember(ctx.from.id))) {
    return ctx.answerCallbackQuery({ text: "اول عضو کانال شو 🙏", show_alert: true });
  }
  const item = lastFile.get(ctx.from.id);
  if (!item || item.kind !== job.need) {
    return ctx.answerCallbackQuery({ text: "فایلش رو پیدا نکردم 😅 یه بار دیگه بفرستش.", show_alert: true });
  }
  await ctx.answerCallbackQuery();
  await runJob(ctx, job.label, () => job.run(ctx, item.fileId));
});

bot.on("message", async (ctx) => {
  if (!(await ensureMember(ctx))) return;
  await ctx.reply("یه عکس، ویدیو یا صدا برام بفرست تا کارشو انجام بدم 😊", { reply_markup: mainMenuKb() });
});

bot.catch((err) => console.error("bot error:", err.error?.message || err.message));

// ---------------------------------------------------------------------------
// Webhook server
// ---------------------------------------------------------------------------
const SECRET = "momobit-hook";
const handle = webhookCallback(bot, "http", { secretToken: SECRET });

http
  .createServer(async (req, res) => {
    if (req.method === "POST" && req.url === `/${SECRET}`) {
      try {
        return await handle(req, res);
      } catch (e) {
        console.error("webhook error:", e.message);
        res.statusCode = 200; // never trigger a Telegram retry storm
        return res.end("ok");
      }
    }
    res.statusCode = 200;
    res.end("Momobit is running.");
  })
  .listen(PORT, async () => {
    console.log(`listening on ${PORT}`);
    if (!PUBLIC_URL) return console.error("no public URL set — webhook not registered.");
    const hook = `${PUBLIC_URL.replace(/\/$/, "")}/${SECRET}`;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await bot.api.setWebhook(hook, { secret_token: SECRET, drop_pending_updates: true });
        const me = await bot.api.getMe();
        console.log(`webhook set for @${me.username} → ${hook}`);
        return;
      } catch (e) {
        // Telegram rate-limits setWebhook; back off and retry rather than
        // leaving the bot deployed but deaf.
        const wait = (e.parameters?.retry_after || attempt * 2) * 1000;
        console.error(`setWebhook attempt ${attempt} failed: ${e.description || e.message} — retrying in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    console.error("setWebhook gave up after 5 attempts.");
  });
