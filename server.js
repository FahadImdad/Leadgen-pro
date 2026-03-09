/**
 * Lead Extractor - Web Server
 * Using direct API calls for Vercel compatibility
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
const HUNTER_API_KEY = process.env.HUNTER_API_KEY;

// Store for leads (in-memory for serverless)
let allLeads = [];
let seenEmails = new Set();

// Hunter.io: Find email from domain
async function findEmailWithHunter(domain, firstName, lastName) {
  if (!HUNTER_API_KEY) return null;
  
  try {
    let url = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_API_KEY}`;
    if (firstName) url += `&first_name=${encodeURIComponent(firstName)}`;
    if (lastName) url += `&last_name=${encodeURIComponent(lastName)}`;
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.data?.email) {
      return {
        email: data.data.email,
        confidence: data.data.confidence,
        verified: data.data.verification?.status === 'valid'
      };
    }
  } catch (err) {
    console.log('Hunter email finder error:', err.message);
  }
  return null;
}

// Hunter.io: Verify email
async function verifyEmailWithHunter(email) {
  if (!HUNTER_API_KEY || !email) return null;
  
  try {
    const response = await fetch(
      `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`
    );
    const data = await response.json();
    
    return {
      email: email,
      status: data.data?.status,
      score: data.data?.score,
      verified: data.data?.status === 'valid'
    };
  } catch (err) {
    console.log('Hunter verify error:', err.message);
  }
  return null;
}

// Extract domain from URL
function extractDomain(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname.replace('www.', '');
  } catch {
    return null;
  }
}

// Helper: Call Apify API directly
async function callApifyActor(actorId, input) {
  const response = await fetch(`https://api.apify.com/v2/acts/${actorId}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  
  const run = await response.json();
  if (!run.data?.id) throw new Error('Failed to start actor');
  
  // Wait for completion
  let status = 'RUNNING';
  let attempts = 0;
  while (status === 'RUNNING' && attempts < 60) {
    await new Promise(r => setTimeout(r, 2000));
    const statusRes = await fetch(`https://api.apify.com/v2/actor-runs/${run.data.id}?token=${APIFY_TOKEN}`);
    const statusData = await statusRes.json();
    status = statusData.data?.status;
    attempts++;
  }
  
  if (status !== 'SUCCEEDED') throw new Error(`Actor failed: ${status}`);
  
  // Get results
  const datasetId = run.data.defaultDatasetId;
  const resultsRes = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`);
  return await resultsRes.json();
}

// API: Get status
app.get('/api/status', async (req, res) => {
  try {
    if (!APIFY_TOKEN) {
      return res.json({ connected: false, error: 'No API token' });
    }
    
    const response = await fetch(`https://api.apify.com/v2/users/me?token=${APIFY_TOKEN}`);
    const data = await response.json();
    
    if (data.data) {
      res.json({ 
        connected: true, 
        user: data.data.username,
        plan: data.data.plan?.id || 'FREE'
      });
    } else {
      res.json({ connected: false, error: 'Invalid token' });
    }
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// Helper: Scrape page content to extract contact info
async function scrapePageForContacts(url) {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LeadBot/1.0)' },
      timeout: 10000
    });
    const html = await response.text();
    
    // Extract emails from page
    const emailMatches = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    // Filter out common non-lead/fake emails
    const emails = emailMatches.filter(e => {
      const lower = e.toLowerCase();
      // Exclude generic/system emails
      if (lower.includes('example.com')) return false;
      if (lower.includes('email.com')) return false;
      if (lower.includes('domain.com')) return false;
      if (lower.includes('reddit.com')) return false;
      if (lower.includes('privacy')) return false;
      if (lower.startsWith('support@')) return false;
      if (lower.startsWith('noreply')) return false;
      if (lower.startsWith('info@')) return false;
      if (lower.startsWith('admin@')) return false;
      if (lower.startsWith('contact@')) return false;
      if (lower.startsWith('help@')) return false;
      if (lower.startsWith('sales@')) return false;
      if (lower.startsWith('marketing@')) return false;
      if (lower.startsWith('webmaster@')) return false;
      // Exclude scam domains (from writerbeware list)
      if (lower.includes('amazonstudio.me')) return false;
      if (lower.includes('ballantinebooks.co')) return false;
      if (lower.includes('barnesandnoble.agency')) return false;
      if (lower.includes('book-agents.net')) return false;
      // Only keep personal-looking emails (gmail, yahoo, outlook, or personal domains)
      const isPersonal = lower.includes('@gmail.') || 
                         lower.includes('@yahoo.') || 
                         lower.includes('@hotmail.') ||
                         lower.includes('@outlook.') ||
                         lower.includes('@icloud.') ||
                         lower.includes('@aol.');
      // For non-personal, check it's not a generic role
      if (!isPersonal && !lower.match(/^[a-z]+\.[a-z]+@/)) {
        // Allow if it looks like firstname@ or name@
        if (lower.match(/^(admin|info|contact|support|help|sales|marketing|press|media|legal|hr|jobs|careers)@/)) {
          return false;
        }
      }
      return true;
    });
    
    // Extract phones - look for properly formatted phone numbers only
    // Match patterns like: (510) 800-6622, 510-800-6622, +1 510 800 6622
    const phoneMatches = html.match(/(?:\+?1[-.\s]?)?\(?[2-9][0-9]{2}\)?[-.\s]?[2-9][0-9]{2}[-.\s]?[0-9]{4}/g) || [];
    // Filter out fake/example numbers and year-like patterns
    const validPhones = phoneMatches.filter(p => {
      const digits = p.replace(/\D/g, '');
      // Must be 10 or 11 digits
      if (digits.length < 10 || digits.length > 11) return false;
      // Exclude obvious fake patterns
      if (digits.startsWith('123')) return false;
      if (digits.startsWith('000')) return false;
      if (digits.includes('555')) return false; // US fake prefix
      if (digits === '1234567890') return false;
      // Exclude year-like patterns (2020, 2021, 2022, etc.)
      if (/^(19|20)\d{8}$/.test(digits)) return false;
      if (/^\d{4}(19|20)\d{4}$/.test(digits)) return false;
      // Phone must have proper area code (not start with 0 or 1 after country code)
      const areaCode = digits.length === 11 ? digits.slice(1, 4) : digits.slice(0, 3);
      if (areaCode.startsWith('0') || areaCode.startsWith('1')) return false;
      return true;
    });
    
    // Try to extract Reddit username from URL or page
    let authorName = '';
    if (url.includes('reddit.com')) {
      const authorMatch = html.match(/"author"\s*:\s*"([^"]+)"/);
      if (authorMatch) authorName = authorMatch[1];
    }
    
    // Clean and decode email
    let cleanEmail = emails[0] || '';
    if (cleanEmail) {
      cleanEmail = decodeURIComponent(cleanEmail.replace(/%20/g, '').trim());
    }
    
    // Extract name from email if no author found
    let name = authorName;
    if (!name && cleanEmail) {
      // Get name from email (e.g., "sharon" from "sharon@domain.com")
      const emailName = cleanEmail.split('@')[0];
      // Clean up and capitalize
      name = emailName
        .replace(/[0-9._-]/g, ' ')
        .split(' ')
        .filter(p => p.length > 1)
        .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
        .join(' ')
        .trim();
    }
    
    return {
      email: cleanEmail,
      phone: validPhones[0] || '',
      authorName: name
    };
  } catch (err) {
    console.log('Scrape error for', url, ':', err.message);
    return { email: '', phone: '', authorName: '' };
  }
}

// API: Run extraction
app.post('/api/extract', async (req, res) => {
  const { keywords, platforms, maxResults = 20, region = 'us', timeframe = 'd' } = req.body;
  
  console.log('Starting extraction:', { keywords, platforms, maxResults });
  
  const results = [];
  
  try {
    for (const keyword of keywords) {
      // Enhanced search: look for posts with contact info
      const emailSearchQuery = `"${keyword}" ("@gmail.com" OR "@yahoo.com" OR "@hotmail.com" OR "email me" OR "contact me at")`;
      
      // Google Search (with contact patterns)
      if (platforms.includes('google')) {
        console.log(`Searching Google for: ${keyword}`);
        try {
          const items = await callApifyActor('apify~google-search-scraper', {
            queries: emailSearchQuery,
            maxPagesPerQuery: 1,
            resultsPerPage: Math.min(maxResults * 3, 50), // Get more to filter
            countryCode: region === 'all' ? 'us' : region,
            languageCode: 'en'
          });
          
          if (items[0]?.organicResults) {
            const limitedResults = items[0].organicResults.slice(0, maxResults * 2);
            for (const result of limitedResults) {
              // Scrape the page for actual contact info
              console.log('Scraping:', result.url);
              const contacts = await scrapePageForContacts(result.url);
              
              if (contacts.email && !seenEmails.has(contacts.email.toLowerCase())) {
                seenEmails.add(contacts.email.toLowerCase());
                results.push({
                  name: contacts.authorName || extractName(result.title),
                  email: contacts.email,
                  phone: contacts.phone || '',
                  source: 'Google',
                  query: keyword,
                  title: result.title,
                  url: result.url,
                  snippet: result.description || '',
                  extractedAt: new Date().toISOString()
                });
                
                // Stop if we have enough leads with emails
                if (results.length >= maxResults) break;
              }
            }
          }
        } catch (err) {
          console.log('Google error:', err.message);
        }
      }

      // Reddit (via Google - search for posts with contacts)
      if (platforms.includes('reddit')) {
        console.log(`Searching Reddit via Google for: ${keyword}`);
        try {
          const items = await callApifyActor('apify~google-search-scraper', {
            queries: `site:reddit.com "${keyword}" ("@gmail.com" OR "@yahoo.com" OR "email" OR "contact")`,
            maxPagesPerQuery: 1,
            resultsPerPage: Math.min(maxResults * 3, 30),
            countryCode: region === 'all' ? 'us' : region,
            languageCode: 'en'
          });
          
          if (items[0]?.organicResults) {
            const limitedResults = items[0].organicResults.slice(0, maxResults * 2);
            for (const result of limitedResults) {
              // Scrape the page for actual contact info
              console.log('Scraping Reddit:', result.url);
              const contacts = await scrapePageForContacts(result.url);
              
              if (contacts.email && !seenEmails.has(contacts.email.toLowerCase())) {
                seenEmails.add(contacts.email.toLowerCase());
                results.push({
                  name: contacts.authorName || 'Reddit User',
                  email: contacts.email,
                  phone: contacts.phone || '',
                  source: 'Reddit',
                  query: keyword,
                  title: result.title,
                  url: result.url,
                  snippet: result.description || '',
                  extractedAt: new Date().toISOString()
                });
                
                if (results.length >= maxResults) break;
              }
            }
          }
        } catch (err) {
          console.log('Reddit error:', err.message);
        }
      }

      // Upwork via Google (Upwork doesn't show emails publicly, skip scraping)
      if (platforms.includes('upwork')) {
        console.log(`Searching Upwork via Google for: ${keyword}`);
        try {
          const items = await callApifyActor('apify~google-search-scraper', {
            queries: `site:upwork.com "${keyword}" job`,
            maxPagesPerQuery: 1,
            resultsPerPage: Math.min(maxResults, 30),
            countryCode: region === 'all' ? 'us' : region,
            languageCode: 'en'
          });
          
          if (items[0]?.organicResults) {
            const limitedResults = items[0].organicResults.slice(0, maxResults);
            for (const result of limitedResults) {
              // Upwork jobs don't have public emails - this is for reference only
              // These leads need to be contacted through Upwork platform
              results.push({
                name: extractName(result.title),
                email: '(contact via Upwork)',
                phone: '',
                source: 'Upwork',
                query: keyword,
                title: result.title,
                url: result.url,
                snippet: result.description || '',
                extractedAt: new Date().toISOString(),
                note: 'Contact through Upwork platform'
              });
            }
          }
        } catch (err) {
          console.log('Upwork error:', err.message);
        }
      }
    }

    // Enrich leads with Hunter.io (try to find/verify emails)
    let hunterCreditsUsed = 0;
    const MAX_HUNTER_CALLS = 2; // Limit to save credits (free tier safe)
    
    for (const lead of results) {
      lead.emailVerified = false;
      
      // If already has email, verify it
      if (lead.email && hunterCreditsUsed < MAX_HUNTER_CALLS) {
        const verified = await verifyEmailWithHunter(lead.email);
        if (verified) {
          lead.emailVerified = verified.verified;
          lead.emailScore = verified.score;
        }
        hunterCreditsUsed++;
      } 
      // If no email but has URL, try to find email
      else if (!lead.email && lead.url && hunterCreditsUsed < MAX_HUNTER_CALLS) {
        const domain = extractDomain(lead.url);
        if (domain && !domain.includes('google.') && !domain.includes('reddit.') && !domain.includes('upwork.')) {
          const found = await findEmailWithHunter(domain, null, null);
          if (found?.email) {
            lead.email = found.email;
            lead.emailVerified = found.verified;
            lead.emailConfidence = found.confidence;
          }
          hunterCreditsUsed++;
        }
      }
    }
    
    // ONLY return leads with real emails (filter out placeholders)
    const leadsWithEmail = results.filter(l => 
      l.email && 
      l.email.includes('@') && 
      !l.email.includes('(contact via')
    );
    
    allLeads = leadsWithEmail;
    
    // Count stats
    const verified = leadsWithEmail.filter(l => l.emailVerified).length;
    
    res.json({ 
      success: true, 
      count: leadsWithEmail.length,
      totalScraped: results.length,
      verified: verified,
      leads: leadsWithEmail,
      hunterCreditsUsed: hunterCreditsUsed,
      message: leadsWithEmail.length === 0 ? 'No leads with email found. Try different keywords or platforms.' : ''
    });
  } catch (err) {
    console.error('Extraction error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// API: Export to Excel
app.get('/api/export', (req, res) => {
  if (allLeads.length === 0) {
    return res.status(400).json({ error: 'No leads to export' });
  }

  const data = allLeads.map(lead => ({
    'Name': lead.name || '',
    'Email': lead.email || '',
    'Phone': lead.phone || '',
    'Source': lead.source || '',
    'Query': lead.query || '',
    'Title': lead.title || '',
    'URL': lead.url || '',
    'Snippet': lead.snippet || '',
    'Extracted At': lead.extractedAt || ''
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');
  
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=leads_${Date.now()}.xlsx`);
  res.send(buffer);
});

// Helper functions
function extractName(text) {
  if (!text) return 'Unknown';
  return text.split(/[-:|]/)[0].trim().substring(0, 50) || 'Unknown';
}

function extractEmail(text) {
  if (!text) return '';
  const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : '';
}

function extractPhone(text) {
  if (!text) return '';
  const match = text.match(/[\+]?[(]?[0-9]{1,3}[)]?[-\s\.]?[0-9]{1,4}[-\s\.]?[0-9]{1,4}[-\s\.]?[0-9]{1,9}/);
  return match ? match[0] : '';
}

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;

// For local development
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Lead Extractor running at http://localhost:${PORT}`);
  });
}

// Export for Vercel
module.exports = app;
