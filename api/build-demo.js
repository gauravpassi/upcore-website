// ═══════════════════════════════════════════════════════════════════════
// Upcore · Agent Demo Builder API
// POST /api/build-demo
//
// 1. Generates demo data + page content via Anthropic Claude API
// 2. Assembles a standalone HTML demo page
// 3. Commits it to GitHub → Vercel auto-deploys
// 4. Returns the live URL
// ═══════════════════════════════════════════════════════════════════════

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_PAT        = process.env.GITHUB_PAT;
const GITHUB_REPO       = process.env.GITHUB_REPO || 'gauravpassi/upcore-website';
const SITE_BASE_URL     = process.env.SITE_BASE_URL || 'https://upcore.ai';

// ─── Rate limit store (in-memory, resets on cold start — good enough for MVP) ───
const rateLimitStore = {};
const RATE_LIMIT_WINDOW_MS = 30 * 60 * 1000; // 30 min
const RATE_LIMIT_MAX       = 3;               // max 3 demos per IP per window
let dailyCount = 0;
let dailyDate  = '';
const DAILY_MAX = 100;

// ─── INDUSTRY CONFIG ────────────────────────────────────────────────────────────
const INDUSTRY_CONFIG = {
  manufacturing: {
    label: 'Manufacturing',
    emoji: '🏭',
    entityName: 'Quality Alert',
    entityNamePlural: 'Quality Alerts',
    defaultAgentName: 'QualityBot',
    integrations: ['SAP', 'MES System', 'Slack', 'Email', 'SCADA', 'ERP'],
    metricsTemplate: [
      { label: 'Alerts Auto-Resolved', valueSuffix: '%' },
      { label: 'Avg Resolution Time', valueSuffix: 'min' },
      { label: 'Records Processed',   valueSuffix: '' },
      { label: 'Escalation Rate',     valueSuffix: '%' },
    ],
    statusOptions: ['Auto-Resolved ✓', 'Escalated to Supervisor', 'Pending QC Review', 'Production Hold', 'Rework Required'],
    systemPromptContext: 'manufacturing quality control, production alerts, defect tracking, supplier issues, work orders'
  },
  ecommerce: {
    label: 'eCommerce',
    emoji: '🛒',
    entityName: 'Order',
    entityNamePlural: 'Orders',
    defaultAgentName: 'OrderBot',
    integrations: ['Shopify', 'Zendesk', 'WhatsApp', 'Email', 'Slack', 'Shiprocket'],
    metricsTemplate: [
      { label: 'Auto-Resolved',      valueSuffix: '%' },
      { label: 'Avg Handle Time',    valueSuffix: 'min' },
      { label: 'Tickets Processed',  valueSuffix: '' },
      { label: 'CSAT Score',         valueSuffix: '/5' },
    ],
    statusOptions: ['Resolved — Auto ✓', 'Escalated to Agent', 'Awaiting Customer', 'Replacement Shipped', 'Refund Initiated'],
    systemPromptContext: 'ecommerce order management, returns, WISMO (where is my order), customer support tickets, refunds, delivery issues'
  }
};

// ─── HELPERS ───────────────────────────────────────────────────────────────────

function generateSlug(industry, agentName) {
  const base = (industry + '-' + agentName.toLowerCase().replace(/[^a-z0-9]/g, '-')).slice(0, 40);
  const rand = Math.random().toString(36).slice(2, 8);
  return base + '-' + rand;
}

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

function checkRateLimit(ip) {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // Reset daily counter
  if (dailyDate !== today) { dailyDate = today; dailyCount = 0; }
  if (dailyCount >= DAILY_MAX) return { allowed: false, reason: 'Daily demo limit reached. Try again tomorrow.' };

  // Per-IP window
  if (!rateLimitStore[ip]) rateLimitStore[ip] = [];
  rateLimitStore[ip] = rateLimitStore[ip].filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (rateLimitStore[ip].length >= RATE_LIMIT_MAX) {
    return { allowed: false, reason: 'Too many demos created from your IP. Please wait 30 minutes.' };
  }
  rateLimitStore[ip].push(now);
  dailyCount++;
  return { allowed: true };
}

