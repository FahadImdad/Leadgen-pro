/**
 * LeadGen Pro - AI Agent Backend with Bright Data
 * Multi-platform lead discovery with LLM-powered qualification
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const XLSX = require('xlsx');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API Keys
const BRIGHT_DATA_API_KEY = process.env.BRIGHT_DATA_API_KEY;
const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

console.log('🔑 API Keys loaded:', {
  brightData: BRIGHT_DATA_API_KEY ? '✅' : '❌',
  apify: APIFY_TOKEN ? '✅' : '❌',
  gemini: GEMINI_API_KEY ? '✅' : '❌'
});

// ============================================================
// BRIGHT DATA SERP API
// ============================================================
async function brightDataSearch(query, options = {}) {
  if (!BRIGHT_DATA_API_KEY) {
    console.log('No Bright Data key, falling back to Apify');
    return apifySearch(query, options);
  }
  
  try {
    const params = new URLSearchParams({
      q: query,
      brd_json: '1',
      gl: options.region || 'us',
      hl: 'en',
      num: options.limit || 10
    });
    
    // Add time filter if specified
    if (options.timeframe === 'd') params.append('tbs', 'qdr:d');
    else if (options.timeframe === 'w') params.append('tbs', 'qdr:w');
    else if (options.timeframe === 'm') params.append('tbs', 'qdr:m');
    
    const url = `https://www.google.com/search?${params.toString()}`;
    
    console.log(`🔍 Bright Data SERP: ${query.substring(0, 50)}...`);
    
    const response = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${BRIGHT_DATA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        zone: 'serp_api1',
        url: url,
        format: 'json'
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      console.log('Bright Data error:', response.status, errText);
      return apifySearch(query, options);
    }
    
    const data = await response.json();
    
    // Parse organic results
    const results = (data.organic || []).map(r => ({
      title: r.title,
      url: r.link || r.url,
      snippet: r.description || r.snippet
    }));
    
    console.log(`✅ Found ${results.length} results`);
    return results;
    
  } catch (err) {
    console.log('Bright Data error:', err.message);
    return apifySearch(query, options);
  }
}

// ============================================================
// APIFY GOOGLE SEARCH (Fallback)
// ============================================================
async function apifySearch(query, options = {}) {
  if (!APIFY_TOKEN) {
    console.log('No Apify token available');
    return [];
  }
  
  try {
    const timeframeMap = {
      'd': 'qdr:d',
      'w': 'qdr:w', 
      'm': 'qdr:m',
      'y': 'qdr:y'
    };
    
    console.log(`🔍 Apify Search: ${query.substring(0, 50)}...`);
    
    const response = await fetch(
      `https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          queries: query + (options.timeframe ? ` &tbs=${timeframeMap[options.timeframe] || ''}` : ''),
          maxPagesPerQuery: 1,
          resultsPerPage: options.limit || 10,
          countryCode: options.region || 'us',
          languageCode: 'en'
        })
      }
    );
    
    const data = await response.json();
    const results = (data[0]?.organicResults || []).map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description
    }));
    
    console.log(`✅ Found ${results.length} results`);
    return results;
  } catch (err) {
    console.log('Apify search error:', err.message);
    return [];
  }
}

// ============================================================
// AI AGENT: Lead Qualifier (Gemini)
// ============================================================
async function qualifyLead(pageContent, url, keyword) {
  if (!GEMINI_API_KEY) {
    return fallbackQualification(pageContent, url);
  }

  try {
    const truncatedContent = pageContent.substring(0, 6000);
    
    const prompt = `You are a strict lead qualification AI. Analyze this content and determine if this is a REAL potential customer seeking "${keyword}" services.

URL: ${url}

CONTENT:
${truncatedContent}

QUALIFY AS LEAD (is_lead: true) ONLY IF:
- Individual person asking for help with THEIR OWN project
- Someone seeking recommendations or advice for hiring
- Person with a specific need who would PAY for services
- Posts like "I need help with...", "looking for someone to...", "can anyone recommend..."

REJECT (is_lead: false) IF:
- Company/agency OFFERING services (competitor)
- Tutorial, guide, how-to article, blog post
- Job posting for employees (not freelance)
- News article or review
- FAQ page or service provider website
- Someone sharing their own work/portfolio

EXTRACT IF QUALIFIED:
- Author name (who posted this)
- Email (if visible in content)
- Phone (if visible in content)  
- Platform username (Reddit u/, Twitter @, etc.)
- What they need (brief intent summary)
- Intent score 1-10 (10 = ready to buy, 1 = just curious)
- Contact method: "email" if email found, "dm" if need to DM them

Respond with JSON only:
{
  "is_lead": true/false,
  "name": "...",
  "email": "...",
  "phone": "...", 
  "username": "...",
  "intent": "...",
  "intent_score": 8,
  "contact_method": "email" or "dm",
  "reason": "why qualified/rejected"
}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 500
          }
        })
      }
    );
    
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    console.log('Qualification error:', err.message);
  }
  
  return fallbackQualification(pageContent, url);
}

function fallbackQualification(content, url) {
  const lower = content.toLowerCase();
  
  // Bad patterns (reject)
  const badPatterns = [
    'how to ', 'guide to', 'tutorial', 'step by step', 'tips for',
    'faq', 'our services', 'we offer', 'contact us', 'about us',
    'pricing', 'packages', 'copyright ©', 'privacy policy'
  ];
  
  // Good patterns (seeking help)
  const goodPatterns = [
    'i need', 'looking for', 'can anyone', 'help me', 'recommend',
    'seeking', 'hire', 'my project', 'my book', 'my website', 'dm me'
  ];
  
  const hasBad = badPatterns.some(p => lower.includes(p));
  const hasGood = goodPatterns.some(p => lower.includes(p));
  
  // Extract email
  const emailMatch = content.match(/[a-zA-Z0-9._%+-]+@(gmail|yahoo|hotmail|outlook)\.[a-zA-Z]{2,}/i);
  const email = emailMatch ? emailMatch[0] : '';
  
  // Extract phone
  const phoneMatch = content.match(/(?:\+?1[-.\s]?)?\(?[2-9][0-9]{2}\)?[-.\s]?[2-9][0-9]{2}[-.\s]?[0-9]{4}/);
  const phone = phoneMatch ? phoneMatch[0] : '';
  
  // Extract username
  let username = '';
  if (url.includes('reddit.com')) {
    const match = content.match(/"author"\s*:\s*"([^"]+)"/);
    if (match) username = `u/${match[1]}`;
  } else if (url.includes('twitter.com') || url.includes('x.com')) {
    const match = url.match(/(?:twitter\.com|x\.com)\/([^\/\?]+)/);
    if (match) username = `@${match[1]}`;
  }
  
  // Check for DM request
  const hasDmRequest = /\b(dm\s*me|message\s*me|pm\s*me)\b/i.test(content);
  
  return {
    is_lead: hasGood && !hasBad,
    name: '',
    email: email,
    phone: phone,
    username: username,
    intent: '',
    intent_score: hasGood ? 6 : 3,
    contact_method: email ? 'email' : (hasDmRequest || username ? 'dm' : 'none'),
    reason: hasBad ? 'Contains tutorial/service provider patterns' : 'Pattern match'
  };
}

// ============================================================
// PAGE SCRAPER
// ============================================================
async function fetchPageContent(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    const html = await response.text();
    
    // Strip HTML tags, get plain text
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    return { text, html };
  } catch (err) {
    console.log('Fetch error for', url.substring(0, 50), ':', err.message);
    return { text: '', html: '' };
  }
}

// ============================================================
// PLATFORM DETECTOR
// ============================================================
function detectPlatform(url) {
  if (url.includes('reddit.com')) return 'Reddit';
  if (url.includes('linkedin.com')) return 'LinkedIn';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'Twitter';
  if (url.includes('facebook.com')) return 'Facebook';
  if (url.includes('quora.com')) return 'Quora';
  if (url.includes('instagram.com')) return 'Instagram';
  if (url.includes('craigslist.org')) return 'Craigslist';
  if (url.includes('upwork.com')) return 'Upwork';
  return 'Google';
}

// ============================================================
// SEARCH QUERY GENERATOR
// ============================================================
function generateSearchQueries(keyword, platform) {
  const queries = {
    google: [
      `"I need" OR "looking for" "${keyword}" "@gmail.com" OR "@yahoo.com"`,
      `"help me with" OR "recommend" "${keyword}" "my project" OR "my business"`,
      `"hire" OR "seeking" "${keyword}" "contact" OR "email"`
    ],
    reddit: [
      `site:reddit.com ("I need" OR "looking for") "${keyword}"`,
      `site:reddit.com/r/forhire "${keyword}"`,
      `site:reddit.com ("help me" OR "recommend") "${keyword}" -tutorial`
    ],
    linkedin: [
      `site:linkedin.com/posts ("looking for" OR "need") "${keyword}"`,
      `site:linkedin.com ("seeking" OR "hiring freelancer") "${keyword}"`
    ],
    twitter: [
      `site:twitter.com OR site:x.com ("need" OR "looking for") "${keyword}"`,
      `site:twitter.com ("help me" OR "anyone know") "${keyword}"`
    ],
    facebook: [
      `site:facebook.com/groups ("need help" OR "looking for") "${keyword}"`,
      `site:facebook.com ("recommendations" OR "advice") "${keyword}"`
    ],
    instagram: [
      `site:instagram.com ("need" OR "looking for") "${keyword}"`,
      `site:instagram.com ("dm me" OR "help") "${keyword}"`
    ],
    quora: [
      `site:quora.com "how do I find" OR "where can I get" "${keyword}"`,
      `site:quora.com "recommend" "${keyword}" service`
    ],
    craigslist: [
      `site:craigslist.org ("need" OR "looking for") "${keyword}"`,
      `site:craigslist.org/gig "${keyword}"`
    ],
    upwork: [
      `site:upwork.com/job "${keyword}"`,
      `site:upwork.com "${keyword}" budget`
    ]
  };
  
  return queries[platform] || queries.google;
}

// ============================================================
// MAIN API: /api/extract
// ============================================================
let allLeads = [];

app.post('/api/extract', async (req, res) => {
  const { keywords, platforms, maxResults = 10, region = 'us', timeframe = 'd' } = req.body;
  
  console.log('\n🤖 AI Agent starting extraction:', { keywords, platforms, maxResults });
  
  const results = [];
  const seenUrls = new Set();
  const stats = {
    searched: 0,
    analyzed: 0,
    qualified: 0,
    emailLeads: 0,
    dmLeads: 0
  };

  try {
    for (const keyword of keywords) {
      console.log(`\n📍 Processing keyword: "${keyword}"`);
      
      for (const platform of platforms) {
        if (results.length >= maxResults) break;
        
        const queries = generateSearchQueries(keyword, platform);
        
        for (const query of queries.slice(0, 2)) {
          if (results.length >= maxResults) break;
          
          stats.searched++;
          
          // Use Bright Data or fallback to Apify
          const searchResults = await brightDataSearch(query, {
            region,
            timeframe,
            limit: Math.min(maxResults * 2, 15)
          });
          
          // Analyze each result
          for (const result of searchResults) {
            if (results.length >= maxResults) break;
            if (!result.url || seenUrls.has(result.url)) continue;
            seenUrls.add(result.url);
            
            console.log(`📄 Analyzing: ${result.url.substring(0, 60)}...`);
            stats.analyzed++;
            
            // Fetch page content
            const { text, html } = await fetchPageContent(result.url);
            if (!text || text.length < 100) continue;
            
            // AI qualifies the lead
            const qualification = await qualifyLead(text, result.url, keyword);
            
            if (qualification.is_lead && qualification.intent_score >= 5) {
              stats.qualified++;
              
              const detectedPlatform = detectPlatform(result.url);
              
              const lead = {
                name: qualification.name || qualification.username || 'Unknown',
                email: qualification.email || (qualification.contact_method === 'dm' ? `(DM on ${detectedPlatform})` : ''),
                phone: qualification.phone || '',
                source: detectedPlatform,
                query: keyword,
                intent: qualification.intent || result.snippet?.substring(0, 100) || '',
                intentScore: qualification.intent_score,
                title: result.title,
                url: result.url,
                username: qualification.username || '',
                contactMethod: qualification.contact_method,
                extractedAt: new Date().toISOString()
              };
              
              // Track stats
              if (qualification.email && qualification.email.includes('@')) {
                stats.emailLeads++;
              } else if (qualification.contact_method === 'dm') {
                stats.dmLeads++;
              }
              
              results.push(lead);
              console.log(`✅ Lead #${results.length}: ${lead.name} (${lead.contactMethod}) - Intent: ${lead.intentScore}/10`);
            } else {
              console.log(`❌ Rejected: ${qualification.reason || 'Low intent'}`);
            }
          }
        }
      }
    }

    // Sort by intent score
    results.sort((a, b) => (b.intentScore || 0) - (a.intentScore || 0));
    
    allLeads = results;
    
    console.log(`\n🎯 Extraction complete!`);
    console.log(`   📊 Searched: ${stats.searched} queries`);
    console.log(`   📄 Analyzed: ${stats.analyzed} pages`);
    console.log(`   ✅ Qualified: ${stats.qualified} leads`);
    console.log(`   📧 Email leads: ${stats.emailLeads}`);
    console.log(`   💬 DM leads: ${stats.dmLeads}`);

    res.json({
      success: true,
      requested: maxResults,
      found: stats.emailLeads,
      dmLeads: stats.dmLeads,
      notAvailable: Math.max(0, maxResults - results.length),
      stats: stats,
      leads: results,
      message: results.length === 0 ? 'No qualified leads found. Try different keywords or platforms.' : ''
    });

  } catch (err) {
    console.error('Extraction error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================
// API: Status
// ============================================================
app.get('/api/status', async (req, res) => {
  const status = {
    brightData: !!BRIGHT_DATA_API_KEY,
    apify: !!APIFY_TOKEN,
    gemini: !!GEMINI_API_KEY
  };
  
  res.json({ 
    connected: status.brightData || status.apify,
    apis: status,
    agent: 'LeadGen Pro AI Agent v2.1 (Bright Data)'
  });
});

// ============================================================
// API: Export to Excel
// ============================================================
app.get('/api/export', (req, res) => {
  if (allLeads.length === 0) {
    return res.status(400).json({ error: 'No leads to export' });
  }

  const exportData = allLeads.map(lead => ({
    'Name': lead.name,
    'Email': lead.email,
    'Phone': lead.phone,
    'Username': lead.username || '',
    'Contact Method': lead.contactMethod === 'dm' ? '💬 DM Required' : '📧 Email',
    'Intent Score': lead.intentScore || '',
    'What They Need': lead.intent,
    'Source': lead.source,
    'Service Keyword': lead.query,
    'Post Title': lead.title,
    'URL': lead.url,
    'Extracted At': lead.extractedAt
  }));

  const ws = XLSX.utils.json_to_sheet(exportData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Leads');
  
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  
  res.setHeader('Content-Disposition', 'attachment; filename=leads.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buffer);
});

// ============================================================
// Start Server
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 LeadGen Pro AI Agent v2.1 running on port ${PORT}`);
  console.log(`   Bright Data: ${BRIGHT_DATA_API_KEY ? '✅' : '❌'}`);
  console.log(`   Apify: ${APIFY_TOKEN ? '✅' : '❌'}`);
  console.log(`   Gemini: ${GEMINI_API_KEY ? '✅' : '❌'}\n`);
});

module.exports = app;
