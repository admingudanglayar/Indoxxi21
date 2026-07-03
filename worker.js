/**
 * ============================================================================
 *  POWERFUL MIRROR WORKER — Cloudflare Workers
 *  Full-site reverse proxy + SEO fixer + Ad blocker + Glassmorphism theme
 * ----------------------------------------------------------------------------
 *  Fitur:
 *   1. Full mirror (HTML, AJAX player, CSS, JS, gambar, sitemap, robots).
 *   2. Anti-duplikat SEO:
 *        - Rewrite semua URL origin -> domain mirror (canonical, og:url, dll).
 *        - Perbaiki canonical agar selalu self-referencing (per-URL).
 *        - Perbaiki JSON-LD (breadcrumb position => integer, hapus domain asing).
 *        - Perbaiki og:locale -> id_ID.
 *   3. Sitemap & robots.txt otomatis di-rewrite ke domain mirror.
 *   4. Blokir iklan judi/slot & popup redirect, TANPA merusak video player.
 *   5. Inject tema Glassmorphism modern.
 * ----------------------------------------------------------------------------
 *  Cara pakai:
 *   - Deploy sebagai Cloudflare Worker pada route domain mirror Anda.
 *   - Ubah CONFIG di bawah bila domain berubah.
 * ============================================================================
 */

const CONFIG = {
  // Domain asli yang di-mirror (SUMBER).
  ORIGIN: "comblank.com",

  // Domain mirror Anda (TUJUAN). Diisi otomatis dari request bila kosong,
  // tapi disarankan hardcode untuk hasil SEO paling konsisten.
  MIRROR: "indoxxi21.net",

  // Nama & branding situs (dipakai untuk memaksa konsistensi schema).
  SITE_NAME: "INDOXXI - IDLIX",

  // Bahasa situs (perbaikan og:locale & <html lang>).
  LOCALE: "id_ID",
  HTML_LANG: "id-ID",

  // Domain lain milik jaringan origin yang harus ikut di-rewrite ke MIRROR
  // (mis. logo/aset yang masih menunjuk domain lama).
  ALSO_REWRITE: [
    "sarangfilm21.makeup",
  ],

  // Host video player / streaming yang WAJIB dibiarkan (jangan diblokir).
  ALLOW_HOSTS: [
    "abyssplayer.com",
    "hgcloud.to",
    "p2pstream.online",
    "fastdl.p2pstream.online",
    "youtube.com",
    "www.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
    "ytimg.com",
    "i.ytimg.com",
  ],

  // Domain iklan / tracker / redirect yang diblokir total.
  BLOCK_HOSTS: [
    "klik.gg",
    "klik.top",
    "morencius.com",
    "aksesin.top",
    "googletagmanager.com",
    "www.googletagmanager.com",
    "google-analytics.com",
    "www.google-analytics.com",
    "pagead2.googlesyndication.com",
    "googlesyndication.com",
    "doubleclick.net",
    "propellerads.com",
    "popads.net",
    "popcash.net",
    "adsterra.com",
    "hilltopads.net",
    "onclickalgo.com",
    "highperformanceformat.com",
    "profitableratecpm.com",
  ],

  // Toggle fitur.
  ENABLE_THEME: true,       // inject glassmorphism CSS
  ENABLE_ADBLOCK: true,     // hapus iklan
  ENABLE_SEO_FIX: true,     // perbaikan SEO & schema
  DEBUG: false,             // tambahkan header X-Mirror-* untuk debug
};