// ─── ANTHROPIC API CALL ────────────────────────────────────────────────────────

async function callAnthropic(systemPrompt, userPrompt, maxTokens = 3000) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('Anthropic API error ' + res.status + ': ' + err);
  }
  const data = await res.json();
  return data.content[0].text;
}

// ─── STEP 1: GENERATE DEMO DATA ───────────────────────────────────────────────

async function generateDemoData(industry, painPoint, actions, agentName, companyName) {
  const cfg = INDUSTRY_CONFIG[industry];
  const system = `You are a demo data generator for Upcore Technologies.
You generate realistic but entirely FICTIONAL data for AI agent demos in ${cfg.systemPromptContext}.
All names, IDs, and values must be plausible but completely made up — no real companies, people, or data.
Always respond with valid JSON only. No explanation text. No markdown fences.`;

  const user = `Generate a JSON object for a ${cfg.label} agent demo with this context:
- Pain point: "${painPoint}"
- Agent actions: ${actions.join(', ')}
- Agent name: ${agentName}
- Company name: ${companyName || 'Demo Company'}

Return exactly this structure:
{
  "agentName": "${agentName}",
  "companyName": "${companyName || cfg.label + ' Demo'}",
  "industry": "${cfg.label}",
  "summary": "2-sentence description of what this agent does for this specific use case",
  "metrics": [
    { "value": "94", "suffix": "%", "label": "Auto-Resolved" },
    { "value": "8", "suffix": "min", "label": "Avg Resolution Time" },
    { "value": "20", "suffix": "", "label": "Records Processed" },
    { "value": "4.1", "suffix": "/5", "label": "${industry === 'ecommerce' ? 'CSAT Score' : 'Quality Score'}" }
  ],
  "records": [
    /* 20 records, each with these fields: */
    {
      "id": "unique alphanumeric ID matching industry (e.g. QA-2024-001 for manufacturing, ORD-78234 for ecommerce)",
      "subject": "short 4-8 word description specific to the use case",
      "entity": "fictional company/customer name",
      "value": "a relevant number with unit (e.g. ₹18,400 or 3 units or ₹2,399)",
      "priority": "High | Medium | Low",
      "status": "one of: ${cfg.statusOptions.join(' | ')}",
      "agentAction": "one short sentence describing what the agent did (past tense)"
    }
  ],
  "chatSample": [
    { "role": "user", "text": "a realistic question this person would ask" },
    { "role": "agent", "text": "a specific, intelligent 2-3 sentence response referencing actual records" },
    { "role": "user", "text": "a follow-up question" },
    { "role": "agent", "text": "a helpful specific follow-up response" }
  ],
  "activityLog": [
    /* 8 recent agent actions, each: */
    { "time": "Xm ago", "action": "short specific action the agent took", "icon": "relevant emoji" }
  ]
}

Make ALL content highly specific to: "${painPoint}". Use realistic Indian business context where appropriate (₹ for currency, Indian company names are fine).`;

  const raw = await callAnthropic(system, user, 4000);

  // Extract JSON (handle any stray text)
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Invalid JSON from Anthropic: ' + raw.slice(0, 200));
  return JSON.parse(jsonMatch[0]);
}

// ─── STEP 2: ASSEMBLE HTML ────────────────────────────────────────────────────

