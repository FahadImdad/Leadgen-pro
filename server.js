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
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    
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
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const responseText = await response.text();
    console.log('📡 Bright Data response status:', response.status);
    console.log('📡 Response preview:', responseText.substring(0, 500));
    
    if (!response.ok) {
      console.log('❌ Bright Data error:', response.status, responseText);
      return [];
    }
    
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.log('❌ JSON parse error:', e.message);
      return [];
    }
    
    // Parse response - body is a JSON string
    let organic = [];
    if (data.body) {
      try {
        const bodyData = typeof data.body === 'string' ? JSON.parse(data.body) : data.body;
        console.log('📊 Body parsed, organic count:', (bodyData.organic || []).length);
        organic = bodyData.organic || [];
      } catch (e) {
        console.log('Body parse error:', e.message);
        console.log('Raw body:', data.body?.substring(0, 300));
      }
    } else if (data.organic) {
      organic = data.organic;
    } else {
      console.log('⚠️ No organic results in response. Keys:', Object.keys(data));
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
    return fallbackQualification(pageContent, url, keyword);
  }

  try {
    const truncatedContent = pageContent.substring(0, 3000); // Shorter for speed
    
    const prompt = `Is this someone who might need "${keyword}" services? Be LENIENT - we want more leads.

CONTENT: ${truncatedContent}

QUICK CHECK:
1. Related to ${keyword}? (loosely counts)
2. NOT a company selling services? (individuals, job posts = OK)
3. Might need help? (questions, hiring, recommendations, discussions = OK)

BE LENIENT: If 2 out of 3 are YES, set is_lead: true
Only reject if it's CLEARLY a company ad or completely unrelated.

JSON ONLY:
{
  "is_lead": true/false,
  "name": "name or username",
  "email": "email if found or empty",
  "phone": "phone if found or -",
  "username": "username if visible",
  "intent": "what they might need",
  "intent_score": 1-10,
  "reason": "brief reason"
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
  
  return fallbackQualification(pageContent, url, keyword);
}

function fallbackQualification(content, url, keyword = '') {
  const lower = content.toLowerCase();
  const keywordLower = keyword.toLowerCase();
  
  // Check keyword relevance
  const keywordWords = keywordLower.split(' ').filter(w => w.length > 2);
  const hasKeyword = keywordWords.some(word => lower.includes(word));
  if (!hasKeyword) {
    return { is_lead: false, reason: 'Not relevant to keyword' };
  }
  
  // STRICT REJECTION patterns - companies/service providers
  const rejectPatterns = [
    'we offer', 'our services', 'contact us', 'reach out',
    'available for hire', 'hire me', 'my portfolio',
    'years of experience', 'professional services',
    'publishing house', 'publishing company', 'our team',
    'starting at', 'prices from', 'get a quote',
    'ltd', 'llc', 'inc.', 'agency',
    '#bookpublishing', '#author', '#selfpublish',
    'million books', 'worldwide', '📚✨'
  ];
  
  if (rejectPatterns.some(p => lower.includes(p))) {
    return { is_lead: false, reason: 'Service provider or company' };
  }
  
  // MUST have seeking patterns
  const seekingPatterns = [
    'i need help', 'i need someone', 'looking for someone',
    'can anyone help', 'can anyone recommend',
    '[hiring]', 'hiring:', 'want to hire',
    'my manuscript', 'my book', 'i wrote', "i've written",
    'help me publish', 'need a publisher', 'looking for publisher'
  ];
  
  const isSeeking = seekingPatterns.some(p => lower.includes(p));
  if (!isSeeking) {
    return { is_lead: false, reason: 'No clear intent to hire' };
  }
  
  // Extract ALL emails (not just personal)
  const emailMatches = content.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi) || [];
  const validEmails = emailMatches.filter(e => 
    !e.includes('example') && !e.includes('test') && 
    !e.includes('noreply') && !e.includes('no-reply') &&
    e.length > 5 && e.length < 50
  );
  const email = validEmails[0] ? validEmails[0].toLowerCase() : '';
  
  // Extract username/name from URL and content
  let username = '';
  let name = '';
  
  if (url.includes('reddit.com')) {
    // Reddit: extract from URL path
    const postMatch = url.match(/comments\/[^\/]+\/([^\/]+)/);
    if (postMatch) username = postMatch[1].replace(/_/g, ' ').substring(0, 30);
    // Try to get actual username
    const authorMatch = content.match(/u\/([a-zA-Z0-9_-]+)/);
    if (authorMatch) name = authorMatch[1];
  } else if (url.includes('facebook.com')) {
    // Facebook: extract name from URL
    const fbMatch = url.match(/facebook\.com\/([^\/]+)/);
    if (fbMatch && !['groups', 'pages', 'posts'].includes(fbMatch[1])) {
      name = fbMatch[1].replace(/\./g, ' ');
    }
  } else if (url.includes('quora.com')) {
    // Quora: extract from content
    const quoraMatch = content.match(/asked by ([^,\n]+)/i);
    if (quoraMatch) name = quoraMatch[1].trim();
    username = 'Quora User';
  } else if (url.includes('twitter.com') || url.includes('x.com')) {
    const twitterMatch = url.match(/(?:twitter|x)\.com\/([^\/\?]+)/);
    if (twitterMatch) name = '@' + twitterMatch[1];
  }
  
  // Build contact info
  let contactInfo = email;
  if (!email && (name || username)) {
    contactInfo = `DM: ${name || username}`;
  } else if (!email) {
    contactInfo = 'Visit Link';
  }
  
  return {
    is_lead: true,
    name: name || username || 'Lead',
    email: contactInfo,
    phone: '-',
    username: name || username || '',
    intent: content.substring(0, 100),
    intent_score: email ? 8 : 6,
    contact_method: email ? 'email' : 'dm',
    reason: 'Pattern match - seeking help'
  };
}

// ============================================================
// PAGE SCRAPER (Direct fetch with fallback)
// ============================================================
async function fetchPageContent(url, sendProgress = null) {
  // Try direct fetch first (works for Reddit, Quora, some others)
  let fetchUrl = url;
  
  // Reddit: use old.reddit.com (less blocking)
  if (url.includes('reddit.com') && !url.includes('old.reddit.com')) {
    fetchUrl = url.replace('www.reddit.com', 'old.reddit.com').replace('reddit.com', 'old.reddit.com');
  }
  
  try {
    if (sendProgress) sendProgress(-1, -1, `🌐 Fetching page content...`);
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    
    const response = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      if (sendProgress) sendProgress(-1, -1, `⚠️ Page blocked (${response.status}), using snippet`);
      return { text: '', html: '' };
    }
    
    const html = await response.text();
    
    // Check for block pages
    if (html.includes("You've been blocked") || html.includes('access denied') || html.includes('captcha')) {
      if (sendProgress) sendProgress(-1, -1, `⚠️ Page blocked, using snippet`);
      return { text: '', html: '' };
    }
    
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ')
      .trim();
    
    if (sendProgress) sendProgress(-1, -1, `✅ Got ${text.length} chars`);
    return { text, html };
    
  } catch (err) {
    if (sendProgress) sendProgress(-1, -1, `⚠️ Fetch failed: ${err.message}`);
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
  // Simpler queries that actually return results
  const queries = {
    google: [
      `${keyword} need help`,
      `${keyword} looking for freelancer`,
      `${keyword} hiring`,
      `${keyword} need someone`,
      `${keyword} recommendations`,
      `looking for ${keyword}`,
      `need ${keyword} help`
    ],
    reddit: [
      `site:reddit.com ${keyword} hiring`,
      `site:reddit.com ${keyword} need help`,
      `site:reddit.com ${keyword} looking for`,
      `site:reddit.com/r/forhire ${keyword}`,
      `site:reddit.com/r/freelance ${keyword}`,
      `site:reddit.com ${keyword} recommend`,
      `site:reddit.com ${keyword} budget`
    ],
    linkedin: [
      `site:linkedin.com ${keyword} hiring`,
      `site:linkedin.com ${keyword} need`,
      `site:linkedin.com ${keyword} looking for`,
      `site:linkedin.com ${keyword} recommendations`
    ],
    twitter: [
      `site:twitter.com ${keyword} need`,
      `site:twitter.com ${keyword} looking for`,
      `site:twitter.com ${keyword} hiring`,
      `site:x.com ${keyword} help`
    ],
    facebook: [
      `site:facebook.com ${keyword} need`,
      `site:facebook.com ${keyword} looking for`,
      `site:facebook.com ${keyword} recommendations`
    ],
    instagram: [
      `site:instagram.com ${keyword} need`,
      `site:instagram.com ${keyword} looking for`
    ],
    quora: [
      `site:quora.com ${keyword} recommend`,
      `site:quora.com ${keyword} how to find`,
      `site:quora.com ${keyword} hire`
    ],
    craigslist: [
      `site:craigslist.org ${keyword}`,
      `site:craigslist.org ${keyword} needed`
    ],
    upwork: [
      `site:upwork.com ${keyword}`,
      `site:upwork.com ${keyword} job`
    ]
  };
  
  return queries[platform] || queries.google;
}

// ============================================================
// MAIN API: /api/extract
// ============================================================
let allLeads = [];
let cachedLeads = {}; // Cache extra leads by keyword for future requests

// SSE endpoint for real-time extraction with progress
app.get('/api/extract-stream', async (req, res) => {
  const { keywords, platforms, maxResults = 10, region = 'us', timeframe = 'd' } = req.query;
  
  // Parse arrays from query string
  const keywordList = keywords ? keywords.split(',') : [];
  const platformList = platforms ? platforms.split(',') : [];
  const max = parseInt(maxResults);
  
  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const sendProgress = (found, total, message) => {
    res.write(`data: ${JSON.stringify({ type: 'progress', found, total, message })}\n\n`);
  };
  
  const sendLead = (lead, found, total) => {
    res.write(`data: ${JSON.stringify({ type: 'lead', lead, found, total })}\n\n`);
  };
  
  const sendComplete = (leads, stats) => {
    res.write(`data: ${JSON.stringify({ type: 'complete', leads, stats })}\n\n`);
    res.end();
  };
  
  const sendError = (error) => {
    res.write(`data: ${JSON.stringify({ type: 'error', error })}\n\n`);
    res.end();
  };

  try {
    const results = [];
    const seenUrls = new Set();
    const stats = { searched: 0, analyzed: 0, qualified: 0, loops: 0 };
    let queryOffset = 0;
    
    sendProgress(0, max, 'Starting search...');
    
    const maxLoops = 50; // Safety limit
    let noNewResultsCount = 0;
    
    while (results.length < max && stats.loops < maxLoops) {
      stats.loops++;
      const resultsBeforeLoop = results.length;
      sendProgress(results.length, max, `🔄 Loop ${stats.loops}/${maxLoops} — Found ${results.length}/${max}...`);
      
      for (const keyword of keywordList) {
        if (results.length >= max) break;
        
        for (const platform of platformList) {
          if (results.length >= max) break;
          
          const queries = generateSearchQueries(keyword, platform);
          // Pick different queries each loop
          const queryIdx = (stats.loops - 1) % queries.length;
          const query = queries[queryIdx];
          
          if (!query) continue;
          
          stats.searched++;
          
          // Show the actual query being sent to Bright Data
          const shortQuery = query.length > 60 ? query.substring(0, 60) + '...' : query;
          sendProgress(results.length, max, `⚡ Query: "${shortQuery}"`);
          
          const searchResults = await brightDataSearch(query, { region, timeframe, limit: 20 });
          
          // Show what Bright Data returned
          sendProgress(results.length, max, `✅ Got ${searchResults.length} results`);
          
          for (const result of searchResults) {
            if (results.length >= max) break;
            if (!result.url || seenUrls.has(result.url)) continue;
            seenUrls.add(result.url);
            
            stats.analyzed++;
            
            // Use snippet for SPEED
            const content = `${result.title || ''} ${result.snippet || ''}`;
            if (!content || content.length < 30) continue;
            
            const qualification = await qualifyLead(content, result.url, keyword);
            
            // Show AI decision briefly
            sendProgress(results.length, max, qualification.is_lead 
              ? `✅ Lead found: ${qualification.name || 'Unknown'}` 
              : `❌ Rejected: ${qualification.reason || 'Not a lead'}`);
            
            if (qualification.is_lead && (qualification.intent_score || 5) >= 3) {
              const detectedPlatform = detectPlatform(result.url);
              const hasRealEmail = qualification.email && 
                qualification.email.includes('@') && 
                /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(qualification.email);
              
              stats.qualified++;
              
              const contactInfo = hasRealEmail ? qualification.email : 
                (qualification.username ? `DM: ${qualification.username}` : 'Visit Link');
              
              const lead = {
                name: qualification.name || qualification.username || result.title?.substring(0, 30) || 'Lead',
                email: contactInfo,
                phone: qualification.phone || '-',
                source: detectedPlatform,
                query: keyword,
                intent: qualification.intent || result.snippet?.substring(0, 100) || '',
                intentScore: qualification.intent_score || 5,
                url: result.url,
                username: qualification.username || '',
                contactMethod: hasRealEmail ? 'email' : 'dm'
              };
              
              results.push(lead);
              sendLead(lead, results.length, max);
            }
          }
        }
      }
      
      // Check if we found any new leads this loop
      if (results.length === resultsBeforeLoop) {
        noNewResultsCount++;
        sendProgress(results.length, max, `⚠️ No new leads found (${noNewResultsCount}/3 empty loops)`);
        if (noNewResultsCount >= 3) {
          sendProgress(results.length, max, `🛑 Stopping: No more leads available`);
          break;
        }
      } else {
        noNewResultsCount = 0; // Reset if we found something
      }
    }
    
    allLeads = results;
    sendProgress(results.length, max, `✅ Search complete! Found ${results.length} leads.`);
    sendComplete(results, stats);
    
  } catch (err) {
    sendError(err.message);
  }
});

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
              if (stats.analyzed >= 15 * stats.loops) continue;
              
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
                
                // Check if DM lead (has username but no email)
                const isDmLead = !hasRealEmail && qualification.username && qualification.username.length > 1;
                
                // Accept both email leads AND DM leads
                if (hasRealEmail || isDmLead) {
                  stats.qualified++;
                  
                  const lead = {
                    name: hasName ? qualification.name : (qualification.username || '-'),
                    email: hasRealEmail ? qualification.email : 'With DM Me',
                    phone: qualification.phone && qualification.phone !== '' ? qualification.phone : '-',
                    source: detectedPlatform,
                    query: keyword,
                    intent: qualification.intent || result.snippet?.substring(0, 100) || '',
                    intentScore: qualification.intent_score,
                    title: result.title,
                    url: result.url,
                    username: qualification.username || '',
                    contactMethod: hasRealEmail ? 'email' : 'dm',
                    emailVerified: hasRealEmail,
                    extractedAt: new Date().toISOString()
                  };
                  
                  results.push(lead);
                  const contactType = hasRealEmail ? '📧' : '💬';
                  console.log(`✅ Lead #${results.length}/${maxResults}: ${contactType} ${lead.name} | ${lead.email} | Intent: ${lead.intentScore}/10`);
                } else {
                  console.log(`⚠️ Skipped: No email or username found`);
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
