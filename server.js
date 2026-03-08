/**
 * Lead Extractor - Web Server
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { ApifyClient } = require('apify-client');
const XLSX = require('xlsx');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const apifyClient = new ApifyClient({ token: process.env.APIFY_API_TOKEN });

// Store for leads and seen emails
let allLeads = [];
let seenEmails = new Set();
const dataPath = path.join(__dirname, 'data/seen_leads.json');

// Load seen leads
function loadSeenLeads() {
  try {
    if (fs.existsSync(dataPath)) {
      const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      seenEmails = new Set(data.emails || []);
    }
  } catch (err) {
    console.log('Starting fresh database');
  }
}

// Save seen leads
function saveSeenLeads() {
  const dir = path.dirname(dataPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify({ 
    emails: Array.from(seenEmails),
    lastUpdated: new Date().toISOString()
  }, null, 2));
}

loadSeenLeads();

// API: Get status
app.get('/api/status', async (req, res) => {
  try {
    const user = await apifyClient.user().get();
    res.json({ 
      connected: true, 
      user: user.username,
      plan: user.plan?.id || 'FREE'
    });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// API: Run extraction
app.post('/api/extract', async (req, res) => {
  const { keywords, platforms, maxResults = 20, region = 'us', timeframe = 'd' } = req.body;
  
  // Timeframe mapping for Google
  const timeMap = { 'd': 'qdr:d', 'w': 'qdr:w', 'm': 'qdr:m', 'all': '' };
  
  console.log('Starting extraction:', { keywords, platforms, maxResults });
  
  const results = [];
  
  try {
    for (const keyword of keywords) {
      // Google Search
      if (platforms.includes('google')) {
        console.log(`Searching Google for: ${keyword}`);
        const run = await apifyClient.actor('apify/google-search-scraper').call({
          queries: keyword,
          maxPagesPerQuery: 1,
          resultsPerPage: Math.min(maxResults, 100),
          countryCode: region === 'all' ? 'us' : region,
          languageCode: 'en',
          ...(timeMap[timeframe] && { customDataFunction: `return { tbs: '${timeMap[timeframe]}' };` })
        }, { waitSecs: 120 });
        
      // Upwork via Google
      if (platforms.includes('upwork')) {
        console.log(`Searching Upwork via Google for: ${keyword}`);
        const upworkRun = await apifyClient.actor('apify/google-search-scraper').call({
          queries: `site:upwork.com "${keyword}"`,
          maxPagesPerQuery: 1,
          resultsPerPage: Math.min(maxResults, 50),
          countryCode: region === 'all' ? 'us' : region,
          languageCode: 'en'
        }, { waitSecs: 120 });
        
        const { items: upworkItems } = await apifyClient.dataset(upworkRun.defaultDatasetId).listItems();
        if (upworkItems[0]?.organicResults) {
          for (const result of upworkItems[0].organicResults) {
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
      }

        const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
        
        if (items[0]?.organicResults) {
          for (const result of items[0].organicResults) {
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
      }

      // Reddit
      if (platforms.includes('reddit')) {
        console.log(`Searching Reddit for: ${keyword}`);
        try {
          const run = await apifyClient.actor('trudax/reddit-scraper').call({
            searches: [keyword],
            maxPostsPerSearch: Math.min(maxResults, 50),
            searchPosts: true,
            searchComments: false,
            sort: 'new'
          }, { waitSecs: 120 });

          const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
          
          for (const post of items) {
            const lead = {
              name: post.author || 'Unknown',
              email: extractEmail(post.body || post.title || ''),
              phone: '',
              source: 'Reddit',
              query: keyword,
              title: post.title,
              url: post.url || `https://reddit.com${post.permalink}`,
              snippet: (post.body || '').substring(0, 300),
              subreddit: post.subreddit,
              extractedAt: new Date().toISOString()
            };
            
            if (!lead.email || !seenEmails.has(lead.email.toLowerCase())) {
              if (lead.email) seenEmails.add(lead.email.toLowerCase());
              results.push(lead);
            }
          }
        } catch (err) {
          console.log('Reddit error:', err.message);
        }
      }

      // Facebook
      if (platforms.includes('facebook')) {
        console.log(`Searching Facebook for: ${keyword}`);
        try {
          const run = await apifyClient.actor('apify/facebook-posts-scraper').call({
            searchQueries: [keyword],
            maxPosts: Math.min(maxResults, 50)
          }, { waitSecs: 180 });

          const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
          
          for (const post of items) {
            const lead = {
              name: post.authorName || 'Unknown',
              email: extractEmail(post.text || ''),
              phone: extractPhone(post.text || ''),
              source: 'Facebook',
              query: keyword,
              title: (post.text || '').substring(0, 100),
              url: post.url,
              snippet: (post.text || '').substring(0, 300),
              extractedAt: new Date().toISOString()
            };
            
            if (!lead.email || !seenEmails.has(lead.email.toLowerCase())) {
              if (lead.email) seenEmails.add(lead.email.toLowerCase());
              results.push(lead);
            }
          }
        } catch (err) {
          console.log('Facebook error:', err.message);
        }
      }

      // Instagram
      if (platforms.includes('instagram')) {
        console.log(`Searching Instagram for: ${keyword}`);
        try {
          const run = await apifyClient.actor('apify/instagram-scraper').call({
            search: keyword,
            resultsLimit: Math.min(maxResults, 50)
          }, { waitSecs: 180 });

          const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
          
          for (const post of items) {
            const lead = {
              name: post.ownerUsername || 'Unknown',
              email: extractEmail(post.caption || ''),
              phone: '',
              source: 'Instagram',
              query: keyword,
              title: (post.caption || '').substring(0, 100),
              url: post.url,
              snippet: (post.caption || '').substring(0, 300),
              extractedAt: new Date().toISOString()
            };
            
            if (!lead.email || !seenEmails.has(lead.email.toLowerCase())) {
              if (lead.email) seenEmails.add(lead.email.toLowerCase());
              results.push(lead);
            }
          }
        } catch (err) {
          console.log('Instagram error:', err.message);
        }
      }

      // Twitter
      if (platforms.includes('twitter')) {
        console.log(`Searching Twitter for: ${keyword}`);
        try {
          const run = await apifyClient.actor('apidojo/tweet-scraper').call({
            searchTerms: [keyword],
            maxTweets: Math.min(maxResults, 50),
            sort: 'Latest'
          }, { waitSecs: 180 });

          const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
          
          for (const tweet of items) {
            const lead = {
              name: tweet.author?.name || tweet.user?.name || 'Unknown',
              email: extractEmail(tweet.text || ''),
              phone: '',
              source: 'Twitter',
              query: keyword,
              title: (tweet.text || '').substring(0, 100),
              url: tweet.url,
              snippet: tweet.text || '',
              extractedAt: new Date().toISOString()
            };
            
            if (!lead.email || !seenEmails.has(lead.email.toLowerCase())) {
              if (lead.email) seenEmails.add(lead.email.toLowerCase());
              results.push(lead);
            }
          }
        } catch (err) {
          console.log('Twitter error:', err.message);
        }
      }
    }

    saveSeenLeads();
    allLeads = results;
    
    res.json({ 
      success: true, 
      count: results.length,
      leads: results
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