function assembleDemoHTML(data, industry, slug, expiryDate) {
  const cfg = INDUSTRY_CONFIG[industry];
  const { agentName, companyName, summary, metrics, records, chatSample, activityLog } = data;

  // Priority colour mapping
  const priColor = { High: '#f87171', Medium: '#fbbf24', Low: '#4ade80' };

  // Status colour mapping
  const statusColor = (s) => {
    if (s.includes('✓') || s.includes('Resolved')) return '#4ade80';
    if (s.includes('Escalated') || s.includes('Hold')) return '#f87171';
    return '#fbbf24';
  };

  // Render records table rows
  const recordRows = records.slice(0, 20).map(r => `
    <tr>
      <td style="font-size:12px;color:var(--teal);font-family:monospace;padding:10px 12px;border-bottom:1px solid rgba(10,191,204,.05);white-space:nowrap;">${esc(r.id)}</td>
      <td style="font-size:13px;font-weight:600;color:var(--txt);padding:10px 12px;border-bottom:1px solid rgba(10,191,204,.05);">${esc(r.subject)}</td>
      <td style="font-size:12px;color:var(--txt2);padding:10px 12px;border-bottom:1px solid rgba(10,191,204,.05);">${esc(r.entity)}</td>
      <td style="font-size:12px;color:var(--txt2);padding:10px 12px;border-bottom:1px solid rgba(10,191,204,.05);white-space:nowrap;">${esc(r.value)}</td>
      <td style="font-size:11px;font-weight:700;padding:10px 12px;border-bottom:1px solid rgba(10,191,204,.05);">
        <span style="color:${priColor[r.priority]||'#fbbf24'};background:${priColor[r.priority]||'#fbbf24'}15;border:1px solid ${priColor[r.priority]||'#fbbf24'}30;border-radius:100px;padding:2px 9px;">${esc(r.priority)}</span>
      </td>
      <td style="font-size:11px;font-weight:700;padding:10px 12px;border-bottom:1px solid rgba(10,191,204,.05);">
        <span style="color:${statusColor(r.status)};background:${statusColor(r.status)}15;border:1px solid ${statusColor(r.status)}30;border-radius:100px;padding:2px 9px;white-space:nowrap;">${esc(r.status)}</span>
      </td>
      <td style="font-size:12px;color:var(--txt3);padding:10px 12px;border-bottom:1px solid rgba(10,191,204,.05);">${esc(r.agentAction)}</td>
    </tr>`).join('');

  // Render chat
  const chatHtml = chatSample.map(m => {
    const isUser = m.role === 'user';
    return `<div style="display:flex;flex-direction:column;align-items:${isUser?'flex-end':'flex-start'};gap:4px;margin-bottom:12px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${isUser?'var(--txt3)':'var(--teal)'};">${isUser?'You':agentName}</div>
      <div style="font-size:13px;line-height:1.55;padding:10px 14px;border-radius:${isUser?'14px 14px 4px 14px':'14px 14px 14px 4px'};max-width:85%;${isUser?'background:var(--grad);color:#07101e;font-weight:500;':'background:var(--bg3);color:var(--txt2);border:1px solid var(--border);'}">${esc(m.text)}</div>
    </div>`;
  }).join('');

  // Render activity log
  const activityHtml = activityLog.slice(0, 8).map(a =>
    `<div style="display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-bottom:1px solid rgba(10,191,204,.05);">
      <div style="font-size:16px;flex-shrink:0;margin-top:1px;">${esc(a.icon)}</div>
      <div style="flex:1;font-size:12px;color:var(--txt2);line-height:1.5;">${esc(a.action)}</div>
      <div style="font-size:11px;color:var(--txt3);flex-shrink:0;">${esc(a.time)}</div>
    </div>`
  ).join('');

  // Render metrics
  const metricsHtml = metrics.slice(0, 4).map(m =>
    `<div style="background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:16px;text-align:center;flex:1;min-width:100px;">
      <div style="font-size:26px;font-weight:900;background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:-1px;">${esc(m.value)}${esc(m.suffix||'')}</div>
      <div style="font-size:11px;color:var(--txt3);margin-top:4px;font-weight:500;">${esc(m.label)}</div>
    </div>`
  ).join('');

  // Integrations
  const integrationsHtml = cfg.integrations.map(i =>
    `<div style="display:inline-flex;align-items:center;gap:7px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:8px 14px;font-size:13px;font-weight:600;color:var(--txt2);">
      <div style="width:7px;height:7px;border-radius:50%;background:var(--teal);flex-shrink:0;"></div>${esc(i)}
    </div>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>${esc(agentName)} — ${esc(companyName)} Agent Demo · Upcore</title>
<meta name="description" content="Live AI agent demo for ${esc(companyName)} built by Upcore Technologies. Uses simulated demo data."/>
<meta name="robots" content="noindex,nofollow"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<style>
:root{
  --bg:#07101e;--bg2:#0a1628;--bg3:#0d1c34;--card:#0f2040;
  --teal:#0abfcc;--mint:#3dddc4;--teal3:#0891b2;
  --txt:#ffffff;--txt2:#8bbed4;--txt3:#3a6080;
  --border:rgba(10,191,204,.13);--bh:rgba(10,191,204,.38);
  --glow:rgba(10,191,204,.08);--red:#f87171;--green:#4ade80;--amber:#fbbf24;
  --grad:linear-gradient(135deg,#0891b2,#0abfcc,#3dddc4);
  --ff:'Poppins',sans-serif;
}
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box;}
body{font-family:var(--ff);background:var(--bg);color:var(--txt);line-height:1.6;overflow-x:hidden;}
a{text-decoration:none;color:inherit;}
.grad-text{background:var(--grad);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
/* Sticky CTA */
.sticky-cta{position:fixed;bottom:24px;right:24px;z-index:999;background:var(--grad);color:#07101e;font-family:var(--ff);font-size:13px;font-weight:800;padding:14px 24px;border-radius:100px;box-shadow:0 8px 32px rgba(10,191,204,.35);display:flex;align-items:center;gap:8px;transition:transform .2s;}
.sticky-cta:hover{transform:translateY(-2px);}
/* Scrollable table */
.table-scroll{overflow-x:auto;}
table{width:100%;border-collapse:collapse;min-width:800px;}
@keyframes pulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(74,222,128,.4);}50%{opacity:.7;box-shadow:0 0 0 6px rgba(74,222,128,0);}}
@media(max-width:768px){
  .page-inner{padding:20px 16px!important;}
  .demo-grid{grid-template-columns:1fr!important;}
  .metrics-row{flex-wrap:wrap!important;}
  .sticky-cta{bottom:16px;right:16px;font-size:12px;padding:12px 18px;}
}
</style>
</head>
<body>

<!-- NAV -->
<nav style="width:100%;background:rgba(7,16,30,.96);backdrop-filter:blur(20px);border-bottom:1px solid var(--border);padding:0 48px;height:72px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:99;">
  <a href="/" style="display:flex;align-items:center;"><img src="/upcore-logo.png" alt="Upcore" style="height:52px;width:auto;display:block;"/></a>
  <div style="display:flex;align-items:center;gap:16px;">
    <a href="/build-your-demo" style="font-size:14px;color:var(--txt2);font-weight:500;">Build Another Demo</a>
    <a href="/assessment" style="background:var(--grad);color:#07101e;font-family:var(--ff);font-size:14px;font-weight:700;padding:10px 22px;border-radius:10px;">Book a Discovery Call</a>
  </div>
</nav>

<!-- DEMO BANNER -->
<div style="background:rgba(251,191,36,.07);border-bottom:1px solid rgba(251,191,36,.18);padding:9px 48px;display:flex;align-items:center;justify-content:center;gap:10px;font-size:12px;font-weight:600;color:#e5c87a;">
  <span>⚠</span> <strong>Demo Data Only</strong> — This demo uses 20 simulated records. Not connected to any real system. · Expires ${expiryDate}
</div>

<!-- PAGE CONTENT -->
<div class="page-inner" style="max-width:1280px;margin:0 auto;padding:40px 32px 80px;">

  <!-- HEADER -->
  <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:20px;margin-bottom:36px;">
    <div>
      <div style="display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:var(--teal);background:rgba(10,191,204,.1);border:1px solid var(--border);border-radius:100px;padding:6px 16px;margin-bottom:14px;">
        <span style="width:8px;height:8px;border-radius:50%;background:var(--green);animation:pulse 1.8s ease-in-out infinite;"></span>
        ${cfg.emoji} ${esc(cfg.label)} Agent Demo
      </div>
      <h1 style="font-size:clamp(26px,3.5vw,42px);font-weight:900;letter-spacing:-2px;line-height:1.1;margin-bottom:10px;">${esc(agentName)}<br/><span class="grad-text">for ${esc(companyName)}</span></h1>
      <p style="font-size:15px;color:var(--txt2);line-height:1.75;max-width:600px;">${esc(summary)}</p>
    </div>
    <div style="background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px 20px;font-size:13px;color:var(--txt2);max-width:260px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--txt3);margin-bottom:8px;">Demo Details</div>
      <div style="margin-bottom:5px;"><strong style="color:var(--txt);">Industry:</strong> ${esc(cfg.label)}</div>
      <div style="margin-bottom:5px;"><strong style="color:var(--txt);">Agent:</strong> ${esc(agentName)}</div>
      <div style="margin-bottom:5px;"><strong style="color:var(--txt);">Records:</strong> ${records.length} simulated</div>
      <div style="color:var(--amber);font-size:11px;margin-top:8px;">⚠ All data is fictional</div>
    </div>
  </div>

  <!-- METRICS -->
  <div style="margin-bottom:28px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--teal);margin-bottom:14px;">Performance Overview</div>
    <div class="metrics-row" style="display:flex;gap:14px;">${metricsHtml}</div>
  </div>

  <!-- MAIN GRID -->
  <div class="demo-grid" style="display:grid;grid-template-columns:1fr 360px;gap:20px;margin-bottom:28px;">

    <!-- LEFT: DATA TABLE -->
    <div style="background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
      <div style="background:var(--bg3);padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div style="font-size:14px;font-weight:800;">${esc(cfg.entityNamePlural)} Queue</div>
          <div style="font-size:11px;color:var(--teal);">20 records · Demo data · Processed by ${esc(agentName)}</div>
        </div>
        <div style="font-size:11px;font-weight:700;background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.2);color:var(--green);padding:4px 12px;border-radius:100px;">● Live Demo</div>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr style="background:var(--bg2);">
              <th style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--txt3);padding:10px 12px;text-align:left;">ID</th>
              <th style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--txt3);padding:10px 12px;text-align:left;">Subject</th>
              <th style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--txt3);padding:10px 12px;text-align:left;">Entity</th>
              <th style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--txt3);padding:10px 12px;text-align:left;">Value</th>
              <th style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--txt3);padding:10px 12px;text-align:left;">Priority</th>
              <th style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--txt3);padding:10px 12px;text-align:left;">Status</th>
              <th style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--txt3);padding:10px 12px;text-align:left;">Agent Action</th>
            </tr>
          </thead>
          <tbody>${recordRows}</tbody>
        </table>
      </div>
    </div>

    <!-- RIGHT COLUMN -->
    <div style="display:flex;flex-direction:column;gap:16px;">

      <!-- CHAT -->
      <div style="background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
        <div style="background:var(--bg3);padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;">
          <div style="width:32px;height:32px;border-radius:50%;background:var(--grad);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;">🤖</div>
          <div>
            <div style="font-size:13px;font-weight:800;">${esc(agentName)}</div>
            <div style="font-size:10px;color:var(--green);display:flex;align-items:center;gap:4px;">● Online · Demo mode</div>
          </div>
        </div>
        <div style="padding:16px;">${chatHtml}</div>
      </div>

      <!-- ACTIVITY LOG -->
      <div style="background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;">
        <div style="background:var(--bg3);padding:12px 16px;border-bottom:1px solid var(--border);">
          <div style="font-size:13px;font-weight:800;">Agent Activity Log</div>
          <div style="font-size:11px;color:var(--teal);">Recent actions</div>
        </div>
        <div style="padding:12px 16px;">${activityHtml}</div>
      </div>

    </div>
  </div>

  <!-- INTEGRATIONS -->
  <div style="background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px;margin-bottom:28px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--teal);margin-bottom:6px;">In the Real Version — Connects to Your Stack</div>
    <div style="font-size:14px;color:var(--txt2);margin-bottom:16px;">When deployed for your business, ${esc(agentName)} integrates with the tools your team already uses.</div>
    <div style="display:flex;flex-wrap:wrap;gap:10px;">${integrationsHtml}</div>
  </div>

  <!-- CTA SECTION -->
  <div style="background:linear-gradient(135deg,rgba(10,191,204,.07),rgba(8,145,178,.04));border:1px solid var(--teal);border-radius:20px;padding:36px;text-align:center;">
    <div style="font-size:22px;font-weight:900;letter-spacing:-.5px;margin-bottom:10px;">Ready to build the real version?</div>
    <div style="font-size:15px;color:var(--txt2);margin-bottom:24px;max-width:500px;margin-left:auto;margin-right:auto;line-height:1.7;">This demo uses simulated data. The real ${esc(agentName)} connects to your actual systems and processes your real workflows — deployed in 48 hours.</div>
    <a href="/assessment" style="display:inline-flex;align-items:center;gap:10px;background:var(--grad);color:#07101e;font-family:var(--ff);font-size:15px;font-weight:800;padding:16px 36px;border-radius:100px;text-decoration:none;">Book a Discovery Call →</a>
    <div style="font-size:12px;color:var(--txt3);margin-top:14px;">No commitment. We'll map your workflow and tell you exactly what's possible.</div>
  </div>

</div>

<!-- STICKY CTA -->
<a href="/assessment" class="sticky-cta">Book a Discovery Call →</a>

</body>
</html>`;
}

// ─── HTML ESCAPE ──────────────────────────────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ─── GITHUB API: COMMIT FILE ──────────────────────────────────────────────────

async function pushToGitHub(slug, htmlContent) {
  const path   = `demos/${slug}.html`;
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`;
  const encoded = Buffer.from(htmlContent, 'utf8').toString('base64');

  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      Authorization: `token ${GITHUB_PAT}`,
      'Content-Type': 'application/json',
      'User-Agent': 'upcore-demo-builder/1.0'
    },
    body: JSON.stringify({
      message: `feat: add demo ${slug}`,
      content: encoded
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error('GitHub API error ' + res.status + ': ' + err);
  }
  return await res.json();
}

// ─── GITHUB API: UPDATE MANIFEST ──────────────────────────────────────────────

async function updateManifest(entry) {
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/contents/demos/manifest.json`;

  // Get existing manifest
  let sha, existing = [];
  try {
    const getRes = await fetch(apiUrl, {
      headers: { Authorization: `token ${GITHUB_PAT}`, 'User-Agent': 'upcore-demo-builder/1.0' }
    });
    if (getRes.ok) {
      const getJson = await getRes.json();
      sha = getJson.sha;
      existing = JSON.parse(Buffer.from(getJson.content, 'base64').toString('utf8'));
    }
  } catch(e) { /* manifest doesn't exist yet */ }

  existing.push(entry);
  const encoded = Buffer.from(JSON.stringify(existing, null, 2), 'utf8').toString('base64');
  const body = { message: `chore: update demo manifest (${entry.slug})`, content: encoded };
  if (sha) body.sha = sha;

  await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      Authorization: `token ${GITHUB_PAT}`,
      'Content-Type': 'application/json',
      'User-Agent': 'upcore-demo-builder/1.0'
    },
    body: JSON.stringify(body)
  });
}

