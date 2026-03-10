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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

console.log('🔑 API Keys loaded:', {
  brightData: BRIGHT_DATA_API_KEY ? '✅' : '❌',
  gemini: GEMINI_API_KEY ? '✅' : '❌'
});

// ============================================================
// BRIGHT DATA SERP API (Primary & Only)
// ============================================================
async function brightDataSearch(query, options = {}) {
  if (!BRIGHT_DATA_API_KEY) {
    console.log('❌ No Bright Data API key configured');
    return [];
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
      console.log('❌ Bright Data error:', response.status, errText);
      return [];
    }
    
    const data = await response.json();
    
    // Parse response - body is a JSON string
    let organic = [];
    if (data.body) {
      try {
        const bodyData = typeof data.body === 'string' ? JSON.parse(data.body) : data.body;
        organic = bodyData.organic || [];
      } catch (e) {
        console.log('Body parse error:', e.message);
      }
    } else if (data.organic) {
      organic = data.organic;
    }
    
    const results = organic.map(r => ({
      title: r.title,
      url: r.link || r.url,
      snippet: r.description || r.snippet
    }));
    
    console.log(`✅ Found ${results.length} results`);
    return results;
    
  } catch (err) {
    console.log('❌ Bright Data error:', err.message);
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
    
    const prompt = `You are a strict lead qualification and data extraction AI. Analyze this content to find REAL potential customers seeking "${keyword}" services.

URL: ${url}

CONTENT:
${truncatedContent}

QUALIFICATION RULES:
✅ QUALIFY (is_lead: true) ONLY IF person is:
- Asking for help with THEIR OWN project
- Seeking recommendations or advice for hiring
- Willing to PAY for services
- Posts like "I need help with...", "looking for someone to...", "can anyone recommend..."

❌ REJECT (is_lead: false) IF:
- Company/agency OFFERING services
- Tutorial, guide, how-to article, blog post
- Job posting for employees
- News article, review, FAQ page
- Someone sharing their own work/portfolio

DATA EXTRACTION RULES (CRITICAL):
1. NAME (required): Extract the real name of the person who posted. If not visible, use username without prefixes.
2. EMAIL (required): Extract ONLY if a REAL email is visible in the content. 
   - Must be valid format (name@domain.com)
   - Personal emails preferred (gmail, yahoo, outlook)
   - DO NOT make up fake emails
   - If no email found, set email to empty string ""
3. PHONE (optional): Extract if visible, otherwise set to "-"
   - Must look like real phone number
   - DO NOT make up fake numbers
4. VERIFY EMAIL: Check if email looks legitimate (not example@, test@, fake patterns)

Respond with JSON only:
{
  "is_lead": true/false,
  "name": "Real name or username",
  "email": "real@email.com or empty string if not found",
  "email_verified": true/false,
  "phone": "real phone or -", 
  "username": "platform username",
  "intent": "what they need",
  "intent_score": 1-10,
  "contact_method": "email" or "dm",
  "reason": "qualification reason"
}

IMPORTANT: Never invent or guess email/phone. Only extract what's actually visible.`;

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
  
  // Extract REAL email only (personal domains)
  const emailMatch = content.match(/[a-zA-Z0-9._%+-]+@(gmail|yahoo|hotmail|outlook|icloud|aol)\.(com|net|org)/i);
  let email = '';
  if (emailMatch) {
    const potentialEmail = emailMatch[0].toLowerCase();
    // Validate it's not a fake pattern
    if (!potentialEmail.includes('example') && 
        !potentialEmail.includes('test') && 
        !potentialEmail.includes('fake') &&
        !potentialEmail.includes('sample') &&
        potentialEmail.length > 8) {
      email = potentialEmail;
    }
  }
  
  // Extract REAL phone only (validate format)
  let phone = '-';
  const phoneMatch = content.match(/(?:\+?1[-.\s]?)?\(?[2-9][0-9]{2}\)?[-.\s]?[2-9][0-9]{2}[-.\s]?[0-9]{4}/);
  if (phoneMatch) {
    const digits = phoneMatch[0].replace(/\D/g, '');
    // Validate not fake (555, 123, etc.)
    if (!digits.includes('555') && 
        !digits.startsWith('123') && 
        digits.length >= 10 && 
        digits.length <= 11) {
      phone = phoneMatch[0];
    }
  }
  
  // Extract username
  let username = '';
  if (url.includes('reddit.com')) {
    const match = content.match(/"author"\s*:\s*"([^"]+)"/);
    if (match && match[1] !== '[deleted]') username = `u/${match[1]}`;
  } else if (url.includes('twitter.com') || url.includes('x.com')) {
    const match = url.match(/(?:twitter\.com|x\.com)\/([^\/\?]+)/);
    if (match && !['search', 'explore', 'home'].includes(match[1])) username = `@${match[1]}`;
  } else if (url.includes('linkedin.com/in/')) {
    const match = url.match(/linkedin\.com\/in\/([^\/\?]+)/);
    if (match) username = match[1];
  }
  
  // Check for DM request
  const hasDmRequest = /\b(dm\s*me|message\s*me|pm\s*me)\b/i.test(content);
  
  return {
    is_lead: hasGood && !hasBad,
    name: '',
    email: email,
    email_verified: email ? true : false,
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
// SEARCH QUERY GENERATOR - Aggressive search for people SEEKING services
// ============================================================
function generateSearchQueries(keyword, platform) {
  // Queries focused on finding people who NEED the service (potential clients)
  const queries = {
    google: [
      `"I need" "${keyword}" "@gmail.com"`,
      `"looking for" "${keyword}" "email me" OR "contact me"`,
      `"help me with" "${keyword}" "@yahoo.com" OR "@hotmail.com"`,
      `"hire" "${keyword}" "my email" OR "reach me"`,
      `"seeking" "${keyword}" freelancer "budget"`,
      `"can anyone recommend" "${keyword}" "email"`,
      `"I'm looking for" "${keyword}" "@gmail.com" OR "@outlook.com"`
    ],
    reddit: [
      `site:reddit.com/r/forhire "[Hiring]" "${keyword}"`,
      `site:reddit.com ("I need" OR "looking for") "${keyword}" "email" OR "contact"`,
      `site:reddit.com/r/freelance "${keyword}" hiring`,
      `site:reddit.com ("help me find" OR "recommend") "${keyword}"`,
      `site:reddit.com "budget" "${keyword}" "looking for"`
    ],
    linkedin: [
      `site:linkedin.com/posts "looking for" "${keyword}" "email"`,
      `site:linkedin.com "hiring" "${keyword}" freelance`,
      `site:linkedin.com "need" "${keyword}" "contact"`
    ],
    twitter: [
      `site:twitter.com "need" "${keyword}" "DM" OR "email"`,
      `site:x.com "looking for" "${keyword}" "help"`,
      `site:twitter.com "hiring" "${keyword}"`,
      `site:twitter.com "anyone know" "${keyword}" "recommend"`
    ],
    facebook: [
      `site:facebook.com/groups "need" "${keyword}" "contact"`,
      `site:facebook.com "looking for" "${keyword}" "email" OR "message"`,
      `site:facebook.com "recommendations" "${keyword}" "budget"`
    ],
    instagram: [
      `site:instagram.com "need" "${keyword}" "DM"`,
      `site:instagram.com "looking for" "${keyword}"`
    ],
    quora: [
      `site:quora.com "where can I find" "${keyword}"`,
      `site:quora.com "recommend" "${keyword}" "affordable"`,
      `site:quora.com "how to hire" "${keyword}"`
    ],
    craigslist: [
      `site:craigslist.org/gig "${keyword}"`,
      `site:craigslist.org "need" "${keyword}"`,
      `site:craigslist.org "looking for" "${keyword}" "contact"`
    ],
    upwork: [
      `site:upwork.com/job "${keyword}"`,
      `site:upwork.com/freelance-jobs "${keyword}"`
    ]
  };
  
  return queries[platform] || queries.google;
}

// ============================================================
// MAIN API: /api/extract
// ============================================================
let allLeads = [];
let cachedLeads = {}; // Cache extra leads by keyword for future requests

app.post('/api/extract', async (req, res) => {
  const { keywords, platforms, maxResults = 10, region = 'us', timeframe = 'd' } = req.body;
  
  console.log('\n🤖 AI Agent starting extraction:', { keywords, platforms, maxResults });
  
  const results = [];
  const seenUrls = new Set();
  const stats = {
    searched: 0,
    analyzed: 0,
    qualified: 0,
    loops: 0,
    maxLoops: 10 // Safety limit
  };
  
  // Check cache first for matching keywords
  for (const keyword of keywords) {
    const cacheKey = keyword.toLowerCase().trim();
    if (cachedLeads[cacheKey] && cachedLeads[cacheKey].length > 0) {
      const cached = cachedLeads[cacheKey].splice(0, maxResults - results.length);
      results.push(...cached);
      console.log(`📦 Retrieved ${cached.length} leads from cache for "${keyword}"`);
    }
  }
  
  // If we have enough from cache, return early
  if (results.length >= maxResults) {
    allLeads = results.slice(0, maxResults);
    return res.json({
      success: true,
      requested: maxResults,
      found: allLeads.length,
      cached: 0,
      notAvailable: 0,
      stats: { ...stats, qualified: allLeads.length, fromCache: true },
      leads: allLeads
    });
  }

  try {
    // LOOP until we find enough leads or hit max iterations
    let queryOffset = 0; // Track which queries we've used
    
    while (results.length < maxResults && stats.loops < stats.maxLoops) {
      stats.loops++;
      console.log(`\n🔄 Search loop ${stats.loops}/${stats.maxLoops} - Found ${results.length}/${maxResults} leads`);
      
      for (const keyword of keywords) {
        if (results.length >= maxResults) break;
        console.log(`\n📍 Processing keyword: "${keyword}"`);
        
        for (const platform of platforms) {
          if (results.length >= maxResults) break;
          
          const queries = generateSearchQueries(keyword, platform);
          
          // Pick different queries each loop iteration
          const startIdx = (queryOffset % queries.length);
          const queriesToUse = [...queries.slice(startIdx), ...queries.slice(0, startIdx)].slice(0, 3);
          
          for (const query of queriesToUse) {
            if (results.length >= maxResults) break;
            
            stats.searched++;
            
            // Vary the number of results based on loop iteration
            const resultsPerQuery = 15 + (stats.loops * 5); // More results in later loops
            
            const searchResults = await brightDataSearch(query, {
              region,
              timeframe,
              limit: Math.min(resultsPerQuery, 50)
            });
          
            // Analyze each result
            for (const result of searchResults) {
              if (results.length >= maxResults) break;
              if (!result.url || seenUrls.has(result.url)) continue;
              seenUrls.add(result.url);
              
              // Limit total analysis per loop to avoid timeout
              if (stats.analyzed >= 50 * stats.loops) continue;
              
              console.log(`📄 Analyzing: ${result.url.substring(0, 60)}...`);
              stats.analyzed++;
              
              // Fetch page content
              const { text, html } = await fetchPageContent(result.url);
              if (!text || text.length < 100) continue;
              
              // AI qualifies the lead
              const qualification = await qualifyLead(text, result.url, keyword);
              
              if (qualification.is_lead && qualification.intent_score >= 5) {
                const detectedPlatform = detectPlatform(result.url);
                
                // Validate email is real and present
                const hasRealEmail = qualification.email && 
                                     qualification.email.includes('@') && 
                                     qualification.email.length > 5 &&
                                     !qualification.email.includes('example') &&
                                     !qualification.email.includes('test@') &&
                                     !qualification.email.includes('fake') &&
                                     /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(qualification.email);
                
                // Validate name is present
                const hasName = qualification.name && 
                                qualification.name.length > 1 && 
                                qualification.name !== 'Unknown' &&
                                qualification.name !== '-';
                
                // Only include if has real email
                if (hasRealEmail) {
                  stats.qualified++;
                  
                  const lead = {
                    name: hasName ? qualification.name : (qualification.username || '-'),
                    email: qualification.email,
                    phone: qualification.phone && qualification.phone !== '' ? qualification.phone : '-',
                    source: detectedPlatform,
                    query: keyword,
                    intent: qualification.intent || result.snippet?.substring(0, 100) || '',
                    intentScore: qualification.intent_score,
                    title: result.title,
                    url: result.url,
                    username: qualification.username || '',
                    contactMethod: 'email',
                    emailVerified: true,
                    extractedAt: new Date().toISOString()
                  };
                  
                  results.push(lead);
                  console.log(`✅ Lead #${results.length}/${maxResults}: ${lead.name} | ${lead.email} | Intent: ${lead.intentScore}/10`);
                } else {
                  console.log(`⚠️ Skipped: No real email found`);
                }
              } else {
                console.log(`❌ Rejected: ${qualification.reason || 'Not seeking services'}`);
              }
            }
          }
        }
      }
      
      // Increase query offset for next loop iteration to try different queries
      queryOffset++;
      
      // Log progress
      if (results.length < maxResults) {
        console.log(`\n⏳ Need ${maxResults - results.length} more leads, continuing search...`);
      }
    }

    // Sort by intent score (highest first)
    results.sort((a, b) => (b.intentScore || 0) - (a.intentScore || 0));
    
    // Split into results to return and extras to cache
    const toReturn = results.slice(0, maxResults);
    const toCache = results.slice(maxResults);
    
    // Cache extra leads for future requests
    if (toCache.length > 0) {
      for (const keyword of keywords) {
        const cacheKey = keyword.toLowerCase().trim();
        if (!cachedLeads[cacheKey]) cachedLeads[cacheKey] = [];
        cachedLeads[cacheKey].push(...toCache.filter(l => l.query.toLowerCase() === cacheKey));
      }
      console.log(`📦 Cached ${toCache.length} extra leads for future requests`);
    }
    
    allLeads = toReturn;
    
    console.log(`\n🎯 Extraction complete!`);
    console.log(`   🔄 Loops: ${stats.loops}`);
    console.log(`   📊 Searched: ${stats.searched} queries`);
    console.log(`   📄 Analyzed: ${stats.analyzed} pages`);
    console.log(`   ✅ Qualified: ${stats.qualified} leads (${toReturn.length} returned, ${toCache.length} cached)`);

    res.json({
      success: true,
      requested: maxResults,
      found: toReturn.length,
      cached: toCache.length,
      notAvailable: Math.max(0, maxResults - toReturn.length),
      stats: {
        loops: stats.loops,
        searched: stats.searched,
        analyzed: stats.analyzed,
        qualified: stats.qualified,
        returned: toReturn.length,
        cached: toCache.length
      },
      leads: toReturn,
      message: toReturn.length < maxResults 
        ? `Found ${toReturn.length}/${maxResults} leads with verified emails after ${stats.loops} search loops. Public emails are rare.` 
        : ''
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
    gemini: !!GEMINI_API_KEY
  };
  
  res.json({ 
    connected: status.brightData,
    apis: status,
    agent: 'LeadGen Pro AI Agent v2.2 (Bright Data Only)'
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
  console.log(`\n🚀 LeadGen Pro AI Agent v2.2 running on port ${PORT}`);
  console.log(`   Bright Data: ${BRIGHT_DATA_API_KEY ? '✅' : '❌'}`);
  console.log(`   Gemini AI: ${GEMINI_API_KEY ? '✅' : '❌'}\n`);
});

module.exports = app;
