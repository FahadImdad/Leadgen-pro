/**
 * LeadGen Pro - AI Agent Backend
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

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

// ============================================================
// AI AGENT: Query Planner
// Generates optimized search queries for each platform
// ============================================================
async function planSearchQueries(keyword, platforms) {
  if (!GEMINI_API_KEY) {
    // Fallback to default queries
    return getDefaultQueries(keyword, platforms);
  }

  try {
    const prompt = `You are a lead generation expert. Generate search queries to find CUSTOMERS who need "${keyword}" services.

We want to find REAL PEOPLE who are:
- Asking for help with their own project
- Looking for recommendations
- Seeking to hire someone
- Willing to pay for services

We do NOT want:
- Companies offering ${keyword} services
- Tutorials or guides
- Job postings for employees
- News articles

Generate 3 search queries for each platform. Return JSON only:
{
  "queries": {
    "google": ["query1", "query2", "query3"],
    "reddit": ["query1", "query2", "query3"],
    "linkedin": ["query1", "query2", "query3"],
    "twitter": ["query1", "query2", "query3"],
    "quora": ["query1", "query2", "query3"],
    "facebook": ["query1", "query2", "query3"]
  }
}

Focus on intent phrases like "I need", "looking for", "help me", "recommend", "hire".
Include site: operators where appropriate.`;

    const response = await callGemini(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.queries;
    }
  } catch (err) {
    console.log('Query planning error:', err.message);
  }
  
  return getDefaultQueries(keyword, platforms);
}

function getDefaultQueries(keyword, platforms) {
  const queries = {};
  
  // Intent-focused search patterns
  const intentPhrases = [
    `"need help with" OR "looking for someone" "${keyword}"`,
    `"can anyone recommend" OR "I need" "${keyword}"`,
    `"hire" OR "looking for" "${keyword}" "my project" OR "my business"`
  ];
  
  if (platforms.includes('google')) {
    queries.google = intentPhrases;
  }
  if (platforms.includes('reddit')) {
    queries.reddit = [
      `site:reddit.com ("I need" OR "looking for" OR "help me") "${keyword}"`,
      `site:reddit.com ("recommend" OR "advice") "${keyword}" "my"`,
      `site:reddit.com/r/forhire OR site:reddit.com/r/slavelabour "${keyword}"`
    ];
  }
  if (platforms.includes('linkedin')) {
    queries.linkedin = [
      `site:linkedin.com/posts ("looking for" OR "need") "${keyword}"`,
      `site:linkedin.com ("seeking" OR "hiring") "${keyword}" "@gmail.com"`,
    ];
  }
  if (platforms.includes('twitter')) {
    queries.twitter = [
      `site:twitter.com OR site:x.com ("need" OR "looking for") "${keyword}"`,
      `site:twitter.com ("help me" OR "anyone know") "${keyword}"`,
    ];
  }
  if (platforms.includes('quora')) {
    queries.quora = [
      `site:quora.com "how do I" OR "where can I" "${keyword}"`,
      `site:quora.com "recommend" "${keyword}" service`,
    ];
  }
  if (platforms.includes('facebook')) {
    queries.facebook = [
      `site:facebook.com ("need help" OR "looking for") "${keyword}"`,
      `site:facebook.com/groups "${keyword}" ("recommendations" OR "advice")`,
    ];
  }
  
  return queries;
}

// ============================================================
// AI AGENT: Lead Qualifier  
// Analyzes page content to determine if it's a real lead
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
- Email (if visible)
- Phone (if visible)  
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

    const response = await callGemini(prompt);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
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
  const emailMatch = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const email = emailMatch ? emailMatch[0] : '';
  
  // Extract Reddit username
  const redditMatch = url.match(/reddit\.com\/u(?:ser)?\/([^\/\?]+)/);
  const username = redditMatch ? `u/${redditMatch[1]}` : '';
  
  // Check for DM request
  const hasDmRequest = /\b(dm\s*me|message\s*me|pm\s*me)\b/i.test(content);
  
  return {
    is_lead: hasGood && !hasBad,
    name: '',
    email: email,
    phone: '',
    username: username,
    intent: '',
    intent_score: hasGood ? 6 : 3,
    contact_method: email ? 'email' : (hasDmRequest || username ? 'dm' : 'none'),
    reason: hasBad ? 'Contains tutorial/service provider patterns' : 'Pattern match'
  };
}

// ============================================================
// GEMINI API CALL
// ============================================================
async function callGemini(prompt) {
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
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ============================================================
// SERPER API (Google Search) - Free tier: 2500 searches
// ============================================================
async function searchWithSerper(query, options = {}) {
  if (!SERPER_API_KEY) {
    console.log('No Serper API key, falling back to Apify');
    return searchWithApify(query, options);
  }
  
  try {
    const response = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        q: query,
        gl: options.region || 'us',
        num: options.limit || 10,
        tbs: options.timeframe === 'd' ? 'qdr:d' : 
             options.timeframe === 'w' ? 'qdr:w' : 
             options.timeframe === 'm' ? 'qdr:m' : ''
      })
    });
    
    const data = await response.json();
    return (data.organic || []).map(r => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet
    }));
  } catch (err) {
    console.log('Serper error:', err.message);
    return [];
  }
}

// ============================================================
// APIFY GOOGLE SEARCH (Fallback)
// ============================================================
async function searchWithApify(query, options = {}) {
  if (!APIFY_TOKEN) return [];
  
  try {
    const timeframeMap = {
      'd': 'qdr:d',
      'w': 'qdr:w', 
      'm': 'qdr:m',
      'y': 'qdr:y'
    };
    
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
    const results = data[0]?.organicResults || [];
    return results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.description
    }));
  } catch (err) {
    console.log('Apify search error:', err.message);
    return [];
  }
}

// ============================================================
// PAGE SCRAPER - Fetches page content for AI analysis
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
    console.log('Fetch error for', url, ':', err.message);
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
  return 'Google';
}

// ============================================================
// USERNAME EXTRACTOR
// ============================================================
function extractUsername(url, content) {
  // Reddit
  let match = url.match(/reddit\.com\/(?:u(?:ser)?|r\/\w+\/comments\/\w+\/\w+)/) ||
              content.match(/(?:u\/|\/user\/)([a-zA-Z0-9_-]+)/);
  if (url.includes('reddit.com')) {
    const postAuthor = content.match(/"author"\s*:\s*"([^"]+)"/);
    if (postAuthor) return `u/${postAuthor[1]}`;
  }
  
  // Twitter
  if (url.includes('twitter.com') || url.includes('x.com')) {
    match = url.match(/(?:twitter\.com|x\.com)\/([^\/\?]+)/);
    if (match && !['search', 'explore', 'home'].includes(match[1])) {
      return `@${match[1]}`;
    }
  }
  
  // LinkedIn
  if (url.includes('linkedin.com/in/')) {
    match = url.match(/linkedin\.com\/in\/([^\/\?]+)/);
    if (match) return match[1];
  }
  
  return '';
}

// ============================================================
// MAIN API: /api/extract
// ============================================================
let allLeads = [];

app.post('/api/extract', async (req, res) => {
  const { keywords, platforms, maxResults = 10, region = 'us', timeframe = 'd' } = req.body;
  
  console.log('🤖 AI Agent starting extraction:', { keywords, platforms, maxResults });
  
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
      console.log(`\n📍 Processing keyword: ${keyword}`);
      
      // Step 1: AI Plans search queries
      console.log('🧠 Planning search queries...');
      const queries = await planSearchQueries(keyword, platforms);
      
      // Step 2: Execute searches across platforms
      for (const platform of platforms) {
        const platformQueries = queries[platform] || [];
        
        for (const query of platformQueries.slice(0, 2)) { // Limit queries per platform
          if (results.length >= maxResults) break;
          
          console.log(`🔍 Searching ${platform}: ${query.substring(0, 50)}...`);
          stats.searched++;
          
          const searchResults = await searchWithSerper(query, {
            region,
            timeframe,
            limit: Math.min(maxResults * 2, 15)
          });
          
          // Step 3: Analyze each result
          for (const result of searchResults) {
            if (results.length >= maxResults) break;
            if (seenUrls.has(result.url)) continue;
            seenUrls.add(result.url);
            
            console.log(`📄 Analyzing: ${result.url.substring(0, 60)}...`);
            stats.analyzed++;
            
            // Fetch page content
            const { text, html } = await fetchPageContent(result.url);
            if (!text || text.length < 100) continue;
            
            // Step 4: AI qualifies the lead
            const qualification = await qualifyLead(text, result.url, keyword);
            
            if (qualification.is_lead && qualification.intent_score >= 5) {
              stats.qualified++;
              
              const platform = detectPlatform(result.url);
              const username = qualification.username || extractUsername(result.url, html);
              
              const lead = {
                name: qualification.name || username || 'Unknown',
                email: qualification.email || (qualification.contact_method === 'dm' ? `(DM on ${platform})` : ''),
                phone: qualification.phone || '',
                source: platform,
                query: keyword,
                intent: qualification.intent || result.snippet?.substring(0, 100) || '',
                intentScore: qualification.intent_score,
                title: result.title,
                url: result.url,
                username: username,
                contactMethod: qualification.contact_method,
                extractedAt: new Date().toISOString()
              };
              
              // Track stats
              if (qualification.email && qualification.email.includes('@')) {
                stats.emailLeads++;
              } else {
                stats.dmLeads++;
              }
              
              results.push(lead);
              console.log(`✅ Qualified lead: ${lead.name} (${lead.contactMethod})`);
            } else {
              console.log(`❌ Rejected: ${qualification.reason || 'Low intent score'}`);
            }
          }
        }
      }
    }

    // Sort by intent score
    results.sort((a, b) => (b.intentScore || 0) - (a.intentScore || 0));
    
    allLeads = results;
    
    console.log(`\n🎯 Extraction complete: ${results.length} leads found`);
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
  try {
    const status = {
      gemini: !!GEMINI_API_KEY,
      serper: !!SERPER_API_KEY,
      apify: !!APIFY_TOKEN
    };
    
    // Test Gemini connection
    if (GEMINI_API_KEY) {
      try {
        await callGemini('Say "OK"');
        status.geminiConnected = true;
      } catch {
        status.geminiConnected = false;
      }
    }
    
    res.json({ 
      connected: status.gemini || status.apify,
      apis: status,
      agent: 'LeadGen AI Agent v2.0'
    });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
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
  console.log(`🚀 LeadGen AI Agent running on port ${PORT}`);
  console.log(`   Gemini: ${GEMINI_API_KEY ? '✅' : '❌'}`);
  console.log(`   Serper: ${SERPER_API_KEY ? '✅' : '❌'}`);
  console.log(`   Apify: ${APIFY_TOKEN ? '✅' : '❌'}`);
});

module.exports = app;