// ============================================================================
//  ENTRY POINT
// ============================================================================
export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request);
    } catch (err) {
      return new Response("Mirror error: " + (err && err.message), {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
  },
};

async function handle(request) {
  const inUrl = new URL(request.url);
  const mirrorHost = CONFIG.MIRROR || inUrl.hostname;

  // --- Endpoint sintetis: robots.txt selalu kita layani sendiri ---
  if (inUrl.pathname === "/robots.txt") {
    return buildRobots(mirrorHost, inUrl);
  }

  // --- Bangun request ke origin ---
  const originUrl = new URL(inUrl.toString());
  originUrl.hostname = CONFIG.ORIGIN;
  originUrl.protocol = "https:";
  originUrl.port = "";

  const reqHeaders = new Headers(request.headers);
  reqHeaders.set("Host", CONFIG.ORIGIN);
  reqHeaders.set("Referer", "https://" + CONFIG.ORIGIN + inUrl.pathname + inUrl.search);
  reqHeaders.set("Origin", "https://" + CONFIG.ORIGIN);
  // Hindari kompresi aneh; biarkan CF menangani.
  reqHeaders.delete("accept-encoding");
  // Buang header yang membocorkan host mirror.
  reqHeaders.delete("cf-connecting-ip");
  reqHeaders.delete("x-forwarded-host");

  const originRequest = new Request(originUrl.toString(), {
    method: request.method,
    headers: reqHeaders,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  });

  let originResponse = await fetch(originRequest);

  // --- Tangani redirect origin agar tetap di dalam mirror (hindari 404/redirect chain) ---
  if (originResponse.status >= 300 && originResponse.status < 400) {
    const loc = originResponse.headers.get("location");
    if (loc) {
      const fixed = rewriteUrlString(loc, mirrorHost);
      const h = new Headers(originResponse.headers);
      h.set("location", fixed);
      stripHopHeaders(h);
      return new Response(null, { status: originResponse.status, headers: h });
    }
  }

  const ct = (originResponse.headers.get("content-type") || "").toLowerCase();
  const outHeaders = new Headers(originResponse.headers);
  stripHopHeaders(outHeaders);
  rewriteCookies(outHeaders, mirrorHost);

  if (CONFIG.DEBUG) {
    outHeaders.set("X-Mirror-Origin", CONFIG.ORIGIN);
    outHeaders.set("X-Mirror-Host", mirrorHost);
    outHeaders.set("X-Mirror-CT", ct);
  }

  // --- HTML: transform penuh ---
  if (ct.includes("text/html")) {
    let html = await originResponse.text();
    html = transformHtml(html, mirrorHost, inUrl);
    outHeaders.delete("content-length");
    outHeaders.set("content-type", "text/html; charset=utf-8");
    return new Response(html, { status: originResponse.status, headers: outHeaders });
  }

  // --- XML (sitemap): rewrite domain ---
  if (ct.includes("xml") || inUrl.pathname.endsWith(".xml")) {
    let xml = await originResponse.text();
    xml = rewriteAllOriginRefs(xml, mirrorHost);
    // Perbaiki referensi stylesheet sitemap agar tidak 404.
    xml = xml.replace(/href="\/\/[^"]*?\/([^"\/]+\.xsl)"/gi, 'href="/$1"');
    outHeaders.delete("content-length");
    return new Response(xml, { status: originResponse.status, headers: outHeaders });
  }

  // --- CSS / JS / JSON teks: rewrite domain (agar aset & AJAX tetap ke mirror) ---
  if (
    ct.includes("text/css") ||
    ct.includes("javascript") ||
    ct.includes("application/json") ||
    ct.includes("text/plain")
  ) {
    let body = await originResponse.text();
    body = rewriteAllOriginRefs(body, mirrorHost);
    outHeaders.delete("content-length");
    return new Response(body, { status: originResponse.status, headers: outHeaders });
  }

  // --- Biner (gambar, font, video): stream apa adanya ---
  return new Response(originResponse.body, {
    status: originResponse.status,
    headers: outHeaders,
  });
}

// ============================================================================
//  HTML TRANSFORM PIPELINE
// ============================================================================
function transformHtml(html, mirrorHost, inUrl) {
  // 1) Rewrite semua referensi domain origin -> mirror.
  html = rewriteAllOriginRefs(html, mirrorHost);

  // 2) Perbaikan SEO & structured data.
  if (CONFIG.ENABLE_SEO_FIX) {
    html = fixSeo(html, mirrorHost, inUrl);
  }

  // 3) Blokir iklan (tanpa merusak player).
  if (CONFIG.ENABLE_ADBLOCK) {
    html = blockAds(html);
  }

  // 4) Inject tema glassmorphism + guard anti-popup.
  if (CONFIG.ENABLE_THEME) {
    html = injectTheme(html);
  }

  return html;
}

// ============================================================================
//  URL REWRITING
// ============================================================================
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrite semua kemunculan origin (dan ALSO_REWRITE) menjadi mirror,
 * baik dengan/ tanpa protokol, escaped (\/), maupun protocol-relative.
 */
function rewriteAllOriginRefs(text, mirrorHost) {
  const targets = [CONFIG.ORIGIN, ...CONFIG.ALSO_REWRITE];
  for (const host of targets) {
    const h = escapeRegex(host);
    // https://host  dan  http://host  -> https://mirror
    text = text.replace(new RegExp("https?:\\/\\/" + h, "gi"), "https://" + mirrorHost);
    // //host (protocol-relative)
    text = text.replace(new RegExp("\\/\\/" + h, "gi"), "//" + mirrorHost);
    // escaped JSON: https:\/\/host
    text = text.replace(new RegExp("https?:\\\\\\/\\\\\\/" + h, "gi"), "https:\\/\\/" + mirrorHost);
    // URL-encoded (share links WhatsApp/Telegram): https%3A%2F%2Fhost%2F
    text = text.replace(new RegExp("https%3A%2F%2F" + h, "gi"), "https%3A%2F%2F" + mirrorHost);
    text = text.replace(new RegExp("%2F%2F" + h, "gi"), "%2F%2F" + mirrorHost);
    // bare host (hati-hati: hanya jika dikelilingi quote/tanda batas)
    text = text.replace(new RegExp("([\"'(=\\s>])" + h + "([\"'/)\\s<])", "gi"), "$1" + mirrorHost + "$2");
  }
  return text;
}

function rewriteUrlString(u, mirrorHost) {
  try {
    const abs = new URL(u, "https://" + CONFIG.ORIGIN);
    const all = [CONFIG.ORIGIN, ...CONFIG.ALSO_REWRITE];
    if (all.includes(abs.hostname)) {
      abs.hostname = mirrorHost;
      abs.protocol = "https:";
      abs.port = "";
    }
    return abs.toString();
  } catch {
    return rewriteAllOriginRefs(u, mirrorHost);
  }
}

// ============================================================================
//  SEO & STRUCTURED DATA FIX
// ============================================================================
function fixSeo(html, mirrorHost, inUrl) {
  const selfUrl = "https://" + mirrorHost + inUrl.pathname + (inUrl.search || "");
  const selfUrlClean = "https://" + mirrorHost + inUrl.pathname;

  // 1) Paksa canonical self-referencing (hindari "Google memilih kanonis berbeda").
  if (/<link[^>]+rel=["']canonical["'][^>]*>/i.test(html)) {
    html = html.replace(
      /<link[^>]+rel=["']canonical["'][^>]*>/gi,
      `<link rel="canonical" href="${selfUrlClean}" />`
    );
  } else {
    html = html.replace(/<\/head>/i, `<link rel="canonical" href="${selfUrlClean}" />\n</head>`);
  }

  // 2) og:url self-referencing.
  html = html.replace(
    /(<meta[^>]+property=["']og:url["'][^>]+content=["'])[^"']*(["'])/gi,
    `$1${selfUrlClean}$2`
  );

  // 3) og:locale -> id_ID.
  html = html.replace(
    /(<meta[^>]+property=["']og:locale["'][^>]+content=["'])[^"']*(["'])/gi,
    `$1${CONFIG.LOCALE}$2`
  );

  // 4) <html lang="..."> -> id-ID.
  html = html.replace(/<html([^>]*?)\slang=["'][^"']*["']/i, `<html$1 lang="${CONFIG.HTML_LANG}"`);
  if (!/<html[^>]*\slang=/i.test(html)) {
    html = html.replace(/<html/i, `<html lang="${CONFIG.HTML_LANG}"`);
  }

  // 5) robots -> pastikan index,follow (kadang origin set noindex).
  html = html.replace(
    /(<meta[^>]+name=["']robots["'][^>]+content=["'])[^"']*(["'])/gi,
    `$1index, follow, max-image-preview:large$2`
  );

  // 6) Perbaiki JSON-LD structured data (breadcrumb position integer, dll).
  html = html.replace(
    /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    (m, jsonText) => {
      const fixed = fixJsonLd(jsonText, mirrorHost, selfUrlClean);
      return `<script type="application/ld+json">${fixed}</script>`;
    }
  );

  return html;
}

/**
 * Perbaiki blok JSON-LD:
 *  - position "1" (string) -> 1 (integer)  [error breadcrumb Google]
 *  - width/height string -> number
 *  - buang domain asing pada url/@id/image
 *  - samakan @id/url ke mirror
 */
function fixJsonLd(jsonText, mirrorHost, selfUrlClean) {
  let raw = jsonText.trim();
  // Rewrite domain di dalam JSON (termasuk escaped).
  raw = rewriteAllOriginRefs(raw, mirrorHost);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Bila gagal parse, minimal perbaiki position via regex sebagai fallback.
    return raw.replace(/"position"\s*:\s*"(\d+)"/g, '"position":$1');
  }

  const numericKeys = new Set(["position", "width", "height", "ratingValue", "reviewCount", "ratingCount", "worstRating", "bestRating"]);

  const walk = (node) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (numericKeys.has(k) && typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) {
          node[k] = Number(v);
        } else {
          walk(v);
        }
      }
    }
  };
  walk(data);

  // Paksa nama situs konsisten bila ada Person/Organization/WebSite tingkat atas.
  const forceName = (node) => {
    if (Array.isArray(node)) node.forEach(forceName);
    else if (node && typeof node === "object") {
      const t = node["@type"];
      const types = Array.isArray(t) ? t : [t];
      if (types.some((x) => ["Organization", "WebSite", "Person"].includes(x)) && node.name) {
        node.name = CONFIG.SITE_NAME;
      }
      Object.values(node).forEach(forceName);
    }
  };
  forceName(data);

  return JSON.stringify(data);
}

// ============================================================================
//  AD BLOCKING (tetap aman untuk video player)
// ============================================================================
function blockAds(html) {
  // 1) Hapus banner iklan <div class="banner-content">...</div> (termasuk close button).
  html = html.replace(/<div\s+class=["']banner-content["'][\s\S]*?<\/div>/gi, "");

  // 2) Hapus <a> yang menuju domain iklan yang diblokir (dengan gambar/isi di dalamnya).
  const blockAlt = CONFIG.BLOCK_HOSTS.map(escapeRegex).join("|");
  const anchorRe = new RegExp(
    `<a\\b[^>]*href=["'][^"']*(?:${blockAlt})[^"']*["'][^>]*>[\\s\\S]*?<\\/a>`,
    "gi"
  );
  html = html.replace(anchorRe, "");

  // 3) & 4) Proses SETIAP blok <script> secara individual agar penghapusan
  //    tidak pernah "melintasi" batas antar-script (mencegah player ikut terhapus).
  const adInlineRe = /googletagmanager|gtag\s*\(|dataLayer|G-KK0VCJ7SRN|adsbygoogle|\(adsbygoogle/i;
  const blockHostRe = new RegExp(`(?:${blockAlt})`, "i");
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (full, attrs, body) => {
    // Script eksternal ke domain iklan -> hapus.
    const srcMatch = attrs.match(/src=["']([^"']+)["']/i);
    if (srcMatch && blockHostRe.test(srcMatch[1])) return "";
    // Script inline iklan/tracker -> hapus. Player/muvipro/idmuvi selalu dipertahankan.
    const isPlayer = /muvipro|idmuvi|mvpp|ajax_url|_wpnonce|player/i.test(body);
    if (!isPlayer && adInlineRe.test(body)) return "";
    return full;
  });

  // 5) Hapus <iframe> iklan yang mengarah ke domain diblokir (BUKAN player).
  const iframeRe = new RegExp(
    `<iframe\\b[^>]*src=["'][^"']*(?:${blockAlt})[^"']*["'][^>]*>[\\s\\S]*?<\\/iframe>`,
    "gi"
  );
  html = html.replace(iframeRe, "");
  // versi self-closing
  const iframeRe2 = new RegExp(
    `<iframe\\b[^>]*src=["'][^"']*(?:${blockAlt})[^"']*["'][^>]*\\/?>`,
    "gi"
  );
  html = html.replace(iframeRe2, "");

  // 6) Hapus <link rel=preconnect/dns-prefetch> ke domain iklan.
  const linkRe = new RegExp(
    `<link\\b[^>]*href=["'][^"']*(?:${blockAlt})[^"']*["'][^>]*>`,
    "gi"
  );
  html = html.replace(linkRe, "");

  return html;
}

// ============================================================================
//  GLASSMORPHISM THEME + ANTI-POPUP GUARD
// ============================================================================
function injectTheme(html) {
  const css = `
<style id="mirror-glass-theme">
:root{
  --glass-bg: rgba(255,255,255,0.08);
  --glass-brd: rgba(255,255,255,0.18);
  --glass-blur: 14px;
  --accent: #7c5cff;
  --accent2: #22d3ee;
  --ink: #eef1ff;
}
html,body{background:#0b0f1a !important;color:var(--ink) !important;}
body{
  background:
    radial-gradient(1200px 800px at 10% -10%, rgba(124,92,255,.25), transparent 60%),
    radial-gradient(1000px 700px at 110% 10%, rgba(34,211,238,.18), transparent 55%),
    #0b0f1a !important;
}
a{color:var(--accent2);}
a:hover{color:#fff;}
header, .main-header, #header, .site-header,
.gmr-main-menu, #main-menu, nav, footer, #footer, .site-footer,
.item, article, .content, #content, .widget, .gmr-box-content,
.result-item, .gmr-item-modulepost, .homepostbox, .filterbox,
.pagination, .search-form, form.search-form, .single .entry-content,
.mvp-post-add-box, .video-player, .player-area, .gmr-embed-responsive{
  background: var(--glass-bg) !important;
  border: 1px solid var(--glass-brd) !important;
  -webkit-backdrop-filter: blur(var(--glass-blur));
  backdrop-filter: blur(var(--glass-blur));
  border-radius: 16px !important;
  box-shadow: 0 8px 32px rgba(0,0,0,.35) !important;
}
.gmr-embed-responsive, .video-player, iframe{
  border-radius: 14px !important;
}
.item:hover, article:hover, .result-item:hover{
  transform: translateY(-3px);
  transition: transform .25s ease, box-shadow .25s ease;
  box-shadow: 0 12px 40px rgba(124,92,255,.35) !important;
}
img{border-radius: 12px;}
input, select, textarea, button{
  background: rgba(255,255,255,.06) !important;
  color: var(--ink) !important;
  border: 1px solid var(--glass-brd) !important;
  border-radius: 10px !important;
}
button, .button, .btn{
  background: linear-gradient(135deg, var(--accent), var(--accent2)) !important;
  border: none !important; color:#0b0f1a !important; font-weight:600;
}
::-webkit-scrollbar{width:10px;height:10px;}
::-webkit-scrollbar-thumb{background:linear-gradient(var(--accent),var(--accent2));border-radius:20px;}
::-webkit-scrollbar-track{background:#0b0f1a;}
h1,h2,h3,.entry-title,.title{color:#fff !important;}
/* Sisakan area player benar-benar bersih & fokus */
#muvipro_player_content_id, .player-wrap, .gmr-server-wrap{background:transparent !important;}
</style>`;

  // Guard anti-popup: netralkan window.open dari iklan, tapi biarkan navigasi normal.
  const guard = `
<script id="mirror-popup-guard">
(function(){
  try{
    var _open = window.open;
    window.open = function(u){
      try{
        var s = String(u||"");
        var bad = ${JSON.stringify(CONFIG.BLOCK_HOSTS)};
        if(bad.some(function(d){return s.indexOf(d)>-1;})) return null;
      }catch(e){}
      return _open.apply(window, arguments);
    };
    // Blok anchor iklan yang lolos (defensif).
    document.addEventListener('click', function(ev){
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if(!a) return;
      var bad = ${JSON.stringify(CONFIG.BLOCK_HOSTS)};
      if(bad.some(function(d){return a.href.indexOf(d)>-1;})){
        ev.preventDefault(); ev.stopPropagation();
      }
    }, true);
  }catch(e){}
})();
</script>`;

  html = html.replace(/<\/head>/i, css + "\n</head>");
  html = html.replace(/<\/body>/i, guard + "\n</body>");
  return html;
}

// ============================================================================
//  ROBOTS.TXT (self-hosted, arahkan ke sitemap mirror)
// ============================================================================
function buildRobots(mirrorHost, inUrl) {
  const body =
`User-agent: *
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php

Sitemap: https://${mirrorHost}/sitemap_index.xml
`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

// ============================================================================
//  HEADER / COOKIE HELPERS
// ============================================================================
function stripHopHeaders(h) {
  [
    "content-encoding",
    "content-security-policy",
    "content-security-policy-report-only",
    "x-frame-options",
    "strict-transport-security",
    "public-key-pins",
    "report-to",
    "nel",
    "server",
    "x-powered-by",
    "x-litespeed-cache",
    "alt-svc",
  ].forEach((k) => h.delete(k));
}

function rewriteCookies(h, mirrorHost) {
  const cookies = h.getSetCookie ? h.getSetCookie() : [];
  if (cookies && cookies.length) {
    h.delete("set-cookie");
    for (const c of cookies) {
      const fixed = c
        .replace(new RegExp("Domain=\\.?" + escapeRegex(CONFIG.ORIGIN), "gi"), "Domain=" + mirrorHost)
        .replace(/;\s*Secure/gi, "; Secure")
        .replace(/;\s*SameSite=None/gi, "; SameSite=Lax");
      h.append("set-cookie", fixed);
    }
  }
}