// ─── EMAIL NOTIFICATION ───────────────────────────────────────────────────────
// Uses FormSubmit.co — same service used by assessment.html.
// No API keys needed. Already confirmed for gaurav@upcoretechnologies.com.

const NOTIFY_TO = 'gaurav@upcoretechnologies.com';

async function sendLeadNotification({ userName, email, phone, industry, companyName, agentName, painPoint, actions, demoUrl, slug }) {
  const cfg = INDUSTRY_CONFIG[industry] || {};
  const actionsStr = (actions || []).join(', ') || 'Not specified';
  const createdAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

  // FormSubmit.co accepts JSON POST — formats it as a clean email table automatically
  const payload = {
    _subject:  `🤖 New Demo Lead — ${userName || email} · ${cfg.label || industry}`,
    _template: 'table',
    _captcha:  'false',
    // Contact fields
    'Name':        userName  || 'Not provided',
    'Email':       email     || 'Not provided',
    'Phone':       phone     || 'Not provided',
    'Company':     companyName || 'Not provided',
    // Demo fields
    'Industry':    `${cfg.emoji || ''} ${cfg.label || industry}`,
    'Agent Name':  agentName,
    'Actions':     actionsStr,
    'Pain Point':  painPoint,
    'Demo URL':    demoUrl,
    'Demo ID':     slug,
    'Created At':  `${createdAt} IST`,
  };

  const res = await fetch(`https://formsubmit.co/${NOTIFY_TO}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FormSubmit error ${res.status}: ${text}`);
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit
  const ip = getClientIP(req);
  const rl = checkRateLimit(ip);
  if (!rl.allowed) return res.status(429).json({ error: rl.reason });

  // Parse body
  let body;
  try { body = req.body; }
  catch(e) { return res.status(400).json({ error: 'Invalid request body' }); }

  const { industry, painPoint, actions = [], companyName = '', agentName: rawAgent = '', userName = '', email = '', phone = '' } = body;

  // Validate
  if (!industry || !['manufacturing', 'ecommerce'].includes(industry)) {
    return res.status(400).json({ error: 'Invalid industry. Must be manufacturing or ecommerce.' });
  }
  if (!painPoint || painPoint.length < 10) {
    return res.status(400).json({ error: 'Pain point is required (min 10 characters).' });
  }
  if (!userName || !userName.trim()) {
    return res.status(400).json({ error: 'Name is required.' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  if (!phone || phone.length < 7) {
    return res.status(400).json({ error: 'A valid phone number is required.' });
  }

  const cfg = INDUSTRY_CONFIG[industry];
  const agentName = (rawAgent || cfg.defaultAgentName).slice(0, 40);
  const slug = generateSlug(industry, agentName);

  // Expiry date (14 days)
  const expiryDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  try {
    // 1. Generate demo data via Claude
    const demoData = await generateDemoData(industry, painPoint, actions, agentName, companyName);

    // 2. Assemble HTML
    const html = assembleDemoHTML(demoData, industry, slug, expiryDate);

    // 3. Push to GitHub
    await pushToGitHub(slug, html);

    const demoUrl = `${SITE_BASE_URL}/demos/${slug}`;

    // 4. Update manifest + send lead notification (fire and forget — don't block response)
    const manifestEntry = {
      slug, industry, agentName,
      companyName: companyName || cfg.label + ' Demo',
      painPoint: painPoint.slice(0, 200),
      actions,
      userName: userName || null,
      email: email || null,
      phone: phone || null,
      created: new Date().toISOString(),
      expires: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
    };

    updateManifest(manifestEntry).catch(err => console.error('Manifest update failed:', err));

    sendLeadNotification({
      userName, email, phone, industry, companyName, agentName,
      painPoint, actions, demoUrl, slug
    }).catch(err => console.error('Lead notification email failed:', err));

    return res.status(200).json({ url: demoUrl, slug });

  } catch(err) {
    console.error('Build demo error:', err);
    return res.status(500).json({ error: 'Failed to build demo. Please try again.', detail: err.message });
  }
}
