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

// API: Run extraction
app.post('/api/extract', async (req, res) => {
  const { keywords, platforms, maxResults = 20, region = 'us', timeframe = 'd' } = req.body;
  
  console.log('Starting extraction:', { keywords, platforms, maxResults });
  
  const results = [];
  
  try {
    for (const keyword of keywords) {
      // Google Search
      if (platforms.includes('google')) {
        console.log(`Searching Google for: ${keyword}`);
        try {
          const items = await callApifyActor('apify~google-search-scraper', {
            queries: keyword,
            maxPagesPerQuery: 1,
            resultsPerPage: Math.min(maxResults, 50),
            countryCode: region === 'all' ? 'us' : region,
            languageCode: 'en'
          });
          
          if (items[0]?.organicResults) {
            // Limit results to maxResults
            const limitedResults = items[0].organicResults.slice(0, maxResults);
            for (const result of limitedResults) {
              const lead = {
                name: extractName(result.title),
                email: extractEmail(result.description || ''),
                phone: '',
                source: 'Google',
                query: keyword,
                title: result.title,
                url: result.url,
                snippet: result.description || '',
                extractedAt: new Date().toISOString()
              };
              
              if (!lead.email || !seenEmails.has(lead.email.toLowerCase())) {
                if (lead.email) seenEmails.add(lead.email.toLowerCase());
                results.push(lead);
              }
            }
          }
        } catch (err) {
          console.log('Google error:', err.message);
        }
      }

      // Reddit (via Google - free)
      if (platforms.includes('reddit')) {
        console.log(`Searching Reddit via Google for: ${keyword}`);
        try {
          const items = await callApifyActor('apify~google-search-scraper', {
            queries: `site:reddit.com "${keyword}"`,
            maxPagesPerQuery: 1,
            resultsPerPage: Math.min(maxResults, 30),
            countryCode: region === 'all' ? 'us' : region,
            languageCode: 'en'
          });
          
          if (items[0]?.organicResults) {
            // Limit results to maxResults
            const limitedResults = items[0].organicResults.slice(0, maxResults);
            for (const result of limitedResults) {
              const lead = {
                name: extractName(result.title),
                email: extractEmail(result.description || ''),
                phone: '',
                source: 'Reddit',
                query: keyword,
                title: result.title,
                url: result.url,
                snippet: result.description || '',
                extractedAt: new Date().toISOString()
              };
              
              if (!lead.email || !seenEmails.has(lead.email.toLowerCase())) {
                if (lead.email) seenEmails.add(lead.email.toLowerCase());
                results.push(lead);
              }
            }
          }
        } catch (err) {
          console.log('Reddit error:', err.message);
        }
      }

      // Upwork via Google
      if (platforms.includes('upwork')) {
        console.log(`Searching Upwork via Google for: ${keyword}`);
        try {
          const items = await callApifyActor('apify~google-search-scraper', {
            queries: `site:upwork.com "${keyword}"`,
            maxPagesPerQuery: 1,
            resultsPerPage: Math.min(maxResults, 30),
            countryCode: region === 'all' ? 'us' : region,
            languageCode: 'en'
          });
          
          if (items[0]?.organicResults) {
            // Limit results to maxResults
            const limitedResults = items[0].organicResults.slice(0, maxResults);
            for (const result of limitedResults) {
              const lead = {
                name: extractName(result.title),
                email: extractEmail(result.description || ''),
                phone: '',
                source: 'Upwork',
                query: keyword,
                title: result.title,
                url: result.url,
                snippet: result.description || '',
                extractedAt: new Date().toISOString()
              };
              if (!lead.email || !seenEmails.has(lead.email.toLowerCase())) {
                if (lead.email) seenEmails.add(lead.email.toLowerCase());
                results.push(lead);
              }
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
    
    // Return ALL leads, not just ones with emails
    allLeads = results;
    
    // Count stats
    const withEmail = results.filter(l => l.email).length;
    const verified = results.filter(l => l.emailVerified).length;
    
    res.json({ 
      success: true, 
      count: results.length,
      withEmail: withEmail,
      verified: verified,
      leads: results,
      hunterCreditsUsed: hunterCreditsUsed
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
